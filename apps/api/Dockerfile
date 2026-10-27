FROM node:24-bookworm-slim

WORKDIR /workspace
RUN corepack enable
RUN apt-get update && apt-get install --no-install-recommends -y openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile

COPY apps/api apps/api
RUN DATABASE_URL=postgresql://account:build-only@localhost:5432/account pnpm --filter @account-auth/api build

EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
