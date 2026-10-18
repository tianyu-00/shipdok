# Shipdok

Self-hosted single-host PaaS (GitHub repo -> one Docker container per app, auto-deploy on push) for one administrator.
Target: Raspberry Pi 4 (8 GB, ARM64), developed on WSL2 Ubuntu. JavaScript (not TypeScript), Node 22, ES modules,
npm workspaces. Private LAN/VPN only; only the GitHub webhook path is ever exposed (Cloudflare tunnel).
Full product spec: SPEC.md (the target design). Do not edit it as features get built.
This file records what is actually built; if the two disagree about what exists, this file is right.
Read the relevant section of the spec before building a new feature.

## How to work with me

- Explain the plan in text first and wait for my decisions before writing code, for anything larger than a small fix.
- Walk me through things step by step. Give each shell command in its own block; commands that depend on a previous
  result must not share a block. Say where files go.
- Test everything you can. Prove tests can fail: plant a bug (mutation), confirm the right test catches it. Say plainly
  what you could not test.
- **Never read or print** `infrastructure/.env`, any GitHub App private key (`*.pem`), or `jar.txt`. Never commit
  `jar.txt`, `infrastructure/.env`, `*.pem` or `node_modules/`. Check `git status` before committing.
- Plain `npm pkg set` has silently failed on my machine: edit `package.json` by hand when it matters.
- Do not commit or push unless I ask.
- When a feature is finished and tested, update "Built and verified" and "Next" in this file in the same commit.
  Never edit SPEC.md unless I ask.
- My `jar.txt` login cookie expires after 30 minutes idle; odd "`.map is not a function`"/"`undefined`" from curl+node
  one-liners usually means that.

## Layout

```text
apps/api/        Express 5 API, Postgres, sessions in Postgres, BullMQ producer; Jest + Supertest
  migrations/    001_init ... 007_app_runtime
  src/           app.js, config.js, deployments.js (supersede/cancel), control.js (start/stop/restart requests), routes/ (auth, apps, env, webhooks, github)
  scripts/       send-webhook.js (signed fake webhook; `npm run webhook`)
apps/worker/     BullMQ worker, dockerode, Postgres; node:test
  src/           deploy.js, docker.js, git.js, gitauth.js, process-job.js, control.js, dispatch.js, envvars.js, db.js, reconcile.js, paths.js
  worker.js      entry point; cli.js: manual deploy
apps/web/        empty (dashboard not started)
packages/shared/ @shipdok/shared: crypto (AES-256-GCM), .env parser, github.js (app JWT, installation tokens), constants
infrastructure/  compose.yaml (Postgres 16, Redis 7 on 127.0.0.1; migrate, api, worker services), .env (never committed)
apps/api/Dockerfile, apps/worker/Dockerfile, .dockerignore   images built from the repo root (see "Run it")
```

## Run it

```bash
docker compose -f infrastructure/compose.yaml --env-file infrastructure/.env up -d
npm run migrate -w apps/api
npm run dev -w apps/api          # API on 127.0.0.1:4000
npm start -w apps/worker         # reconciles on boot, then waits for jobs
npm test                         # API (Jest), worker (node:test), shared (node:test)
```

Or run the whole platform in Docker instead (do not mix with the npm commands above; both would use port 4000 and one queue).
Develop with npm: start only the data services with `... up -d postgres redis`. A bare `up -d` starts api and worker too.

```bash
docker compose -f infrastructure/compose.yaml --env-file infrastructure/.env up -d --build
```

Compose extras in `infrastructure/.env`: `DOCKER_GID` (`stat -c %g /var/run/docker.sock`, default 999: the non-root worker needs the
socket's group), `GITHUB_APP_PRIVATE_KEY_FILE` (host path, mounted read-only into api and worker), `API_HOST_PORT` (default 4000, loopback).

Tests at last commit: API 239, worker 163, shared 118. Worker tests reuse the `_test` database the API tests create and
migrate, so run the API tests first on a fresh machine. Tests refuse to touch any DB not ending in `_test`.
`infrastructure/.env` keys: `POSTGRES_*`, `REDIS_PASSWORD`, `SESSION_SECRET`, `APP_SECRETS_KEY` (64 hex; losing it makes
stored secrets unrecoverable), `WEB_ORIGIN`, `API_HOST/PORT`, `GITHUB_WEBHOOK_SECRET` (16+ chars), optional
`SETUP_TOKEN`, `COOKIE_SECURE`, and for the GitHub App: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_FILE` (chmod 600).

## Built and verified

- **Auth:** single admin, argon2id, sessions in Postgres (30 min idle / 12 h absolute), rate limits, Origin-header CSRF check.
- **Apps/deployments API:** create/list/get apps, request deployment (row first, then queued), history, cancel. Settings
  snapshotted per deployment. `repo` is `owner/repo`; clone URL built server-side. `host_port` required for now.
- **Deploy engine:** clone -> build -> candidate on temp port -> health check -> swap -> retire. Failures leave the running
  version untouched; unhealthy new live container restarts the old one. Ownership labels `shipdok.managed/app-id/
  deployment-id/role`.
- **Encrypted env vars:** AES-256-GCM `v1:iv:tag:ciphertext`, bound to `env:<appId>:<name>`; masked API; reveal only via POST.
  Values never in jobs, logs, errors or snapshots.
- **Queue/recovery:** concurrency 1, no retries, `maxStalledCount: 0`; boot reconcile removes orphan candidates/temp clones
  and marks in-flight deployments `interrupted`.
- **Cancel/supersede:** latest wins; worker claims (queued->building), polls cancel flag ~1s; the swap is the point of no
  return; gate refuses if cancelled or a newer deployment already succeeded.
- **Webhooks (verified end to end with real pushes):** `POST /api/webhooks/github` (raw-body HMAC SHA-256, constant time,
  dedupe by `X-GitHub-Delivery`, branch filtering, stopped apps skipped, exact-commit build with strict hex validation).
  History at `GET /api/webhooks/deliveries`. Checked against github.com: push to the tracked branch deploys, a redelivery of
  a missed push deploys, a repeated delivery is ignored as duplicate, another branch is ignored, two quick pushes supersede
  the older one, a stopped app is skipped. Every app tracking the repo+branch deploys (one build each, worker concurrency 1).
- **GitHub App auth (verified against github.com):** RS256 app JWT; installation tokens scoped to one repo with
  `contents: read`, cached until 5 min before expiry; token reaches git ONLY via `GIT_CONFIG_*` env (never argv/URL/logs/
  `.git/config`); git runs with a minimal environment (no `APP_SECRETS_KEY` etc.); creating an app looks up the
  installation (warns, never errors, if not installed); `GET /api/github/repos` lists installed repos. A private repo
  (`tianyu-00/shipdok-test-app`) was cloned and deployed through it. Not yet seen: a token refresh after the 1 h expiry.
- **Public webhook path (Cloudflare Tunnel, on WSL2 for now):** tunnel `shipdok`, hostname `hooks.tianyu00.com`, config in
  `~/.cloudflared/config.yml` (outside the repo): ingress forwards only `^/api/webhooks/github$` to `127.0.0.1:4000`, everything
  else is a Cloudflare 404 (checked: `/api/auth/me`, `/api/webhooks/deliveries`). Needs no port forwarding. Run with
  `cloudflared tunnel run shipdok`; it is not yet a service. The API sets `trust proxy` to `loopback`, so the webhook rate
  limit (120/min) counts each real client separately and ignores forged `X-Forwarded-For` values.
- **GitHub App config:** the App's ID, private key (`GITHUB_APP_PRIVATE_KEY_FILE`, kept at `~/.shipdok/github-app.pem`, chmod
  600) and webhook secret live in `infrastructure/.env`; API and worker both load it. Created by hand on github.com
  (webhook URL above, Contents read-only, Push event, installed on selected repos only).
- **Docker Compose hosting (api, migrate, worker verified on x86/WSL2 in an isolated project):** `migrate` runs once, then `api`
  (loopback-published, `/health` healthcheck) and `worker` start. Images are `shipdok-api` / `shipdok-worker`, deliberately NOT under
  `shipdok/` (that prefix is deployed apps; image cleanup will target it). The worker image has git and the Docker CLI + buildx; only
  the worker gets `/var/run/docker.sock` (root-equivalent, decided to mount it directly, no socket proxy). Inside compose the
  worker health-checks new containers via `HEALTH_CHECK_HOST=host.docker.internal` (`extra_hosts: host-gateway`), since its own
  127.0.0.1 is not the host; default stays 127.0.0.1 outside compose. Checked: private repo cloned, built, swapped (`hello from v6`);
  with `HEALTH_CHECK_HOST` unset the deploy failed after 120 s and the running version was untouched. Services get only the env
  vars they need (no blanket `env_file`). `.dockerignore` keeps `.env`, `*.pem`, `jar.txt` out of every image. Not tested: ARM64
  builds, a host firewall blocking bridge->host traffic (the health check path), a `web` service (none yet).
- **Start / stop / restart (verified against real Docker in an isolated compose project):** `POST /api/apps/:id/{stop,start,restart}`
  write `apps.desired_state` first (so webhooks skip a stopped app at once), then queue a `control` job on the SAME queue as
  deployments (one at a time, so it never overlaps a swap; a Stop can wait behind a running build, but the intent is already saved).
  The worker stops/starts/restarts the existing live container (no rebuild; stop keeps container, image, config) and, after
  start/restart, waits for the app's health check: a failure is reported as `unhealthy` and the app is left running, never
  restarted automatically. What the worker last did is in `app_runtime` (state running/stopped/unhealthy, last_action, last_error),
  shown as `runtime` in `GET /api/apps` and `GET /api/apps/:id` next to `desired_state`; the API never touches Docker.
  **A stopped app stays stopped when deployed**: the swap reads `desired_state` at the gate (so a Stop pressed during a build
  counts), validates the candidate as usual, then creates the new live container WITHOUT starting it; a failed swap only restarts
  containers that were running before. `POST /api/apps/:id/deployments` accepts `{"start": true}` to deploy and start (the
  desired state becomes running only if that deployment succeeds). Docker's 304 ("already stopped/started") counts as success.
  Checked for real: stop leaves the container exited and Docker does not restart it, stop twice, start, restart (StartedAt
  changes), deploy while stopped (new container `created`, nothing answers on the port), start runs the new version.
  Not tested: how `on-failure` restart behaves after a host/daemon reboot (see Next).
- **Worker git ignores the admin's git config** (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`): a credential helper such as
  Git Credential Manager can otherwise open a window and hang a refused clone.
- **Pi:** early prototype ran on the Pi (ARM64 builds work). The full stack has not been run on the Pi.

## Next

1. Runtime health and crashes (the second half of start/stop/restart; SPEC.md §11, §18): a worker monitor loop reads each live
   container's Docker state and runs the HTTP health check every ~30 s into `app_runtime` (add states Restarting, Crashed; keep
   Unhealthy = shown, never auto-restarted). Decide the restart policy: containers use `on-failure` with 5 retries; check on the
   Pi whether they come back after a reboot, else consider `unless-stopped` plus a Shipdok-side retry limit (spec wants a limit).
2. Persistent log storage.
3. Image retention, rollback, disk cleanup.
4. Dashboard (`apps/web`, React + Tailwind).
5. Automatic host-port allocation and app deletion (currently SQL by hand: delete `deployments` rows first, `app_id` is
   `ON DELETE RESTRICT`; remove containers and `shipdok/*` images yourself).
6. GitHub App setup in the dashboard (App Manifest flow: one click on github.com, credentials stored encrypted in the DB) so
   other people hosting Shipdok do not fill in the form by hand. Read SPEC.md Milestone 3 first.
7. Compose follow-ups: add `web` once the dashboard exists (decide: serve it same-origin and proxy `/api`, or cross-origin with
   CORS and cookie settings); add `cloudflared` to compose (point it at `http://api:4000`, no host networking needed).
8. Pi: full-stack run in compose (ARM64 builds, firewall vs the health-check path, `DOCKER_GID`), run the tunnel as a service until
   then, hardening, docs (setup options: tunnel, reverse proxy, or manual deploys only), API docs (Scalar).

Known gaps: no audit/rate limit on `reveal`; old `shipdok/*` images pile up; build-time env vars; Railpack; DB backup docs.
The portfolio backend (`tianyu-00/TianYuSiteV2`, `backend/`, port 9090) is not yet deployed through the platform.
