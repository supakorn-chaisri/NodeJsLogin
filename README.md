# Account authentication

A bilingual Thai/English authentication system built with Node.js 24, TypeScript, Fastify, PostgreSQL, Prisma, and Angular. Accounts are provisioned by an administrator; public self-registration is intentionally disabled.

## Local development with Docker Compose

1. Copy `.env.example` to `.env`. Replace both development secrets with different random values of at least 32 characters.
2. Start the stack:

   ```sh
   docker compose up --build
   ```

3. Open `http://localhost:8080`. Mailpit is available at `http://localhost:8025`.
4. Create the first administrator in another terminal. Use a unique password with at least 15 characters:

   ```powershell
   $env:BOOTSTRAP_ADMIN_EMAIL = "admin@example.test"
   $env:BOOTSTRAP_ADMIN_PASSWORD = "a-long-unique-passphrase"
   pnpm --filter @account-auth/api bootstrap-admin
   ```

   The command creates one active administrator and refuses to overwrite an existing account.

The local Compose configuration binds PostgreSQL and Mailpit to loopback. Keep the example credentials and HTTP-only cookie settings confined to local development.

## Development without the web container

Run PostgreSQL and Mailpit with Compose, then set `DATABASE_URL` in the root `.env` to use `localhost`. Set `APP_ORIGIN=http://localhost:4200` so CSRF origin validation matches the Angular dev server. In separate terminals:

```sh
pnpm --filter @account-auth/api dev
pnpm --filter account-web dev
```

Apply migrations before starting the API:

```sh
pnpm --filter @account-auth/api prisma:deploy
```

## Authentication behavior

- Server-side opaque sessions in HttpOnly cookies; 30-minute idle and 12-hour absolute expiry.
- SameSite=Lax cookies, CSRF double-submit validation, and exact Origin/Referer checks for state-changing API requests.
- Admin-provisioned accounts, one-time invitations and password-reset links, and email-change verification.
- Argon2id password hashes with a 15-character minimum and a 256-character maximum.
- Optional Google OpenID Connect login with state bound to the initiating browser, nonce, and PKCE. It can only link a verified Google identity to an existing active account.
- PostgreSQL-backed rate limiting, audit events, queued SMTP mail, and administrator session revocation.
- Swagger UI at `/api/docs`; health endpoint at `/api/health`.

## Production configuration

Terminate TLS at a trusted reverse proxy and set `NODE_ENV=production`, `APP_ORIGIN` to the public HTTPS origin, unique `CSRF_SECRET` and `RATE_LIMIT_SECRET` values, and production SMTP values. Configure Google client credentials and the matching callback URL only if Google login is enabled. Keep the API and database on a private network; set `TRUST_PROXY=true` only when the API is reachable exclusively through the configured trusted proxy.

Generate secrets without storing them in source control:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Use the command twice to produce independent CSRF and rate-limit secrets. Do not use the example `.env` values in production.

## Checks

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

The API typecheck/build generates the Prisma client. Database integration checks require PostgreSQL and an applied migration; the API unit tests run without a database.
