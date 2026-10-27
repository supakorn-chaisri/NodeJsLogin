import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient } from '../generated/prisma/client.js';
import { config } from '../config.js';
import { createOpaqueToken, sha256 } from '../lib/crypto.js';

const absoluteLifetimeMs = 12 * 60 * 60 * 1000;
const idleLifetimeMs = 30 * 60 * 1000;

export type SessionUser = {
  id: string;
  email: string;
  role: 'USER' | 'ADMIN';
};

export type AuthContext = {
  user: SessionUser;
  sessionId: string;
};

export class SessionService {
  constructor(private readonly prisma: PrismaClient) {}

  async create(userId: string, reply: FastifyReply): Promise<void> {
    const rawToken = createOpaqueToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + absoluteLifetimeMs);

    await this.prisma.session.create({
      data: {
        id: sha256(rawToken),
        userId,
        createdAt: now,
        authenticatedAt: now,
        lastActivityAt: now,
        expiresAt,
      },
    });

    reply.setCookie(config.SESSION_COOKIE, rawToken, {
      httpOnly: true,
      secure: config.getSecureCookie(),
      sameSite: 'lax',
      path: '/',
      maxAge: absoluteLifetimeMs / 1000,
    });
  }

  async resolve(request: FastifyRequest, reply: FastifyReply): Promise<AuthContext | null> {
    const rawToken = request.cookies[config.SESSION_COOKIE];

    if (!rawToken) {
      return null;
    }

    const sessionId = sha256(rawToken);
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { user: { select: { id: true, email: true, role: true, status: true } } },
    });

    const now = new Date();
    const isIdle = session
      ? now.getTime() - session.lastActivityAt.getTime() >= idleLifetimeMs
      : true;

    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= now ||
      isIdle ||
      session.user.status !== 'ACTIVE'
    ) {
      if (session && !session.revokedAt) {
        await this.prisma.session.update({
          where: { id: session.id },
          data: { revokedAt: now },
        });
      }
      this.clear(reply);
      return null;
    }

    await this.prisma.session.update({
      where: { id: session.id },
      data: { lastActivityAt: now },
    });

    return {
      user: {
        id: session.user.id,
        email: session.user.email,
        role: session.user.role,
      },
      sessionId: session.id,
    };
  }

  clear(reply: FastifyReply): void {
    reply.clearCookie(config.SESSION_COOKIE, {
      httpOnly: true,
      secure: config.getSecureCookie(),
      sameSite: 'lax',
      path: '/',
    });
  }

  async revokeAll(userId: string, exceptSessionId?: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId === undefined ? {} : { id: { not: exceptSessionId } }),
      },
      data: { revokedAt: new Date() },
    });
  }
}
