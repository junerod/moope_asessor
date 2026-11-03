# syntax=docker/dockerfile:1
# MOOPE Meu Assessor — multi-target image
#   app      → Next.js standalone (porta 3000)
#   runtime  → worker / scheduler / migrate (tsx)

ARG NODE_VERSION=22

# ---- deps ----
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# ---- build ----
FROM deps AS build
WORKDIR /app
COPY . .
# public/ is required by Next standalone copy; may be empty
RUN mkdir -p public
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=4096
RUN npm run build

# ---- app (Next standalone) ----
FROM node:${NODE_VERSION}-bookworm-slim AS app
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public
USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]

# ---- runtime (worker / scheduler / migrate) ----
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 assessor
COPY --from=deps --chown=assessor:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=assessor:nodejs /app/package.json ./
COPY --from=build --chown=assessor:nodejs /app/tsconfig.json ./
COPY --from=build --chown=assessor:nodejs /app/src ./src
COPY --from=build --chown=assessor:nodejs /app/scripts ./scripts
USER assessor
# default = worker; compose overrides for scheduler/migrate
CMD ["npx", "tsx", "src/worker/index.ts"]
