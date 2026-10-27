import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '../generated/prisma/client.js';
import { normalizeEmail } from '../lib/crypto.js';
import { HttpError } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import type { RateLimitService } from './rate-limit-service.js';
import type { SessionService } from './session-service.js';

const accountWindowMs = 15 * 60 * 1000;
const accountLimit = 5;
const ipWindowMs = 15 * 60 * 1000;
const ipLimit = 30;

export class AuthService {
  private readonly dummyHash = hashPassword(randomBytes(32).toString('base64url'));

  constructor(
    private readonly prisma: PrismaClient,
    private readonly sessions: SessionService,
    private readonly limits: RateLimitService,
  ) {}

  async authenticate(emailInput: string, password: string, ip: string): Promise<string> {
    const email = normalizeEmail(emailInput);
    const [accountCount, ipCount] = await Promise.all([
      this.limits.hit('login-account', email, accountWindowMs),
      this.limits.hit('login-ip', ip, ipWindowMs),
    ]);

    if (accountCount > accountLimit || ipCount > ipLimit) {
      throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many sign-in attempts. Try again later.');
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, passwordHash: true, status: true },
    });

    const passwordMatches = await verifyPassword(
      user?.passwordHash ?? (await this.dummyHash),
      password,
    );

    if (!user || user.status !== 'ACTIVE' || !user.passwordHash || !passwordMatches) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }

    await this.limits.clear('login-account', email, accountWindowMs);

    return user.id;
  }
}
