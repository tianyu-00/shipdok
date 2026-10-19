# syntax=docker/dockerfile:1
# Build from the repo root (npm workspaces share one lockfile):
#   docker build -f apps/web/Dockerfile .
# Stage 1 builds the dashboard with Vite; stage 2 is nginx serving the files and forwarding /api to the API container.
FROM node:22-bookworm-slim AS build
WORKDIR /app
# npm needs every workspace manifest to read the lockfile.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
RUN npm ci -w apps/web && npm cache clean --force
COPY apps/web apps/web
RUN npm run build -w apps/web

FROM nginx:1.29-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
