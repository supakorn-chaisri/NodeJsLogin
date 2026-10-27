import * as oidc from 'openid-client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient } from '../generated/prisma/client.js';
import { config } from '../config.js';
import { constantTimeEqual, sha256 } from '../lib/crypto.js';
import { HttpError } from '../lib/errors.js';

const transactionLifetimeMs = 5 * 60 * 1000;
const transactionLifetimeSeconds = transactionLifetimeMs / 1000;

export class GoogleOidcService {
  private clientConfiguration: Promise<oidc.Configuration> | undefined;

  constructor(private readonly prisma: PrismaClient) {}

  get isConfigured(): boolean {
    return Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
  }

  async begin(reply: FastifyReply): Promise<void> {
    const configuration = await this.configuration();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);

    await this.prisma.oAuthTransaction.deleteMany({
      where: { expiresAt: { lte: new Date() } },
    });
    await this.prisma.oAuthTransaction.create({
      data: {
        stateHash: sha256(state),
        nonce,
        codeVerifier,
        expiresAt: new Date(Date.now() + transactionLifetimeMs),
      },
    });
    reply.setCookie(config.OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: config.getSecureCookie(),
      sameSite: 'lax',
      path: '/',
      maxAge: transactionLifetimeSeconds,
    });

    const authorizationUrl = oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: config.GOOGLE_CALLBACK_URL,
      scope: 'openid email',
      response_type: 'code',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    reply.redirect(authorizationUrl.href);
  }

  async callback(
    request: FastifyRequest,
    reply: FastifyReply,
    currentUrl: URL,
  ): Promise<{ subject: string; email: string; emailVerified: boolean }> {
    const state = currentUrl.searchParams.get('state');
    const cookieState = request.cookies[config.OAUTH_STATE_COOKIE];
    reply.clearCookie(config.OAUTH_STATE_COOKIE, {
      httpOnly: true,
      secure: config.getSecureCookie(),
      sameSite: 'lax',
      path: '/',
    });
    if (!state || !cookieState || !constantTimeEqual(cookieState, state)) {
      throw new HttpError(400, 'OAUTH_STATE_INVALID', 'The sign-in request could not be verified.');
    }

    const transaction = await this.prisma.oAuthTransaction.findUnique({
      where: { stateHash: sha256(state) },
    });

    if (!transaction || transaction.expiresAt <= new Date()) {
      throw new HttpError(400, 'OAUTH_STATE_INVALID', 'The sign-in request could not be verified.');
    }

    const removed = await this.prisma.oAuthTransaction.deleteMany({
      where: { stateHash: transaction.stateHash, expiresAt: { gt: new Date() } },
    });
    if (removed.count !== 1) {
      throw new HttpError(400, 'OAUTH_STATE_INVALID', 'The sign-in request could not be verified.');
    }

    const configuration = await this.configuration();
    const tokens = await oidc.authorizationCodeGrant(configuration, currentUrl, {
      expectedState: state,
      expectedNonce: transaction.nonce,
      pkceCodeVerifier: transaction.codeVerifier,
      idTokenExpected: true,
    });
    const claims = tokens.claims();

    if (
      !claims ||
      typeof claims.sub !== 'string' ||
      typeof claims.email !== 'string' ||
      claims.email_verified !== true
    ) {
      throw new HttpError(401, 'GOOGLE_IDENTITY_UNVERIFIED', 'Google could not verify this account.');
    }

    return {
      subject: claims.sub,
      email: claims.email,
      emailVerified: true,
    };
  }

  private configuration(): Promise<oidc.Configuration> {
    if (!this.isConfigured) {
      throw new HttpError(503, 'GOOGLE_LOGIN_UNAVAILABLE', 'Google sign-in is not configured.');
    }

    this.clientConfiguration ??= oidc.discovery(
      new URL('https://accounts.google.com'),
      config.GOOGLE_CLIENT_ID!,
      config.GOOGLE_CLIENT_SECRET!,
    );

    return this.clientConfiguration;
  }
}
