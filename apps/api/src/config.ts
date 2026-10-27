import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const isProduction = process.env.NODE_ENV === 'production';
const localCsrfSecret = randomBytes(32).toString('base64url');
const localRateLimitSecret = randomBytes(32).toString('base64url');
const optionalNonEmptyString = z.preprocess(
  (value) => value === '' ? undefined : value,
  z.string().min(1).optional(),
);
const optionalUrl = z.preprocess(
  (value) => value === '' ? undefined : value,
  z.string().url().optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
  APP_ORIGIN: z.string().url().default('http://localhost:4200'),
  GOOGLE_CLIENT_ID: optionalNonEmptyString,
  GOOGLE_CLIENT_SECRET: optionalNonEmptyString,
  GOOGLE_CALLBACK_URL: optionalUrl,
  SMTP_HOST: z.string().min(1).default('localhost'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  SMTP_USER: optionalNonEmptyString,
  SMTP_PASSWORD: optionalNonEmptyString,
  SMTP_FROM: z.string().email().default('account@example.test'),
  SMTP_SECURE: z.enum(['true', 'false']).default('false'),
  CSRF_SECRET: z.string().min(32).default(localCsrfSecret),
  RATE_LIMIT_SECRET: z.string().min(32).default(localRateLimitSecret),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${z.treeifyError(parsed.error)}`);
}

const values = parsed.data;

if (Boolean(values.GOOGLE_CLIENT_ID) !== Boolean(values.GOOGLE_CLIENT_SECRET)) {
  throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together.');
}
if (Boolean(values.SMTP_USER) !== Boolean(values.SMTP_PASSWORD)) {
  throw new Error('SMTP_USER and SMTP_PASSWORD must be configured together.');
}

if (isProduction) {
  const missing: string[] = [];

  if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) {
    missing.push('SMTP_HOST and SMTP_FROM');
  }
  if (!process.env.CSRF_SECRET || !process.env.RATE_LIMIT_SECRET) {
    missing.push('CSRF_SECRET and RATE_LIMIT_SECRET');
  }

  if (missing.length > 0) {
    throw new Error(`Missing production configuration: ${missing.join(', ')}`);
  }
}

export const config = {
  ...values,
  APP_ORIGIN: new URL(values.APP_ORIGIN).origin,
  GOOGLE_CALLBACK_URL:
    values.GOOGLE_CALLBACK_URL ??
    new URL('/api/auth/google/callback', values.APP_ORIGIN).toString(),
  SMTP_SECURE: values.SMTP_SECURE === 'true',
  TRUST_PROXY: values.TRUST_PROXY === 'true',
  SESSION_COOKIE:
    values.NODE_ENV === 'production' ? '__Host-session' : 'account_session',
  CSRF_COOKIE: values.NODE_ENV === 'production' ? '__Host-csrf' : 'account_csrf',
  OAUTH_STATE_COOKIE:
    values.NODE_ENV === 'production' ? '__Host-oauth-state' : 'account_oauth_state',
  getSecureCookie: () => values.NODE_ENV === 'production',
} as const;
