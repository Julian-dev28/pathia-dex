# Multi-stage: the runtime image carries the standalone server and nothing else
# — no source, no dev dependencies, no package manager.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci` from the lockfile, so an image build cannot silently resolve a
# different dependency tree than the one that was tested.
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
# Never root: this process makes outbound HTTP and serves untrusted input.
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
# The backtest dataset is read at request time, so it has to be in the image.
COPY --from=build --chown=app:app /app/data ./data
USER app
EXPOSE 3000
# The health endpoint checks chain freshness, not just process liveness, so an
# orchestrator restarts this when its RPC has gone bad rather than only when
# the process has died.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "server.js"]
