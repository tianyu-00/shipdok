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
  migrations/    001_init ... 014_app_stats
  src/           app.js, config.js, deployments.js (supersede/cancel/rollback requests), control.js (start/stop/restart requests), disk.js (free-space levels), images.js (which versions keep an image), ports.js (automatic host ports), routes/ (auth, apps, env, webhooks, github, logs)
  scripts/       send-webhook.js (signed fake webhook; `npm run webhook`)
apps/worker/     BullMQ worker, dockerode, Postgres; node:test
  src/           deploy.js, docker.js, git.js, gitauth.js, process-job.js, control.js, dispatch.js, supervisor.js (pure crash/health rules), prune.js (image clean-up), deleteapp.js (removing an app), stats.js (CPU and memory samples), monitor.js, activity.js, buildlog.js (the log sink), runtimelog.js (collects the app's output), dockerlogs.js (Docker log frames), envvars.js, db.js, reconcile.js, paths.js
  worker.js      entry point; cli.js: manual deploy
apps/web/        Vite + React (JavaScript) dashboard, Tailwind v4 + shadcn/ui (copied into src/components/ui); Vitest + Testing Library
  src/           App.jsx, pages/ (auth, apps list, create app, app detail), components/ (tabs, log viewer, actions), lib/ (api client, queries, format)
  nginx.conf, Dockerfile   production image: nginx serves the build and forwards /api to the API
packages/shared/ @shipdok/shared: crypto (AES-256-GCM), .env parser, github.js (app JWT, installation tokens), logstore.js (log format, masking, safe read/delete), constants
infrastructure/  compose.yaml (Postgres 16, Redis 7 on 127.0.0.1; migrate, api, worker services), .env (never committed)
apps/api/Dockerfile, apps/worker/Dockerfile, apps/web/Dockerfile, .dockerignore   images built from the repo root (see "Run it")
```

## Run it

```bash
docker compose -f infrastructure/compose.yaml --env-file infrastructure/.env up -d
npm run migrate -w apps/api
npm run dev -w apps/api          # API on 127.0.0.1:4000
npm start -w apps/worker         # reconciles on boot, then waits for jobs
npm run dev -w apps/web          # dashboard on http://localhost:5173 (Vite forwards /api to the API on 4000)
npm test                         # API (Jest), worker (node:test), shared (node:test), web (Vitest)
```

Or run the whole platform in Docker instead (do not mix with the npm commands above; both would use port 4000 and one queue).
Develop with npm: start only the data services with `... up -d postgres redis`. A bare `up -d` starts api, worker and web too.

```bash
docker compose -f infrastructure/compose.yaml --env-file infrastructure/.env up -d --build
```

Compose extras in `infrastructure/.env`: `DOCKER_GID` (`stat -c %g /var/run/docker.sock`, default 999: the non-root worker needs the
socket's group), `GITHUB_APP_PRIVATE_KEY_FILE` (host path, mounted read-only into api and worker), `API_HOST_PORT` (default 4000, loopback), `LOG_DIR` (set by compose to the `shipdok_logs` volume; outside Docker it defaults to `~/.shipdok/logs`), `MONITOR_INTERVAL_MS` (default 15000: how often crashes and health are checked), `STATS_INTERVAL_MS` (default 15000: how often CPU and memory are measured), `WEB_HOST_PORT` (default 8080) and `WEB_BIND` (default 127.0.0.1) for the dashboard container; `PORT_RANGE` (default `20000-20999`, in compose passed to the API) is where a new app's host port comes from when none is given; `WEB_ORIGIN` must be the exact address you open it at (several allowed, comma separated; default `http://localhost:<WEB_HOST_PORT>` in compose, `http://localhost:5173` for `npm run dev`).

Tests: API 534, worker 493, shared 176, web 356. Worker tests reuse the `_test` database the API tests create and
migrate, so run the API tests first on a fresh machine. Tests refuse to touch any DB not ending in `_test`.
`infrastructure/.env` keys: `POSTGRES_*`, `REDIS_PASSWORD`, `SESSION_SECRET`, `APP_SECRETS_KEY` (64 hex; losing it makes
stored secrets unrecoverable), `WEB_ORIGIN`, `API_HOST/PORT`, `GITHUB_WEBHOOK_SECRET` (16+ chars), optional
`SETUP_TOKEN`, `COOKIE_SECURE`, and for the GitHub App: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_FILE` (chmod 600).

## Built and verified

- **Auth:** single admin, argon2id, sessions in Postgres (30 min idle / 12 h absolute), rate limits, Origin-header CSRF check.
  `POST /api/auth/password` ({currentPassword, newPassword}, 12-256 chars, must differ) needs a session AND the current password (a wrong
  one is a 403, not a 401, so the dashboard does not mistake it for an ended session), ends every OTHER session and gives this one a new
  id; limited like login (10 per 15 min). There is still no "forgot password": delete the `users` row in Postgres to get the setup screen again.
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
  of a command (correct by Node's docs, but this machine cannot show a loss). `DELETE /api/deployments/:id` (below) deletes the
  deployment itself together with its log.
- **Runtime logs (verified against real Docker in an isolated compose project):** the monitor hands every container it looks at to
  the collector (`runtimelog.js`), which streams the app's own output into `<LOG_DIR>/<app-id>/runtime.log`.
  **Administrator's rule: ONE runtime log per app (plus the run before it), reset on every restart or new deployment. Build logs are
  the ones that exist per deployment.** Whenever a container starts again (manual start/restart, an automatic restart, a recovery,
  or a new deployment, which is a new container; told apart by the container's id and `StartedAt`, kept in `runtime_logs`, migration
  011) the current log becomes `runtime.previous.log` (ONE earlier run is kept, replacing the older one: an automatic crash restart
  happens within seconds, so without it the crash output would be wiped before anyone read it) and a fresh `runtime.log` starts.
  `runtime_logs` also records which deployment's container wrote each file. Nothing runtime is written inside a deployment's
  directory any more; at worker boot `reconcileLogs` removes the per-deployment runtime files an earlier version left behind. Lines
  carry Docker's own timestamps and stdout/stderr labels, secrets are masked with the app's current variable values (if they cannot
  be read, nothing is collected for that app), 100 MB cap per file (`truncated`; a capped log is not followed again), and new
  containers get Docker-side rotation (10 MB x 3). Resuming needs no extra state: the time of the last line in the file says where to
  continue, so a worker restart or a dropped connection neither loses nor repeats lines. At a redeploy the old container's rest is
  drained into the log before it is removed (`onRetire`, 10 s limit, best effort), and if that did not happen the old run is closed
  before the new container's begins (never mixed). A run that began and ended between two looks (a crash loop does this) is collected
  whole when first seen, bounded at the moment it exited so a later run cannot leak in. API: `GET /api/apps/:id/logs` (`?kind=previous`
  for the run before; `?tail=`, `?offset=&limit=`; the answer names the `deploymentId` that wrote it), `DELETE /api/apps/:id/logs`
  (both files; refused with 409 while the app's output is still being collected, so stop the app first). `GET
  /api/deployments/:id/logs` serves build logs only (`?kind=runtime|previous` there is now a 400); deleting a deployment's logs never
  touches the app's runtime logs. Checked for real: output collected, redeploy and rollback rotation (three container generations,
  one `runtime.log` + one `runtime.previous.log` in the app directory), restart rotation, secret masked (0 occurrences on disk), a
  worker restart with 65 lines collected, 0 gaps, 0 duplicates, a crash loop (the crashed run readable as "previous"), delete after
  stop. Not tested: a very chatty app on the Pi's SD card, ARM64, Docker versions that return older lines than asked for (the file is
  protected against that anyway). Known limits: stopping or restarting takes as long as the app needs to shut down (a plain Node
  process ignoring SIGTERM costs Docker's 10 s grace), and lines inside the same millisecond as the last stored one can be lost on a
  resume.
- **Image retention, rollback, deleting deployments, disk warning (verified against real Docker in an isolated compose project):**
  **Administrator's rules: keep the live image plus the previous working one; prune only on request, with an opt-in auto-prune; pruning
  never touches logs (logs go only when the administrator deletes them).** Per app: `keep_previous_images` (default 1, 0 to 10) and
  `auto_prune` (default false), set when creating the app or with `PUT /api/apps/:id/retention`. "Live" is the newest successful
  deployment; the kept versions are the newest distinct images (a rollback reuses an image, so two records can share one). `GET
  /api/apps/:id/images` lists the successful versions with a state (live / previous / prunable / removed) and `canRollBackTo`, the
  last clean-up (`cleanup` is also on the app), and `prunableBytes`. `POST /api/apps/:id/prune` queues a `prune` job: the worker (the
  only thing that talks to Docker, one job at a time on the queue, so never during a swap) removes this app's labelled images
  (`shipdok.managed` + `shipdok.app-id`, tag `shipdok/<slug>:<deployment id>`) that are not kept, not run by the live container, not
  the image of an unfinished deployment and not the source of a waiting rollback, without force (an image a container still uses is
  skipped and counted); it also removes leftovers of failed or cancelled builds, and records versions whose image was removed by hand.
  The deployment records and their logs stay, marked `image_removed_at` ("cannot be rolled back to"). The summary (`app_cleanup`) says
  how much was freed, measured as the drop in Docker's layer usage (image sizes alone are misleading: versions of an app share their
  base layers; in the real run three 76 MB images freed 0.02 MB), or 0 if Docker cannot say. `prunableBytes` and `/api/storage`'s
  `images` add up the recorded image sizes (`image_bytes`), so they are upper bounds. With `auto_prune` on, the same clean-up runs
  after every successful deployment; a failure there never fails the deployment. `POST /api/apps/:id/rollback` (`{deploymentId?,
  start?}`; default = the newest earlier version that still has an image) creates a new deployment (trigger `rollback`,
  `rollback_of`, the old commit) that runs the existing image through the normal candidate, health check, swap, and restore path with
  no clone and no build (`reuseImage`; the worker checks the tag is `shipdok/<this slug>:<uuid>` and the image's labels name this
  app, and a reused image is NEVER deleted, not even when the deployment fails or is cancelled). It uses the app's CURRENT settings
  and variables; only the image is old. A stopped app stays stopped unless `start: true`. `DELETE /api/deployments/:id` removes the
  record, its build log and, through the worker (`removeimage` job), its image if nothing needs it. It is refused while the
  deployment runs, while a queued rollback will use it, for the running version (the newest successful record), and for a kept
  previous version nobody else holds. Disk: `POST /api/apps/:id/deployments` answers 409 `disk_critical` (under 10% free on the
  volume the logs are on, normally the same disk as Docker's) unless the body has `ignoreDiskWarning: true` (the administrator
  chooses to continue; the answer then carries a `warning` and the disk figures); under 20% free it deploys and adds a `warning`.
  A webhook push cannot ask, so at critical it builds nothing and the delivery history says why (redeliver or deploy manually
  after freeing space). Rollback, start, stop and restart are not held back. Compose fix found while testing: with no GitHub App
  configured the stack used to crash on start because compose always passed the key path; it is now passed only when
  `GITHUB_APP_ID` is set. Checked for real: rollback swapped a running container to an older image without building (one container
  left, same port, answers with the old version), rolling back and forward, prune keeping live + previous and removing older
  versions, a failed build's leftover, an image blocked by a stopped container (skipped and not marked removed), another app's
  image untouched, a rollback to a pruned version refused, delete of running / kept / shared / old versions, the worker removing a
  deleted version's image, auto-prune after a rollback, and a rollback to an image removed behind Shipdok's back (deployment fails
  with a clear message, the running version untouched). Not tested: the disk warning on a really full disk (only simulated with a
  fake measurement), a build that fills the disk, ARM64, a real push-triggered build after this change (the build step itself was
  only re-indented; unit tests cover it). Known limits: the layer-usage measure also counts anything else Docker does during the
  clean-up; dangling build cache is not cleaned (no per-app ownership; a separate "clean build cache" action is later work).
- **Dashboard (slice 1, verified in a real browser against the full Docker stack):** `apps/web` is Vite + React in plain JavaScript,
  Tailwind v4, shadcn/ui components (JavaScript mode; the CLI wrongly installed an unrelated npm package `cn`, removed: components import
  `@/lib/utils`), React Router, TanStack Query (polling). **Same origin**: in development Vite forwards `/api`; in Docker the `web`
  container (nginx, port 8080 on 127.0.0.1 by default) serves the build and forwards `/api` to the API, so cookies just work and there
  is no CORS. nginx re-resolves `api` (survives its recreation), overwrites `X-Forwarded-For`, and sends a strict CSP; the API gets
  `TRUST_PROXY=loopback,uniquelocal` in compose so rate limits count the real client. Theme: Light, Dark or System (next-themes,
  remembered in the browser); dark is a very dark near-black gray (`#0f0f10`, cards `#151516`), never pure black. Screens: login and
  first-run setup (a session that ends sends you back to the login form, then back to the page you were on), apps list with a disk
  warning, create app (repository list from the GitHub App, or typed), app page with tabs: Overview (what runs, limits, status,
  crash history), Deployments (history with reasons, Cancel, build log window), Logs (the app's own output, following, with the
  previous run), Variables (masked, reveal on request, edit, delete, `.env` import with line-by-line problems, pending-changes
  notice). Deploy asks "deploy anyway?" when the API answers `disk_critical`; a stopped app offers "Deploy and start"; Stop asks
  first; while a Stop or Start has been requested but not carried out the badge says "Stopping…" / "Starting…". If the browser's
  address is not in `WEB_ORIGIN` every button would fail with a bare 403, so the dashboard says which address was refused and which
  setting to change. Slices 2a and 2b (below) added images, rollback, delete, storage, settings and change password. Checked for real (headless Chromium in a throwaway container, isolated compose project): setup, login (wrong
  password, expiry), create app, a running app collected by the worker, live-following log, restart (earlier run kept), stop/start,
  failed deployment with its build log, variables (secret never in the page until revealed), theme switching and persistence, deep
  links and reloads, a phone-width screen without sideways scroll, no console or CSP errors. Not tested: other browsers, a screen
  reader, a very long log in the page (capped at 5000 lines in memory), `WEB_BIND` on a real LAN, ARM64 image builds, the dashboard
  with a GitHub App configured (the repository list was only tested with a fake answer). Known limits: failed deployments show the
  API's short summary (`git exited 128`), the reason is in the build log; the login rate limit (10 per 15 minutes) also blocks the
  administrator after repeated tries from the same address.
- **Dashboard slice 2a: versions, rollback, clean-up, delete a deployment (verified in a real browser against real Docker in an isolated
  compose project):** the Deployments tab labels each successful version (Live / Previous / Old image / Image removed; two records that
  share one image share the label, so after a rollback two rows say Live), offers **Roll back** where an image still exists (asks first;
  a stopped app can "Roll back and start") and **Delete** (disabled, with the reason, for the running version and the kept previous
  one; one confirmation, which says whether its image goes too). New **Images** tab: keep-N (0 to 10) and automatic clean-up
  settings, the versions with image sizes, the last clean-up's result, and **Clean up now**, which first lists exactly the images
  that will be removed (and says logs are never touched), then shows "running" until the result changes. The version labels are re-read
  as soon as a deployment appears or finishes. The repository name links to its GitHub page. Checked for real: rollback to the
  previous version (the app answered with the old code), clean-up removing exactly the listed old image, delete with the typed name,
  settings surviving a reload, light and dark, phone width without sideways scroll (the five tabs scroll inside their own bar). Not
  tested: a rollback to an image removed behind Shipdok's back from the UI, a very long history.
- **Dashboard slice 2b: app settings, storage page, change password (verified in a real browser against real Docker in an isolated
  compose project):** **Settings tab**: `PUT /api/apps/:id` edits name, branch, root directory, container port, host port, health path
  (empty = none), memory, CPU and the restart limit; the repository can NOT be edited (delete the app and create a new one, administrator's
  decision) and neither can the slug (it names images and containers, so a rename keeps it). A host port or name another app has is a 409
  (`port_taken` / `name_taken`) that names the app, shown under the field; the unique indexes decide, so two edits racing for one port cannot
  both win. Shipdok only knows its own apps: a port used by something else on the machine fails at the deployment (the old version is
  restored), and the form says so. **An edit never touches what runs**: the deployment bakes in the snapshot of settings it was started with.
  `GET /api/apps` and `/api/apps/:id` carry `running_settings` (the newest successful deployment's snapshot, no variable versions) and, on the
  detail, `settings_pending` (which of branch, root_dir, container_port, host_port, health_path, memory_mb, cpus differ from it; null before any
  deployment). The dashboard shows "Running now" from `running_settings`, links to the port that really answers, and lists the waiting edits
  (name and restart limit apply at once). A deployment or a rollback uses the app's CURRENT settings, which is how an edit is applied.
  **Worker change that goes with it:** the monitor and the start/restart health check read container port and health path from the
  newest successful deployment's snapshot (`RUNNING_*` in `apps/worker/src/db.js`), falling back to the app's values for old records;
  otherwise editing the container port would make a healthy app look unhealthy until it was redeployed (checked for real: edited the port
  and waited several monitor rounds, the app stayed Running). **Storage page** (`/storage`, header link): disk bar and level, per app log
  bytes and image bytes (upper bounds), link to the app's Images tab, "Delete output logs" (refused with a clear reason while the app runs),
  and "Delete this log" for a finished deployment's build log inside the log window; all behind a confirmation. **Change password**: key
  icon in the header. Checked for real: port taken (named, typed value kept), edit then rollback = container on the new port with the new
  memory limit, old port gone, pending list cleared; wrong current password explained inside the dialog; a second browser signed out
  while the first stays in; old password rejected, new one accepted. Not tested: a real push-triggered deployment applying an edit (a
  rollback was used, same code path for settings), a host port held by a non-Shipdok process, a very long session. Known limits: the name
  changes in the dashboard but containers and images keep the old slug.
- **Deleting an app and automatic host ports (verified against real Docker and a real browser in an isolated compose project):**
  **Administrator's rules: deleting an app removes its logs too; recorded webhook deliveries are kept as history; it works on a running app
  directly (no Stop first); the exact name must be typed.** `DELETE /api/apps/:id` with `{confirm: "<exact name>"}` (else 400
  `confirm_mismatch`) refuses while a deployment is queued or running (409 `deployment_active`: cancel it first), then marks the app
  (`deleting_at`, migration 013), sets `desired_state` to stopped at once, and queues a `deleteapp` job; the API itself deletes nothing.
  The worker (`deleteapp.js`, same queue, one job at a time, app marked busy so the monitor leaves it alone) does, in this order: lets the
  output collector go (`collector.release`), stops and force-removes every container labelled with the app (live and leftover
  candidates), removes every image labelled and named like Shipdok's own for the app, deletes the app's whole log directory
  (`removeAppLogs`), and last, in one transaction, its deployments and the app (variables, runtime state, crash events, log records and
  clean-up summary go by cascade). Records go last so any failure leaves the app, marked, to retry from; every step can be repeated. A
  failure is written to `apps.delete_error` (also for a job that stalled when the worker died) and the dashboard shows it with **Try
  again** (the same DELETE again). While marked, deploy, rollback, prune, start/stop/restart, retention and settings answer 409 `deleting`,
  webhook pushes are skipped ("The app is being deleted"), and the list and app page show Deleting… / Delete failed; when the app
  finally disappears the open page returns to the list with "App deleted". A container made from the app's image inherits the image's
  labels, so it counts as the app's and is removed with it; an image held by a container that does NOT carry the app's labels makes the
  deletion fail with a message (checked for real, then fixed by removing that container and pressing Try again). **Automatic host
  port:** leave the host port empty when creating an app and the lowest free port in `PORT_RANGE` is used (default `20000-20999`: above
  the ports databases and dashboards use, e.g. 9000 Portainer, 9090 Prometheus, and below Linux's temporary ports from 32768; set
  `PORT_RANGE=a-b` in `.env` to change it; checked at startup). The unique index decides races (the loser picks again); a full range is a
  409 `no_free_port` with a message. Only Shipdok's own apps are known: a port used by something else on the machine is not seen.
  Checked for real: auto ports 21000 and 21001 from a custom range, the full range explained, delete of a running app (container, three
  images, runtime log and all records gone, other apps untouched), the failure with a stuck image and the retry. Not tested: deleting while
  a collector is mid-write on a very chatty app, a delete that stalls the worker, ARM64. Known limit: the collector's connection is closed
  by `release` but a fake Docker cannot show that.
- **Live CPU and memory (verified against real Docker and a real browser in an isolated compose project):** the worker's sampler
  (`stats.js`, its own loop, every `STATS_INTERVAL_MS`, default 15 s, all running apps at once because Docker takes about a second per
  reading) asks Docker for each running live container's numbers and stores them in `app_stats` (migration 014); readings older than an
  hour are deleted on every round, so the table stays small on the Pi. CPU is the share of ONE processor like `docker stats` (above
  100% when more than one is busy; null, shown as a dash, when Docker has no earlier sample to compare with); memory leaves out the file
  cache the kernel can take back (cgroup v2 `inactive_file`, v1 `total_inactive_file`) and comes with the container's limit.
  `GET /api/apps/:id/stats` (`?minutes=1..60`, default 60) gives `{latest, samples:[{t,cpu,memory}]}`; `latest` is null when the newest
  reading is older than 90 s (app stopped or worker quiet: an old number would be a lie), the samples still show what there was.
  `GET /api/apps` and `/api/apps/:id` carry the same `stats` (latest or null). Dashboard (administrator's choices: a chart, and the
  numbers on the app page AND on each card in the list; no memory warning): an Overview "Resource use" card with CPU and memory now,
  the share of the memory limit, and two shadcn/Recharts area charts of the last hour (memory axis ends at the limit, dashed line;
  the CPU axis is at least 0-100%); the apps list shows "CPU x% / Memory used of limit" on running apps. The charts library is loaded
  only when an Overview opens (the bundle is about 900 kB with it). Checked for real: a CPU burst inside a running container showed as
  about 100% in the card and as a curve in the chart, the memory figure against the 512 MB limit, the list card, no console errors.
  Not tested: ARM64, hundreds of apps (readings are taken all at once), cgroup v1 hosts (only unit-tested), a window left open for
  hours. Known limits: with no memory limit set Docker reports the host's memory as the limit (apps created through Shipdok always
  have one); the shadcn CLI again installed the unrelated npm package `cn` (removed, `chart.jsx` imports `@/lib/utils`).
- **Worker git ignores the admin's git config** (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`): a credential helper such as
  Git Credential Manager can otherwise open a window and hang a refused clone.
- **Pi:** early prototype ran on the Pi (ARM64 builds work). The full stack has not been run on the Pi.

## Next

Direction decided by the administrator and now written into SPEC.md (section 4 password policy and recovery codes, section 5 Connect
GitHub, section 8 "Public exposure", section 20 Milestone 6): Shipdok does NOT ship or manage a tunnel (no `cloudflared`). One admin
account only. No two-factor login; instead a strong password policy, progressive lockout, recent logins and recovery codes. The
administrator provides a public address (own IP, or Nginx / Nginx Proxy Manager / Caddy, possibly behind a tunnel they run) and picks
`SHIPDOK_PUBLIC=off|webhook|full` with `PUBLIC_URL`. Goal: `docker compose up`, log in, press "Connect GitHub", install the app, deploy
private repos. No periodic polling. Caddy is an optional, low-priority profile only.

Build order (SPEC.md Milestone 6):
1. Password policy and strength guidance (min 12, common-password list, passphrase generator), progressive lockout per account and
   address, recent-logins list, "sign out everywhere".
2. Recovery codes (10, hashed, single use, shown once) and a host-side password reset command.
3. Public address support: `SHIPDOK_PUBLIC`, `PUBLIC_URL`, trusted proxies and the real client address (the dashboard's nginx must keep an
   address a trusted proxy supplies), `webhook` mode answering 404 except the webhook, docs with Nginx / Nginx Proxy Manager / Caddy.
4. Connect GitHub (App Manifest flow, credentials encrypted in the DB, `.env` still overrides, Disconnect), using the public address.
5. First-run secrets generated into a protected volume (`.env` still overrides).
6. Ready-made multi-arch images (amd64 + ARM64) on GitHub's container registry via GitHub Actions; compose pulls instead of builds.
7. Pi: full-stack run on the published images (ARM64, firewall vs the health-check path, `DOCKER_GID`), hardening, docs (public
   address options, upgrade, backup), API docs (Scalar).
8. Optional: Caddy compose profile for people without a proxy.

Known gaps: no audit/rate limit on `reveal`; old `shipdok/*` images pile up until the administrator prunes (or turns on `auto_prune`); no "clean build cache" action; build-time env vars; Railpack; DB backup docs.
The portfolio backend (`tianyu-00/TianYuSiteV2`, `backend/`, port 9090) is not yet deployed through the platform.
