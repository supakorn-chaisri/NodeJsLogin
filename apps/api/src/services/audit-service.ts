import type { PrismaClient } from '../generated/prisma/client.js';
import { hmacSha256 } from '../lib/crypto.js';
import { config } from '../config.js';

type AuditInput = {
  event: string;
  actorUserId?: string;
  targetUserId?: string;
  ip?: string;
  details?: Record<string, string | number | boolean | null>;
};

export class AuditService {
  constructor(private readonly prisma: PrismaClient) {}

  async record(input: AuditInput): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        event: input.event,
        ...(input.actorUserId === undefined ? {} : { actorUserId: input.actorUserId }),
        ...(input.targetUserId === undefined ? {} : { targetUserId: input.targetUserId }),
        ...(input.ip === undefined
          ? {}
          : { ipHash: hmacSha256(config.RATE_LIMIT_SECRET, input.ip) }),
        ...(input.details === undefined ? {} : { details: input.details }),
      },
    });
  }
}
