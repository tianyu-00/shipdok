# syntax=docker/dockerfile:1
# Build from the repo root (the worker depends on packages/shared through npm workspaces):
#   docker build -f apps/worker/Dockerfile .
# The worker runs `git clone`, `docker build` and (for apps built with Railpack) `railpack prepare`, so the image needs git, the Docker CLI (with buildx) and Railpack.
# It talks to the host's Docker through the mounted socket, which is root-equivalent: mount it here and nowhere else.
FROM docker:28-cli AS dockercli

# Railpack (apps without a Dockerfile; see apps/worker/src/railpack.js): a single static program, downloaded for the architecture being built and checked against
# the checksum published with the release. To update it, change the version AND both checksums (checksums.txt of the release lists them). The worker asks
# the program for its version and uses the matching frontend image, so nothing else has to change.
FROM node:22-bookworm-slim AS railpack
ARG TARGETARCH
ARG RAILPACK_VERSION=0.43.0
ARG RAILPACK_SHA256_AMD64=248a8f60f36854aabed6124113631078a802de3461660855fc4de9c26065c1fb
ARG RAILPACK_SHA256_ARM64=732ece14eb4f4676a43ebba19431f954edf7b130acb76159ef0f2ff86ac42ac9
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) arch=x86_64; sum="$RAILPACK_SHA256_AMD64" ;; \
      arm64) arch=arm64; sum="$RAILPACK_SHA256_ARM64" ;; \
      *) echo "no Railpack build for $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/railpack.tgz "https://github.com/railwayapp/railpack/releases/download/v${RAILPACK_VERSION}/railpack-v${RAILPACK_VERSION}-${arch}-unknown-linux-musl.tar.gz"; \
    echo "${sum}  /tmp/railpack.tgz" | sha256sum -c -; \
    tar -xzf /tmp/railpack.tgz -C /usr/local/bin railpack; \
    /usr/local/bin/railpack --version

FROM node:22-bookworm-slim

ENV NODE_ENV=production
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY --from=railpack /usr/local/bin/railpack /usr/local/bin/railpack

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
RUN npm ci --omit=dev -w apps/worker && npm cache clean --force

COPY packages/shared packages/shared
COPY apps/worker apps/worker
# The release number a backup records in its manifest.
COPY VERSION VERSION

# Where deployment logs live (a volume in compose). Owned by the non-root user so a fresh volume is writable.
RUN mkdir -p /var/lib/shipdok/logs && chown node:node /var/lib/shipdok/logs
ENV LOG_DIR=/var/lib/shipdok/logs

# Where backups of Shipdok itself are made (a volume in compose; the API reads and deletes them). Owned by the non-root user so a fresh volume is writable.
RUN mkdir -p /var/lib/shipdok/backups && chown node:node /var/lib/shipdok/backups && chmod 700 /var/lib/shipdok/backups
ENV BACKUP_DIR=/var/lib/shipdok/backups

# Starts as root ONLY to read the Docker socket's group (it differs per machine), then drops to the unprivileged `node` user with that
# group; see docker-entrypoint.sh. Nothing of Shipdok runs as root.
WORKDIR /app/apps/worker
RUN chmod +x docker-entrypoint.sh
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "worker.js"]
