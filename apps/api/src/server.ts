import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { prisma } from './db.js';
import { HttpError } from './lib/errors.js';
import { AuditService } from './services/audit-service.js';
import { AuthService } from './services/auth-service.js';
import { CsrfService } from './services/csrf-service.js';
import { createEmailWorker, EmailQueue } from './services/email-service.js';
import { GoogleOidcService } from './services/google-oidc-service.js';
import { RateLimitService } from './services/rate-limit-service.js';
import { SessionService } from './services/session-service.js';
import { registerRoutes } from './routes.js';
import { TokenService } from './lib/token-service.js';

export async function buildServer() {
  const app = Fastify({
    bodyLimit: 16 * 1024,
    logger: { level: config.NODE_ENV === 'production' ? 'info' : 'debug' },
    trustProxy: config.TRUST_PROXY,
  });
  const csrf = new CsrfService();
  const sessions = new SessionService(prisma);
  const limits = new RateLimitService(prisma);
  const tokens = new TokenService(prisma);
  const emailQueue = new EmailQueue(prisma);
  const emailWorker = createEmailWorker(prisma, tokens, app.log);
  const audit = new AuditService(prisma);

  await app.register(cookie);
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Account Authentication API',
        description: 'Authentication, account lifecycle, and administrator operations.',
        version: '0.1.0',
      },
      tags: [
        { name: 'Authentication', description: 'Sign-in and account self-service.' },
        { name: 'Administration', description: 'Administrator-only account operations.' },
      ],
    },
  });
  await app.register(swaggerUi, {
    routePrefix: '/api/docs',
    uiConfig: { deepLinking: false, docExpansion: 'list' },
    staticCSP: true,
  });

  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
    }

    if (
      request.url.startsWith('/api/') &&
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      !csrf.validate(request)
    ) {
      throw new HttpError(403, 'CSRF_INVALID', 'The request could not be verified.');
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (reply.sent) {
      return;
    }

    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }

    if (
      typeof error === 'object' &&
      error !== null &&
      'validation' in error &&
      error.validation
    ) {
      return reply.code(400).send({
        error: { code: 'INVALID_REQUEST', message: 'The request could not be validated.' },
      });
    }

    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      return reply.code(error.statusCode).send({
        error: { code: 'INVALID_REQUEST', message: 'The request could not be processed.' },
      });
    }

    request.log.error({ err: error }, 'Unhandled API error.');
    return reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.' },
    });
  });

  await registerRoutes(app, {
    prisma,
    csrf,
    sessions,
    auth: new AuthService(prisma, sessions, limits),
    tokens,
    emailQueue,
    oidc: new GoogleOidcService(prisma),
    limits,
    audit,
  });

  app.addHook('onClose', async () => {
    await emailWorker.stop();
    await prisma.$disconnect();
  });

  app.decorate('emailWorker', emailWorker);
  return app;
}

async function pruneExpiredData(): Promise<void> {
  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  await prisma.$transaction([
    prisma.auditEvent.deleteMany({ where: { createdAt: { lt: ninetyDaysAgo } } }),
    prisma.rateLimitCounter.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.oneTimeToken.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.oAuthTransaction.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.session.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: now } },
          { revokedAt: { lt: ninetyDaysAgo } },
        ],
      },
    }),
    prisma.emailJob.deleteMany({
      where: {
        status: { in: ['SENT', 'FAILED'] },
        updatedAt: { lt: thirtyDaysAgo },
      },
    }),
  ]);
}

async function main(): Promise<void> {
  await prisma.$connect();
  const app = await buildServer();
  const emailWorker = app.emailWorker;

  try {
    await pruneExpiredData();
    await emailWorker.verifyDelivery();
    emailWorker.start();
    const maintenanceTimer = setInterval(() => {
      void pruneExpiredData().catch((error: unknown) => {
        app.log.error({ err: error }, 'Expired authentication data cleanup failed.');
      });
    }, 60 * 60 * 1000);
    maintenanceTimer.unref();
    app.addHook('onClose', async () => clearInterval(maintenanceTimer));
    await app.listen({ host: '0.0.0.0', port: config.PORT });
  } catch (error) {
    await app.close();
    throw error;
  }

  let shutdownInProgress = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownInProgress) {
      return;
    }
    shutdownInProgress = true;
    app.log.info({ signal }, 'Shutting down API.');
    try {
      await app.close();
    } catch (error) {
      app.log.error({ err: error }, 'API shutdown failed.');
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

declare module 'fastify' {
  interface FastifyInstance {
    emailWorker: ReturnType<typeof createEmailWorker>;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error: unknown) => {
    console.error('API startup failed.', error);
    process.exitCode = 1;
  });
}
