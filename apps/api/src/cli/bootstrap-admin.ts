import { prisma } from '../db.js';
import { normalizeEmail } from '../lib/crypto.js';
import { hashPassword, validatePassword } from '../lib/passwords.js';

async function bootstrapAdmin(): Promise<void> {
  const emailInput = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;

  if (!emailInput || !password) {
    throw new Error('Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD before running this command.');
  }

  const email = normalizeEmail(emailInput);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    throw new Error('BOOTSTRAP_ADMIN_EMAIL must be a valid email address.');
  }

  const passwordError = validatePassword(password);
  if (passwordError) {
    throw new Error(`BOOTSTRAP_ADMIN_PASSWORD does not meet the password policy: ${passwordError}.`);
  }

  await prisma.$connect();
  try {
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await hashPassword(password),
        role: 'ADMIN',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
      select: { id: true, email: true, role: true },
    });
    await prisma.auditEvent.create({
      data: {
        event: 'admin.bootstrap.created',
        targetUserId: user.id,
      },
    });
    console.info(`Created ${user.role} account ${user.email}.`);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002'
    ) {
      throw new Error('An account with that email already exists; no account was changed.');
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

void bootstrapAdmin().catch((error: unknown) => {
  console.error('Administrator bootstrap failed:', error instanceof Error ? error.message : 'Unknown error.');
  process.exitCode = 1;
});
