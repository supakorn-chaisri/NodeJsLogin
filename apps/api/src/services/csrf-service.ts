import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { constantTimeEqual, createOpaqueToken, hmacSha256 } from '../lib/crypto.js';

const tokenLifetimeSeconds = 12 * 60 * 60;

export class CsrfService {
  issue(reply: FastifyReply): { token: string } {
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = `${issuedAt}.${createOpaqueToken()}`;
    const signature = hmacSha256(config.CSRF_SECRET, token);

    reply.setCookie(config.CSRF_COOKIE, `${token}.${signature}`, {
      httpOnly: false,
      secure: config.getSecureCookie(),
      sameSite: 'lax',
      path: '/',
      maxAge: tokenLifetimeSeconds,
    });

    return { token };
  }

  validate(request: FastifyRequest): boolean {
    const origin = request.headers.origin;
    const referer = request.headers.referer;
    let refererOrigin: string | null = null;
    if (referer) {
      try {
        refererOrigin = new URL(referer).origin;
      } catch {
        refererOrigin = null;
      }
    }
    const requestOrigin = origin ?? refererOrigin;

    if (requestOrigin !== config.APP_ORIGIN) {
      return false;
    }

    const cookieValue = request.cookies[config.CSRF_COOKIE];
    const headerValue = request.headers['x-csrf-token'];

    if (!cookieValue || typeof headerValue !== 'string') {
      return false;
    }

    const parts = cookieValue.split('.');
    if (parts.length !== 3) {
      return false;
    }

    const [issuedAt, randomPart, signature] = parts;
    if (!issuedAt || !randomPart || !signature) {
      return false;
    }

    const token = `${issuedAt}.${randomPart}`;
    const issuedAtSeconds = Number(issuedAt);
    const nowSeconds = Math.floor(Date.now() / 1000);

    if (
      !Number.isSafeInteger(issuedAtSeconds) ||
      issuedAtSeconds > nowSeconds ||
      nowSeconds - issuedAtSeconds > tokenLifetimeSeconds ||
      !constantTimeEqual(headerValue, token)
    ) {
      return false;
    }

    return constantTimeEqual(signature, hmacSha256(config.CSRF_SECRET, token));
  }
}
