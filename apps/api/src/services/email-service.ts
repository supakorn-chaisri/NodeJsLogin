import { createTransport, type Transporter } from 'nodemailer';
import type { FastifyBaseLogger } from 'fastify';
import type { EmailJobKind, Prisma, PrismaClient } from '../generated/prisma/client.js';
import { config } from '../config.js';
import { TokenService } from '../lib/token-service.js';

type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

class SmtpEmailAdapter {
  private readonly transporter: Transporter;

  constructor() {
    this.transporter = createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      ...(config.SMTP_USER
        ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD ?? '' } }
        : {}),
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: config.SMTP_FROM,
      ...message,
    });
  }

  async verify(): Promise<void> {
    await this.transporter.verify();
  }

  async close(): Promise<void> {
    this.transporter.close();
  }
}

export class EmailQueue {
  constructor(private readonly prisma: PrismaClient) {}

  async enqueue(
    userId: string,
    kind: EmailJobKind,
    transaction?: Prisma.TransactionClient,
  ): Promise<void> {
    const enqueueInTransaction = async (tx: Prisma.TransactionClient) => {
      await tx.emailJob.deleteMany({ where: { userId, kind, status: 'PENDING' } });
      await tx.emailJob.create({ data: { userId, kind } });
    };

    if (transaction) {
      await enqueueInTransaction(transaction);
      return;
    }

    await this.prisma.$transaction(enqueueInTransaction);
  }
}

export class EmailWorker {
  private readonly adapter = new SmtpEmailAdapter();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly tokens: TokenService,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async verifyDelivery(): Promise<void> {
    await this.adapter.verify();
  }

  start(): void {
    if (this.timer) {
      throw new Error('Email worker is already running.');
    }

    this.timer = setInterval(() => {
      void this.processNext().catch((error: unknown) => {
        this.logger.error({ err: error }, 'Email worker failed to process its queue.');
      });
    }, 1_000);
    this.timer.unref();
    void this.processNext().catch((error: unknown) => {
      this.logger.error({ err: error }, 'Email worker failed to process its queue.');
    });
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.adapter.close();
  }

  private async processNext(): Promise<void> {
    const jobs = await this.prisma.$queryRaw<
      Array<{ id: string; userId: string; kind: EmailJobKind; attempts: number }>
    >`
      WITH candidate AS (
        SELECT "id"
        FROM "EmailJob"
        WHERE ("status" = 'PENDING' AND "availableAt" <= NOW())
          OR ("status" = 'PROCESSING' AND "lockedAt" <= NOW() - INTERVAL '5 minutes')
        ORDER BY "createdAt"
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "EmailJob" AS job
      SET "status" = 'PROCESSING',
          "lockedAt" = NOW(),
          "attempts" = job."attempts" + 1
      FROM candidate
      WHERE job."id" = candidate."id"
      RETURNING job."id", job."userId", job."kind", job."attempts"
    `;
    const job = jobs[0];

    if (!job) {
      return;
    }

    try {
      await this.deliver(job.userId, job.kind);
      await this.prisma.emailJob.update({
        where: { id: job.id },
        data: { status: 'SENT', lockedAt: null, lastError: null },
      });
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      const failedPermanently = job.attempts >= 5;
      const delayMs = Math.min(60 * 60 * 1000, 1_000 * 2 ** job.attempts);

      this.logger.error(
        { err: error, jobId: job.id, attempt: job.attempts },
        'Email delivery attempt failed.',
      );

      await this.prisma.emailJob.update({
        where: { id: job.id },
        data: {
          status: failedPermanently ? 'FAILED' : 'PENDING',
          lockedAt: null,
          lastError: errorName,
          availableAt: new Date(Date.now() + delayMs),
        },
      });
    }
  }

  private async deliver(userId: string, kind: EmailJobKind): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, pendingEmail: true, status: true },
    });

    if (!user || user.status === 'DISABLED') {
      throw new Error('The account is no longer eligible for email delivery.');
    }

    const purpose = this.purposeFor(kind);
    const targetEmail = kind === 'EMAIL_CHANGE' ? user.pendingEmail : user.email;

    if (!targetEmail || (kind !== 'INVITATION' && user.status !== 'ACTIVE')) {
      throw new Error('The account is not eligible for this email.');
    }

    const { token } = await this.tokens.issue(
      user.id,
      purpose,
      kind === 'EMAIL_CHANGE' ? targetEmail : undefined,
    );
    const route = kind === 'INVITATION' ? '/invite' : kind === 'PASSWORD_RESET' ? '/reset-password' : '/confirm-email-change';
    const link = new URL(route, config.APP_ORIGIN);
    link.searchParams.set('token', token);

    await this.adapter.send(this.messageFor(kind, targetEmail, link.toString()));
  }

  private purposeFor(kind: EmailJobKind): 'INVITATION' | 'PASSWORD_RESET' | 'EMAIL_CHANGE' {
    switch (kind) {
      case 'INVITATION':
        return 'INVITATION';
      case 'PASSWORD_RESET':
        return 'PASSWORD_RESET';
      case 'EMAIL_CHANGE':
        return 'EMAIL_CHANGE';
      default: {
        const exhaustive: never = kind;
        throw new Error(`Unsupported email job kind: ${exhaustive}`);
      }
    }
  }

  private messageFor(kind: EmailJobKind, to: string, link: string): MailMessage {
    const messages: Record<EmailJobKind, { subject: string; en: string; th: string }> = {
      INVITATION: {
        subject: 'Your Account invitation / คำเชิญเข้าใช้งาน Account',
        en: 'You have been invited to use Account. Set a password to activate your account.',
        th: 'คุณได้รับคำเชิญให้ใช้งาน Account ตั้งรหัสผ่านเพื่อเปิดใช้งานบัญชี',
      },
      PASSWORD_RESET: {
        subject: 'Reset your Account password / รีเซ็ตรหัสผ่าน Account',
        en: 'Use this one-time link to reset your password.',
        th: 'ใช้ลิงก์ครั้งเดียวนี้เพื่อรีเซ็ตรหัสผ่าน',
      },
      EMAIL_CHANGE: {
        subject: 'Confirm your new email / ยืนยันอีเมลใหม่',
        en: 'Confirm this email address to finish changing your Account email.',
        th: 'ยืนยันอีเมลนี้เพื่อเปลี่ยนอีเมลของบัญชี Account ให้เสร็จสมบูรณ์',
      },
    };
    const copy = messages[kind];

    return {
      to,
      subject: copy.subject,
      text: `${copy.en}\n\n${copy.th}\n\n${link}\n\nIf you did not request this, you can ignore this message.`,
      html: `<p>${copy.en}</p><p>${copy.th}</p><p><a href="${link}">Continue / ดำเนินการต่อ</a></p><p>If you did not request this, you can ignore this message.</p>`,
    };
  }
}

export function createEmailWorker(
  prisma: PrismaClient,
  tokens: TokenService,
  logger: FastifyBaseLogger,
): EmailWorker {
  return new EmailWorker(prisma, tokens, logger);
}
