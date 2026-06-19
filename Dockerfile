# ── Stage 1: Install dependencies ──────────────────────────────────────
FROM node:20-alpine AS deps

# better-sqlite3 needs native compilation tools
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 2: Production image (no build tools) ───────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/

# Create data directory for SQLite
RUN mkdir -p data

# Non-root user for security
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup && \
    chown -R appuser:appgroup /app

USER appuser

EXPOSE 8080

ENV NODE_ENV=production
ENV PORT=8080
ENV DATABASE_URL=./data/signals.db

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/healthz || exit 1

CMD ["node", "src/server.js"]
