# syntax=docker/dockerfile:1.7

# ---- deps ----
FROM node:20-alpine AS deps
WORKDIR /app
ENV CI=true
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
# .npmrc carries the public-hoist-pattern that exposes eslint-config-next's
# plugins to ESLint (next build runs lint), so it must be present at install.
COPY package.json pnpm-lock.yaml* .npmrc* ./
RUN pnpm install --frozen-lockfile

# ---- builder ----
FROM node:20-alpine AS builder
WORKDIR /app
ENV CI=true
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build the waterways data. The committed data-cache/gauges.tar.gz is unpacked
# automatically, so this is seconds (no NHD round-trip) unless gauges were
# added or the cache schema (CACHE_VERSION) changed.
RUN pnpm data:build
RUN pnpm build

# ---- runner ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup -S app && adduser -S app -G app

COPY --from=builder --chown=app:app /app/public ./public
COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static

USER app
EXPOSE 3000
CMD ["node", "server.js"]
