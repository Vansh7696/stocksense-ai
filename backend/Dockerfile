# Multi-stage Dockerfile for StockSense Backend API Gateway
FROM node:20-alpine AS builder

WORKDIR /app

# Install native build tools required for node-gyp compilation (argon2)
RUN apk add --no-cache python3 make g++

# Copy package manifests and install all dependencies
COPY package*.json ./
RUN npm ci

# Copy Prisma schema and generate Prisma client
COPY prisma ./prisma/
RUN npx prisma generate

# Prune devDependencies to keep only production node_modules
RUN npm prune --omit=dev

# -------------------------------------------------------------
# Production Runner Stage (Minimal, Non-Root)
# -------------------------------------------------------------
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy production node_modules (including compiled native binaries and generated prisma client)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY package*.json ./

# Copy application source code and scripts
COPY src ./src
COPY scripts ./scripts

# Set ownership to unprivileged user node
RUN chown -R node:node /app

USER node

EXPOSE 5001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:5001/api/health || exit 1

CMD ["node", "src/server.js"]
