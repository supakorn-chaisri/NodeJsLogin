import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient } from './generated/prisma/client.js';
import { z } from 'zod';
import { config } from './config.js';
import { normalizeEmail, sha256 } from './lib/crypto.js';
import { HttpError } from './lib/errors.js';
import { hashPassword, validatePassword } from './lib/passwords.js';
import type { AuditService } from './services/audit-service.js';
import type { AuthService } from './services/auth-service.js';
import type { CsrfService } from './services/csrf-service.js';
import type { EmailQueue } from './services/email-service.js';
import type { GoogleOidcService } from './services/google-oidc-service.js';
import type { RateLimitService } from './services/rate-limit-service.js';
import type { SessionService } from './services/session-service.js';
import { TokenService } from './lib/token-service.js';

const emailSchema = {
  type: 'string',
  format: 'email',
  maxLength: 320,
} as const;
const tokenSchema = { type: 'string', minLength: 32, maxLength: 128 } as const;
const passwordSchema = { type: 'string', minLength: 1, maxLength: 1024 } as const;
const userIdParamsSchema = z.object({ userId: z.string().uuid() });
const userIdParamsJsonSchema = {
  type: 'object',
  properties: { userId: { type: 'string', format: 'uuid' } },
  required: ['userId'],
} as const;
const successSchema = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
} as const;
const genericResetMessage = 'If that account can receive a reset email, a link will be sent.';
const genericResetMessageThai = 'หากบัญชีนี้สามารถรับอีเมลรีเซ็ตรหัสผ่านได้ ระบบจะส่งลิงก์ให้';

type RouteServices = {
  prisma: PrismaClient;
  csrf: CsrfService;
  sessions: SessionService;
  auth: AuthService;
  tokens: TokenService;
  emailQueue: EmailQueue;
  oidc: GoogleOidcService;
  limits: RateLimitService;
  audit: AuditService;
};

function parseBody<T>(request: FastifyRequest, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    throw new HttpError(400, 'INVALID_REQUEST', 'The request could not be validated.');
  }
  return parsed.data;
}

function parseParams<T>(request: FastifyRequest, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(request.params);
  if (!parsed.success) {
    throw new HttpError(400, 'INVALID_REQUEST', 'The request could not be validated.');
  }
  return parsed.data;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}

function isSerializationConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2034'
  );
}

async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  sessions: SessionService,
): Promise<NonNullable<Awaited<ReturnType<SessionService['resolve']>>>> {
  const auth = await sessions.resolve(request, reply);
  if (!auth) {
    throw new HttpError(401, 'AUTHENTICATION_REQUIRED', 'Sign in to continue.');
  }
  return auth;
}

function assertAdmin(
  auth: NonNullable<Awaited<ReturnType<SessionService['resolve']>>>,
): void {
  if (auth.user.role !== 'ADMIN') {
    throw new HttpError(403, 'ADMIN_REQUIRED', 'Administrator access is required.');
  }
}

function requestIp(request: FastifyRequest): string {
  return request.ip;
}

function shouldThrottle(
  ipCount: number,
  accountCount: number,
  ipLimit: number,
  accountLimit: number,
): boolean {
  return ipCount >= ipLimit || accountCount >= accountLimit;
}

export async function registerRoutes(
  app: FastifyInstance,
  services: RouteServices,
): Promise<void> {
  const {
    prisma,
    csrf,
    sessions,
    auth,
    tokens,
    emailQueue,
    oidc,
    limits,
    audit,
  } = services;

  app.get('/api/health', async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'ok' };
  });

  app.get('/api/meta', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return {
      csrf: csrf.issue(reply),
      googleConfigured: oidc.isConfigured,
    };
  });

  app.get('/api/docs/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  app.post(
    '/api/auth/login',
    {
      schema: {
        tags: ['Authentication'],
        body: {
          type: 'object',
          properties: { email: emailSchema, password: passwordSchema },
          required: ['email', 'password'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { email, password } = parseBody(
        request,
        z.object({
          email: z.string().email().max(320),
          password: z.string().min(1).max(1024),
        }),
      );
      const userId = await auth.authenticate(email, password, requestIp(request));
      await sessions.create(userId, reply);
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { id: true, email: true },
      });
      await audit.record({
        event: 'auth.login.success',
        actorUserId: userId,
        targetUserId: userId,
        ip: requestIp(request),
      });
      return { ok: true, user };
    },
  );

  app.post(
    '/api/auth/logout',
    { schema: { tags: ['Authentication'], response: { 200: successSchema } } },
    async (request, reply) => {
      const current = await sessions.resolve(request, reply);
      if (current) {
        await prisma.session.update({
          where: { id: current.sessionId },
          data: { revokedAt: new Date() },
        });
        await audit.record({
          event: 'auth.logout',
          actorUserId: current.user.id,
          targetUserId: current.user.id,
          ip: requestIp(request),
        });
      }
      sessions.clear(reply);
      return { ok: true };
    },
  );

  app.get('/api/auth/me', { schema: { tags: ['Authentication'] } }, async (request, reply) => {
    const current = await sessions.resolve(request, reply);
    return { user: current?.user ?? null };
  });

  app.post(
    '/api/auth/logout-others',
    { schema: { tags: ['Authentication'], response: { 200: successSchema } } },
    async (request, reply) => {
      const current = await requireAuth(request, reply, sessions);
      await sessions.revokeAll(current.user.id, current.sessionId);
      await audit.record({
        event: 'auth.sessions.revoke_others',
        actorUserId: current.user.id,
        targetUserId: current.user.id,
        ip: requestIp(request),
      });
      return { ok: true };
    },
  );

  app.post(
    '/api/auth/forgot-password',
    {
      schema: {
        tags: ['Authentication'],
        body: {
          type: 'object',
          properties: { email: emailSchema },
          required: ['email'],
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const { email } = parseBody(
        request,
        z.object({
          email: z.string().email().max(320),
        }),
      );
      const normalizedEmail = normalizeEmail(email);
      const ip = requestIp(request);
      const [ipCount, accountCount] = await Promise.all([
        limits.hit('reset-ip', ip, 60 * 60 * 1000),
        limits.hit('reset-account', normalizedEmail, 60 * 60 * 1000),
      ]);

      if (!shouldThrottle(ipCount - 1, accountCount - 1, 20, 3)) {
        const user = await prisma.user.findUnique({
          where: { email: normalizedEmail },
          select: { id: true, status: true },
        });
        if (user?.status === 'ACTIVE') {
          await emailQueue.enqueue(user.id, 'PASSWORD_RESET');
          await audit.record({
            event: 'auth.password_reset.requested',
            targetUserId: user.id,
            ip,
          });
        }
      }

      return { ok: true, message: `${genericResetMessage} ${genericResetMessageThai}` };
    },
  );

  app.post(
    '/api/auth/reset-password',
    {
      schema: {
        tags: ['Authentication'],
        body: {
          type: 'object',
          properties: { token: tokenSchema, password: passwordSchema },
          required: ['token', 'password'],
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const { token, password } = parseBody(
        request,
        z.object({
          token: z.string().min(32).max(128),
          password: z.string().min(1).max(1024),
        }),
      );
      const passwordError = validatePassword(password);
      if (passwordError) {
        throw new HttpError(400, passwordError, 'Choose a longer password that is not commonly used.');
      }
      const passwordHash = await hashPassword(password);
      const result = await tokens.consumeWith(
        token,
        'PASSWORD_RESET',
        undefined,
        async (transaction, record) => {
          const updated = await transaction.user.updateMany({
            where: { id: record.userId, status: 'ACTIVE' },
            data: { passwordHash },
          });
          if (updated.count !== 1) {
            return null;
          }
          await transaction.session.updateMany({
            where: { userId: record.userId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          return record.userId;
        },
      );

      if (!result) {
        throw new HttpError(400, 'TOKEN_INVALID', 'This link is invalid or has expired.');
      }
      await audit.record({
        event: 'auth.password_reset.completed',
        actorUserId: result,
        targetUserId: result,
      });
      return { ok: true };
    },
  );

  app.post(
    '/api/auth/accept-invitation',
    {
      schema: {
        tags: ['Authentication'],
        body: {
          type: 'object',
          properties: { token: tokenSchema, password: passwordSchema },
          required: ['token', 'password'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { token, password } = parseBody(
        request,
        z.object({
          token: z.string().min(32).max(128),
          password: z.string().min(1).max(1024),
        }),
      );
      const passwordError = validatePassword(password);
      if (passwordError) {
        throw new HttpError(400, passwordError, 'Choose a longer password that is not commonly used.');
      }
      const passwordHash = await hashPassword(password);
      const result = await tokens.consumeWith(
        token,
        'INVITATION',
        undefined,
        async (transaction, record) => {
          const activated = await transaction.user.updateMany({
            where: { id: record.userId, status: 'INVITED' },
            data: { passwordHash, status: 'ACTIVE', emailVerifiedAt: new Date() },
          });
          return activated.count === 1 ? record.userId : null;
        },
      );

      if (!result) {
        throw new HttpError(400, 'TOKEN_INVALID', 'This invitation is invalid or has expired.');
      }
      await sessions.create(result, reply);
      await audit.record({
        event: 'auth.invitation.accepted',
        actorUserId: result,
        targetUserId: result,
        ip: requestIp(request),
      });
      return { ok: true };
    },
  );

  app.post(
    '/api/auth/change-email',
    {
      schema: {
        tags: ['Authentication'],
        body: {
          type: 'object',
          properties: { email: emailSchema },
          required: ['email'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const current = await requireAuth(request, reply, sessions);
      const { email } = parseBody(
        request,
        z.object({
          email: z.string().email().max(320),
        }),
      );
      const pendingEmail = normalizeEmail(email);
      if (pendingEmail === current.user.email) {
        throw new HttpError(400, 'EMAIL_UNCHANGED', 'The new email is the same as the current email.');
      }
      try {
        await prisma.$transaction(async (transaction) => {
          await transaction.user.update({
            where: { id: current.user.id },
            data: { pendingEmail },
          });
          await transaction.oneTimeToken.updateMany({
            where: {
              userId: current.user.id,
              purpose: 'EMAIL_CHANGE',
              usedAt: null,
            },
            data: { usedAt: new Date() },
          });
          await emailQueue.enqueue(current.user.id, 'EMAIL_CHANGE', transaction);
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new HttpError(409, 'EMAIL_UNAVAILABLE', 'That email address cannot be used.');
        }
        throw error;
      }
      await audit.record({
        event: 'auth.email_change.requested',
        actorUserId: current.user.id,
        targetUserId: current.user.id,
        ip: requestIp(request),
      });
      return { ok: true };
    },
  );

  app.post(
    '/api/auth/confirm-email-change',
    {
      schema: {
        tags: ['Authentication'],
        body: {
          type: 'object',
          properties: { token: tokenSchema },
          required: ['token'],
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const { token } = parseBody(
        request,
        z.object({
          token: z.string().min(32).max(128),
        }),
      );
      let result: string | null;
      try {
        result = await tokens.consumeWith(
          token,
          'EMAIL_CHANGE',
          undefined,
          async (transaction, record) => {
            const userBeforeChange = await transaction.user.findUnique({
              where: { id: record.userId },
              select: { pendingEmail: true, status: true },
            });
            if (
              !record.pendingEmail ||
              userBeforeChange?.pendingEmail !== record.pendingEmail ||
              userBeforeChange.status !== 'ACTIVE'
            ) {
              return null;
            }
            const user = await transaction.user.update({
              where: { id: record.userId },
              data: {
                email: record.pendingEmail,
                pendingEmail: null,
                emailVerifiedAt: new Date(),
              },
              select: { id: true },
            });
            await transaction.session.updateMany({
              where: { userId: user.id, revokedAt: null },
              data: { revokedAt: new Date() },
            });
            return user.id;
          },
        );
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new HttpError(409, 'EMAIL_UNAVAILABLE', 'That email address cannot be used.');
        }
        throw error;
      }
      if (!result) {
        throw new HttpError(400, 'TOKEN_INVALID', 'This link is invalid or has expired.');
      }
      await audit.record({
        event: 'auth.email_change.completed',
        actorUserId: result,
        targetUserId: result,
      });
      return { ok: true };
    },
  );

  app.get(
    '/api/auth/google',
    { schema: { tags: ['Authentication'] } },
    async (_request, reply) => oidc.begin(reply),
  );

  app.get(
    '/api/auth/google/callback',
    { schema: { tags: ['Authentication'] } },
    async (request, reply) => {
      let identity: Awaited<ReturnType<GoogleOidcService['callback']>>;
      try {
        identity = await oidc.callback(request, reply, new URL(request.url, config.APP_ORIGIN));
      } catch (error) {
        request.log.warn({ err: error }, 'Google sign-in callback was rejected.');
        return reply.redirect('/?error=google_login_failed');
      }

      const email = normalizeEmail(identity.email);
      const existingIdentity = await prisma.identity.findUnique({
        where: { provider_subject: { provider: 'google', subject: identity.subject } },
        include: { user: { select: { id: true, status: true } } },
      });
      let userId: string | null = null;

      if (existingIdentity?.user.status === 'ACTIVE') {
        userId = existingIdentity.user.id;
      } else if (!existingIdentity) {
        const user = await prisma.user.findUnique({
          where: { email },
          select: { id: true, status: true, emailVerifiedAt: true },
        });
        if (user?.status === 'ACTIVE' && user.emailVerifiedAt) {
          try {
            await prisma.identity.create({
              data: { provider: 'google', subject: identity.subject, userId: user.id },
            });
            userId = user.id;
          } catch (error) {
            if (!isUniqueConstraintError(error)) {
              throw error;
            }
            const linkedIdentity = await prisma.identity.findUnique({
              where: { provider_subject: { provider: 'google', subject: identity.subject } },
              include: { user: { select: { id: true, status: true } } },
            });
            if (linkedIdentity?.user.status === 'ACTIVE') {
              userId = linkedIdentity.user.id;
            }
          }
        }
      }

      if (!userId) {
        await audit.record({
          event: 'auth.google.login.denied',
          ip: requestIp(request),
        });
        return reply.redirect('/?error=google_login_unavailable');
      }

      await sessions.create(userId, reply);
      await audit.record({
        event: 'auth.google.login.success',
        actorUserId: userId,
        targetUserId: userId,
        ip: requestIp(request),
      });
      return reply.redirect('/');
    },
  );

  app.post(
    '/api/admin/users',
    {
      schema: {
        tags: ['Administration'],
        body: {
          type: 'object',
          properties: { email: emailSchema },
          required: ['email'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const current = await requireAuth(request, reply, sessions);
      assertAdmin(current);
      const { email } = await parseBody(
        request,
        z.object({
          email: z.string().email().max(320),
        }),
      );
      const normalizedEmail = normalizeEmail(email);
      try {
        const user = await prisma.$transaction(async (transaction) => {
          const createdUser = await transaction.user.create({
            data: { email: normalizedEmail, status: 'INVITED' },
            select: { id: true, email: true, status: true },
          });
          await emailQueue.enqueue(createdUser.id, 'INVITATION', transaction);
          return createdUser;
        });
        await audit.record({
          event: 'admin.user.invited',
          actorUserId: current.user.id,
          targetUserId: user.id,
          ip: requestIp(request),
        });
        return reply.code(201).send({ ok: true, user });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new HttpError(409, 'EMAIL_UNAVAILABLE', 'That email address cannot be used.');
        }
        throw error;
      }
    },
  );

  app.post(
    '/api/admin/users/:userId/invite',
    {
      schema: {
        tags: ['Administration'],
        params: userIdParamsJsonSchema,
        response: { 200: successSchema },
      },
    },
    async (request, reply) => {
      const current = await requireAuth(request, reply, sessions);
      assertAdmin(current);
      const { userId } = parseParams(request, userIdParamsSchema);
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user || user.status !== 'INVITED') {
        throw new HttpError(404, 'INVITATION_UNAVAILABLE', 'An invitation cannot be sent for this account.');
      }
      await emailQueue.enqueue(user.id, 'INVITATION');
      await audit.record({
        event: 'admin.user.invitation_resent',
        actorUserId: current.user.id,
        targetUserId: user.id,
        ip: requestIp(request),
      });
      return { ok: true };
    },
  );

  app.patch(
    '/api/admin/users/:userId/status',
    {
      schema: {
        tags: ['Administration'],
        params: userIdParamsJsonSchema,
        body: {
          type: 'object',
          properties: { status: { type: 'string', enum: ['ACTIVE', 'DISABLED'] } },
          required: ['status'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const current = await requireAuth(request, reply, sessions);
      assertAdmin(current);
      const { userId } = parseParams(request, userIdParamsSchema);
      const { status } = parseBody(
        request,
        z.object({
          status: z.enum(['ACTIVE', 'DISABLED']),
        }),
      );
      if (current.user.id === userId && status === 'DISABLED') {
        throw new HttpError(400, 'CANNOT_DISABLE_SELF', 'Administrators cannot disable their own account.');
      }
      let user: { id: string; status: 'INVITED' | 'ACTIVE' | 'DISABLED' };
      try {
        user = await prisma.$transaction(async (transaction) => {
          const existingUser = await transaction.user.findUnique({
            where: { id: userId },
            select: { id: true, status: true, role: true, passwordHash: true },
          });
          if (!existingUser) {
            throw new HttpError(404, 'USER_NOT_FOUND', 'The account was not found.');
          }
          if (status === 'ACTIVE' && (existingUser.status === 'INVITED' || !existingUser.passwordHash)) {
            throw new HttpError(409, 'INVITATION_REQUIRED', 'An invited account must accept its invitation first.');
          }
          if (
            status === 'DISABLED' &&
            existingUser.role === 'ADMIN' &&
            existingUser.status === 'ACTIVE'
          ) {
            const activeAdministrators = await transaction.user.count({
              where: { role: 'ADMIN', status: 'ACTIVE' },
            });
            if (activeAdministrators <= 1) {
              throw new HttpError(409, 'LAST_ADMIN_REQUIRED', 'At least one active administrator must remain.');
            }
          }
          const updated = await transaction.user.updateMany({
            where: { id: userId, status: existingUser.status },
            data: { status },
          });
          if (updated.count !== 1) {
            throw new HttpError(409, 'ACCOUNT_CHANGED', 'The account changed before this request completed.');
          }
          if (status === 'DISABLED') {
            await transaction.session.updateMany({
              where: { userId, revokedAt: null },
              data: { revokedAt: new Date() },
            });
          }
          return transaction.user.findUniqueOrThrow({
            where: { id: userId },
            select: { id: true, status: true },
          });
        }, { isolationLevel: 'Serializable' });
      } catch (error) {
        if (isSerializationConflict(error)) {
          throw new HttpError(409, 'ACCOUNT_CHANGED', 'The account changed before this request completed.');
        }
        throw error;
      }
      await audit.record({
        event: `admin.user.${status === 'DISABLED' ? 'disabled' : 'enabled'}`,
        actorUserId: current.user.id,
        targetUserId: user.id,
        ip: requestIp(request),
      });
      return { ok: true, user };
    },
  );

  app.post(
    '/api/admin/users/:userId/revoke-sessions',
    {
      schema: {
        tags: ['Administration'],
        params: userIdParamsJsonSchema,
        response: { 200: successSchema },
      },
    },
    async (request, reply) => {
      const current = await requireAuth(request, reply, sessions);
      assertAdmin(current);
      const { userId } = parseParams(request, userIdParamsSchema);
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!user) {
        throw new HttpError(404, 'USER_NOT_FOUND', 'The account was not found.');
      }
      await sessions.revokeAll(user.id);
      await audit.record({
        event: 'admin.user.sessions_revoked',
        actorUserId: current.user.id,
        targetUserId: user.id,
        ip: requestIp(request),
      });
      return { ok: true };
    },
  );

  app.get(
    '/api/admin/users',
    { schema: { tags: ['Administration'] } },
    async (request, reply) => {
      const current = await requireAuth(request, reply, sessions);
      assertAdmin(current);
      const users = await prisma.user.findMany({
        select: { id: true, email: true, role: true, status: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      return { users };
    },
  );

  app.get(
    '/api/admin/audit',
    { schema: { tags: ['Administration'] } },
    async (request, reply) => {
      const current = await requireAuth(request, reply, sessions);
      assertAdmin(current);
      const events = await prisma.auditEvent.findMany({
        where: { createdAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      return { events };
    },
  );
}
