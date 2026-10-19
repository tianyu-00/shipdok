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

# Where deployment logs live (a volume in compose). Owned by the non-root user so a fresh volume is writable.
RUN mkdir -p /var/lib/shipdok/logs && chown node:node /var/lib/shipdok/logs
ENV LOG_DIR=/var/lib/shipdok/logs

# Starts as root ONLY to read the Docker socket's group (it differs per machine), then drops to the unprivileged `node` user with that
# group; see docker-entrypoint.sh. Nothing of Shipdok runs as root.
WORKDIR /app/apps/worker
RUN chmod +x docker-entrypoint.sh
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "worker.js"]
