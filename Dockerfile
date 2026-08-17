# ── Stage 1: Build ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build && npm prune --omit=dev

# ── Stage 2: Production runtime ────────────────────────────────────────────────
FROM node:22-alpine AS production

# Non-root user for defense in depth
RUN addgroup -S atomic && adduser -S atomic -G atomic

WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/index.html ./

# Sessions directory for the SQLite-backed KV store
RUN mkdir -p /data/sessions && chown -R atomic:atomic /data /app

USER atomic

ENV NODE_ENV=production
ENV PORT=3000
ENV SESSIONS_DIR=/data/sessions

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/healthz || exit 1

CMD ["node", "dist/server.js"]
