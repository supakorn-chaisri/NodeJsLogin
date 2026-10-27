import type { PrismaClient } from '../generated/prisma/client.js';
import { config } from '../config.js';
import { hmacSha256 } from '../lib/crypto.js';

export class RateLimitService {
  constructor(private readonly prisma: PrismaClient) {}

  async count(bucket: string, subject: string, windowMs: number): Promise<number> {
    const key = this.key(bucket, subject, windowMs);
    const counter = await this.prisma.rateLimitCounter.findUnique({
      where: { key },
      select: { count: true },
    });

    return counter?.count ?? 0;
  }

  async hit(bucket: string, subject: string, windowMs: number): Promise<number> {
    const now = Date.now();
    const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
    const expiresAt = new Date(windowStart.getTime() + windowMs);
    const key = this.key(bucket, subject, windowMs, windowStart.getTime());

    await this.prisma.$executeRaw`
      INSERT INTO "RateLimitCounter" ("key", "count", "windowStart", "expiresAt")
      VALUES (${key}, 1, ${windowStart}, ${expiresAt})
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE
          WHEN "RateLimitCounter"."windowStart" = ${windowStart}
          THEN "RateLimitCounter"."count" + 1
          ELSE 1
        END,
        "windowStart" = ${windowStart},
        "expiresAt" = ${expiresAt}
    `;

    return this.countForKey(key);
  }

  async clear(bucket: string, subject: string, windowMs: number): Promise<void> {
    await this.prisma.rateLimitCounter.deleteMany({
      where: { key: this.key(bucket, subject, windowMs) },
    });
  }

  private key(
    bucket: string,
    subject: string,
    windowMs: number,
    windowStart = Math.floor(Date.now() / windowMs) * windowMs,
  ): string {
    return hmacSha256(config.RATE_LIMIT_SECRET, `${bucket}:${subject}:${windowStart}`);
  }

  private async countForKey(key: string): Promise<number> {
    const counter = await this.prisma.rateLimitCounter.findUnique({
      where: { key },
      select: { count: true },
    });
    return counter?.count ?? 0;
  }
}
