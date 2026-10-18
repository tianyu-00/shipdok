# syntax=docker/dockerfile:1
# Build from the repo root (the worker depends on packages/shared through npm workspaces):
#   docker build -f apps/worker/Dockerfile .
# The worker runs `git clone` and `docker build`, so the image needs git and the Docker CLI (with buildx).
# It talks to the host's Docker through the mounted socket, which is root-equivalent: mount it here and nowhere else.
FROM docker:28-cli AS dockercli

FROM node:22-bookworm-slim

ENV NODE_ENV=production
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
RUN npm ci --omit=dev -w apps/worker && npm cache clean --force

COPY packages/shared packages/shared
COPY apps/worker apps/worker

USER node
WORKDIR /app/apps/worker
CMD ["node", "worker.js"]
