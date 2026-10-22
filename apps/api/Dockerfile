# syntax=docker/dockerfile:1
# Build from the repo root (the API depends on packages/shared through npm workspaces):
#   docker build -f apps/api/Dockerfile .
# Configuration comes from the environment (compose), never from a file baked into the image.
# Scalar's browser bundle (the interactive API reference) is one self-contained file. The package it ships in has ~200 MB of dependencies
# the bundle does not need, so it is fetched here and only the file is copied into the image. Keep the version in step with apps/api/package.json.
FROM node:22-bookworm-slim AS scalar
ARG SCALAR_VERSION=1.75.0
WORKDIR /s
RUN npm init -y >/dev/null && npm install --no-audit --no-fund --omit=dev @scalar/api-reference@${SCALAR_VERSION} \
 && cp node_modules/@scalar/api-reference/dist/browser/standalone.js /scalar.js

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
# The release number the dashboard shows (and compares with the newest published one).
COPY VERSION VERSION

# Where deployment logs live (a volume in compose). Owned by the non-root user so a fresh volume is writable.
RUN mkdir -p /var/lib/shipdok/logs && chown node:node /var/lib/shipdok/logs
ENV LOG_DIR=/var/lib/shipdok/logs

# Where backups of Shipdok itself are kept (a volume in compose, written by the worker). Owned by the non-root user so a fresh volume is writable.
RUN mkdir -p /var/lib/shipdok/backups && chown node:node /var/lib/shipdok/backups && chmod 700 /var/lib/shipdok/backups
ENV BACKUP_DIR=/var/lib/shipdok/backups

COPY --from=scalar /scalar.js /app/apps/api/vendor/scalar.js
ENV SCALAR_BUNDLE=/app/apps/api/vendor/scalar.js

USER node
WORKDIR /app/apps/api
EXPOSE 4000
CMD ["node", "src/server.js"]
