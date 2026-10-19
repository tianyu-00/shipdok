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
  migrations/    001_init ... 009_log_files
  src/           app.js, config.js, deployments.js (supersede/cancel), control.js (start/stop/restart requests), routes/ (auth, apps, env, webhooks, github, logs)
  scripts/       send-webhook.js (signed fake webhook; `npm run webhook`)
apps/worker/     BullMQ worker, dockerode, Postgres; node:test
  src/           deploy.js, docker.js, git.js, gitauth.js, process-job.js, control.js, dispatch.js, supervisor.js (pure crash/health rules), monitor.js, activity.js, buildlog.js (the log sink), envvars.js, db.js, reconcile.js, paths.js
  worker.js      entry point; cli.js: manual deploy
apps/web/        empty (dashboard not started)
packages/shared/ @shipdok/shared: crypto (AES-256-GCM), .env parser, github.js (app JWT, installation tokens), logstore.js (log format, masking, safe read/delete), constants
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
socket's group), `GITHUB_APP_PRIVATE_KEY_FILE` (host path, mounted read-only into api and worker), `API_HOST_PORT` (default 4000, loopback), `LOG_DIR` (set by compose to the `shipdok_logs` volume; outside Docker it defaults to `~/.shipdok/logs`), `MONITOR_INTERVAL_MS` (default 15000: how often crashes and health are checked).

Tests at last commit: API 292, worker 294, shared 161. Worker tests reuse the `_test` database the API tests create and
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
- **Crash handling and health (verified against real Docker in an isolated compose project):** the worker runs a monitor loop
  (every 15 s) that compares `apps.desired_state` with what Docker shows, per app, and records the result in `app_runtime`
  (states running, stopped, unhealthy, restarting, crashed; plus exit code, out-of-memory flag, health failures, next restart).
  The rules are a pure function (`supervisor.js`): a crash is restarted after 5 s / 15 s / 45 s / ... (cap 5 min); more than
  `apps.max_restarts` crashes (default 5, set when creating the app, 0 = never) within 10 minutes marks it `crashed` and it stays
  down until a manual Start/Restart (which, like a new version going live, forgives earlier crashes). Health: 3 failed checks in a
  row = `unhealthy`, shown and left running (never restarted or rolled back automatically); one good check clears it. A container
  stopped OUTSIDE Shipdok (`docker stop`/`kill`) is NOT restarted: it shows as `crashed` ("stopped outside Shipdok"). Telling that
  from a real crash uses Docker's event log (an API stop/kill leaves a `kill` event before `die`, a process dying by itself leaves only
  `die`); exit codes cannot tell them apart. If the log has no record of the exit (it is in memory, so after a host or Docker restart)
  the app is simply started again, uncounted: this is how apps come back after a reboot. Docker's own restart policy is now `no`
  (the monitor switches older containers over). The monitor skips an app while a deployment or control job is working on it
  (`activity.js`), only asks Docker about a NEW exit, and writes only when something changed. `GET /api/apps/:id/crashes` lists the last 20
  events (`app_crash_events`: cause crash / stopped_outside / recovered, and what Shipdok did). Checked for real: healthy, unhealthy
  (left running), a crash loop that gives up, forgiveness by Start, outside `docker kill` and `docker stop`, Shipdok's own stop not
  counted as a crash, and recovery with Docker's event buffer flushed. Not tested: a real host reboot, out-of-memory kills under Pi
  limits, ARM64. Known limits: the restart delay is rounded up to the next check; if Docker is not ready right after a boot, a failed
  start marks the app `crashed` (press Start).
- **Deployment logs (verified against real Docker in an isolated compose project):** every deployment gets a log file,
  `<LOG_DIR>/<app-id>/<deployment-id>/build.log` (plain text, one line each: `ISO-time stream message`, stream = stdout / stderr /
  shipdok), holding the clone and `docker build` output (`--progress=plain`), Shipdok's progress lines, a failed candidate's last
  container output, and the outcome. **Kept until the deployment is deleted** (decided by the administrator); `log_files` (migration
  009) records existence, size, truncated, finished. Best effort and never in the way: a log that cannot be written never fails or
  slows a deployment. Masked with `***`: the app's variable values and the GitHub token (both forms git may print it); an app's
  own computed secrets cannot be caught. Lines are capped at 16 KB, terminal colour codes and control characters removed, a message
  can never forge a second line; a log stops at 20 MB (`truncated`, announced once, nothing deleted). API: `GET
  /api/deployments/:id/logs` (`?offset=&limit=` pages by byte offset along `nextOffset`, `?tail=N`; `complete` = finished AND fully
  read; held-back half-written line), `DELETE /api/deployments/:id/logs` (finished deployments only, 409 while running; status and
  error summary stay; a clear 500 and the records kept if the files cannot be removed), `GET /api/storage` (log bytes per app, disk
  total/free with level ok / low under 20% free / critical under 10%). The API takes paths only from stored ids. At worker boot
  `reconcileLogs` closes build logs a dead worker left open (real size) and removes the logs of deployments that no longer exist (only
  UUID-named directories holding nothing but our two log files). Docker: the `shipdok_logs` volume, writable for worker and API
  (the API deletes on request). Back it up like the database if you care about old logs. Checked for real: private repo build log
  (29 BuildKit steps), no `ghs_`/`x-access-token` on disk, a failing deployment whose log shows the app's own output, delete,
  a worker killed mid-build, and the orphan tidy-up. Not tested: a volume on a slow SD card; `close` vs `exit` for the last lines
  of a command (correct by Node's docs, but this machine cannot show a loss). There is still no API to delete a deployment itself
  (SQL by hand; the next worker boot then removes its logs).
- **Worker git ignores the admin's git config** (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`): a credential helper such as
  Git Credential Manager can otherwise open a window and hang a refused clone.
- **Pi:** early prototype ran on the Pi (ARM64 builds work). The full stack has not been run on the Pi.

## Next

1. Runtime logs (the second half of SPEC.md §13): the app's own output, collected by the monitor into `runtime.log` per deployment,
   drained before the old container is removed at a redeploy, Docker-side rotation (10 MB x 3) on new containers. Administrator's
   rule: **runtime logs reset on every restart and are removed with the deployment**. Open question to settle first: an automatic
   crash restart happens within seconds, so a reset on every restart would wipe the crash output before anyone reads it; keep the
   previous run as `runtime.previous.log` (one generation), or reset only on manual restarts and new deployments.
2. Image retention, rollback, disk cleanup.
3. Dashboard (`apps/web`, React + Tailwind).
4. Live CPU/memory usage and limits display (SPEC.md §12).
5. Automatic host-port allocation and app deletion (currently SQL by hand: delete `deployments` rows first, `app_id` is
   `ON DELETE RESTRICT`; remove containers and `shipdok/*` images yourself).
6. GitHub App setup in the dashboard (App Manifest flow: one click on github.com, credentials stored encrypted in the DB) so
   other people hosting Shipdok do not fill in the form by hand. Read SPEC.md Milestone 3 first.
7. Compose follow-ups: add `web` once the dashboard exists (decide: serve it same-origin and proxy `/api`, or cross-origin with
   CORS and cookie settings); add `cloudflared` to compose (point it at `http://api:4000`, no host networking needed).
8. Pi: full-stack run in compose (ARM64 builds, firewall vs the health-check path, `DOCKER_GID`), run the tunnel as a service until
   then, hardening, docs (setup options: tunnel, reverse proxy, or manual deploys only), API docs (Scalar).

Known gaps: no API to delete a deployment (logs are tidied at the next worker boot); no audit/rate limit on `reveal`; old `shipdok/*` images pile up; build-time env vars; Railpack; DB backup docs.
The portfolio backend (`tianyu-00/TianYuSiteV2`, `backend/`, port 9090) is not yet deployed through the platform.
