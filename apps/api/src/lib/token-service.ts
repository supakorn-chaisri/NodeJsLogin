import type { Prisma, PrismaClient, TokenPurpose } from '../generated/prisma/client.js';
import { createOpaqueToken, sha256 } from './crypto.js';

const expirationByPurpose: Record<TokenPurpose, number> = {
  INVITATION: 24 * 60 * 60 * 1000,
  PASSWORD_RESET: 60 * 60 * 1000,
  EMAIL_CHANGE: 60 * 60 * 1000,
};

export class TokenService {
  constructor(private readonly prisma: PrismaClient) {}

  async issue(
    userId: string,
    purpose: TokenPurpose,
    pendingEmail?: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = createOpaqueToken();
    const expiresAt = new Date(Date.now() + expirationByPurpose[purpose]);

    await this.prisma.$transaction(async (transaction) => {
      await transaction.oneTimeToken.deleteMany({
        where: { userId, purpose, usedAt: null },
      });
      await transaction.oneTimeToken.create({
        data: {
          userId,
          purpose,
          tokenHash: sha256(token),
          expiresAt,
          ...(pendingEmail === undefined ? {} : { pendingEmail }),
        },
      });
    });

    return { token, expiresAt };
  }

  async consume(
    token: string,
    purpose: TokenPurpose,
    userId?: string,
  ): Promise<{ id: string; userId: string; pendingEmail: string | null } | null> {
    return this.consumeWith(token, purpose, userId, async (_transaction, record) => record);
  }

  async consumeWith<T>(
    token: string,
    purpose: TokenPurpose,
    userId: string | undefined,
    action: (
      transaction: Prisma.TransactionClient,
      record: { id: string; userId: string; pendingEmail: string | null },
    ) => Promise<T>,
  ): Promise<T | null> {
    return this.prisma.$transaction(async (transaction) => {
      const record = await transaction.oneTimeToken.findUnique({
        where: { tokenHash: sha256(token) },
        select: { id: true, userId: true, pendingEmail: true },
      });

      if (!record || (userId && record.userId !== userId)) {
        return null;
      }

      const consumed = await transaction.oneTimeToken.updateMany({
        where: {
          id: record.id,
          purpose,
          usedAt: null,
          expiresAt: { gt: new Date() },
          ...(userId === undefined ? {} : { userId }),
        },
        data: { usedAt: new Date() },
      });

      if (consumed.count !== 1) {
        return null;
      }

      return action(transaction, record);
    });
  }
}
