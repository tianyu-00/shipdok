# syntax=docker/dockerfile:1
# Build from the repo root (the API depends on packages/shared through npm workspaces):
#   docker build -f apps/api/Dockerfile .
# Configuration comes from the environment (compose), never from a file baked into the image.
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so editing source does not reinstall them. npm needs every workspace manifest to read the lockfile.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
RUN npm ci --omit=dev -w apps/api && npm cache clean --force

COPY packages/shared packages/shared
COPY apps/api apps/api

# Where deployment logs live (a volume in compose). Owned by the non-root user so a fresh volume is writable.
RUN mkdir -p /var/lib/shipdok/logs && chown node:node /var/lib/shipdok/logs
ENV LOG_DIR=/var/lib/shipdok/logs

USER node
WORKDIR /app/apps/api
EXPOSE 4000
CMD ["node", "src/server.js"]
