# Shipdok

Self-hosted single-host PaaS (GitHub repo -> one Docker container per app, auto-deploy on push) for one administrator.
Target: Raspberry Pi 4 (8 GB, ARM64), developed on WSL2 Ubuntu. JavaScript (not TypeScript), Node 22, ES modules,
npm workspaces. Private LAN/VPN only; only the GitHub webhook path is ever exposed (Cloudflare tunnel).
Full product spec: SPEC.md (the target design). Do not edit it as features get built.
This file records what is actually built (the short version; the full verification record is docs/built.md); if the two disagree about what exists, this file is right.
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
- When a route is added, renamed or removed, describe it in `apps/api/openapi/operations/` and run `npm run openapi -w apps/api`; a test fails
  until the documentation and the routes agree (and until `openapi.json` is regenerated).
- When an environment setting is added, renamed, removed or gets a new default, update `.env.example` in the same change, with a
  comment above each setting saying what it does and its default. Keep every value commented out.
- When a feature is finished and tested, in the same commit: add the full entry (how it was checked, what was NOT tested, known limits) to docs/built.md,
  a SHORT entry (what exists, my decisions, the invariants; a few lines) under "What is built" here, and update "Next" and the test counts.
  Never edit SPEC.md unless I ask.
- My `jar.txt` login cookie expires after 30 minutes idle; odd "`.map is not a function`"/"`undefined`" from curl+node
  one-liners usually means that.

## Layout

```text
apps/api/        Express 5 API, Postgres, sessions in Postgres, BullMQ producer; Jest + Supertest
  migrations/    001_init ... 022_build_cache
  src/           app.js, config.js, deployments.js (supersede/cancel/rollback requests), control.js (start/stop/restart requests), disk.js (free-space levels), images.js (which versions keep an image), ports.js (automatic host ports), lockout.js (sign-in lockout and attempt record), recovery.js (recovery codes), resetpassword.js (host-side reset), authutil.js, settings.js + publicurl.js (public-access settings), visitor.js (local or outside), middleware/ (originCheck, publicAccess, requireAuth), routes/ (auth, recovery, settings, apps, env, webhooks, github, logs, volumes, buildcache)
  openapi/       API documentation: operations/*.js (one description per route), schemas.js, build.js, inventory.js (real routes), generate.js, openapi.json (generated, committed)
  scripts/       send-webhook.js (signed fake webhook; `npm run webhook`), reset-password.js (host-side password reset; `npm run reset-password`)
apps/worker/     BullMQ worker, dockerode, Postgres; node:test
  src/           deploy.js, docker.js, git.js, gitauth.js, process-job.js, control.js, dispatch.js, supervisor.js (pure crash/health rules), prune.js (image clean-up), deleteapp.js (removing an app), stats.js (CPU and memory samples), monitor.js, activity.js, buildlog.js (the log sink), buildcache.js (Docker's build cache: size and clean-up), runtimelog.js (collects the app's output), dockerlogs.js (Docker log frames), envvars.js, db.js, reconcile.js, paths.js
  worker.js      entry point; cli.js: manual deploy
apps/web/        Vite + React (JavaScript) dashboard, Tailwind v4 + shadcn/ui (copied into src/components/ui); Vitest + Testing Library
  src/           App.jsx, pages/ (auth, apps list, create app, app detail), components/ (tabs, log viewer, actions), lib/ (api client, queries, format)
  nginx.conf, Dockerfile   production image: nginx serves the build and forwards /api to the API
packages/shared/ @shipdok/shared: crypto (AES-256-GCM), .env parser, github.js (app JWT, installation tokens), logstore.js (log format, masking, safe read/delete), constants
infrastructure/  compose.yaml (Postgres 16, Redis 7; secrets (one-shot), api, worker, web services), compose.build.yaml (build from source), compose.dev.yaml (publishes Postgres/Redis for npm development), .env (never committed)
apps/api/Dockerfile, apps/worker/Dockerfile, apps/web/Dockerfile, .dockerignore   images built from the repo root (see "Run it")
```

## Run it

```bash
docker compose -f infrastructure/compose.yaml -f infrastructure/compose.dev.yaml --env-file infrastructure/.env up -d postgres redis
npm run migrate -w apps/api
npm run dev -w apps/api          # API on 127.0.0.1:4000
npm start -w apps/worker         # reconciles on boot, then waits for jobs
npm run dev -w apps/web          # dashboard on http://localhost:5173 (Vite forwards /api to the API on 4000)
npm test                         # API (Jest), worker (node:test), shared (node:test), web (Vitest)
```

Or run the whole platform in Docker instead (do not mix with the npm commands above; both would use port 4000 and one queue).
Develop with npm: start only the data services, with the dev override that publishes them on loopback (`compose.dev.yaml`; a normal install publishes no database port). A bare `up -d` starts api, worker and web too. Run compose from the same folder every time (volumes are named after the folder).

```bash
docker compose -f infrastructure/compose.yaml up -d                  # no .env needed (see "What is built" below); pulls the published images
docker compose -f infrastructure/compose.yaml -f infrastructure/compose.build.yaml up -d --build   # build from this checkout instead
docker compose -f infrastructure/compose.yaml logs api               # the first-run setup token is printed here
```

Optional compose settings (all have defaults; put them in `infrastructure/.env` and pass `--env-file infrastructure/.env`, or export them; NOTE
compose reads a `.env` that sits next to the compose file even without `--env-file`, use `--env-file /dev/null` to ignore it, as the isolated
test projects do): `POSTGRES_USER`/`POSTGRES_DB` (default `shipdok`), `API_HOST_PORT` (default 4000, loopback), `API_DOCS` (the API reference at `/api/docs`, default on), `WEB_HOST_PORT` (default 8080) and
`SHIPDOK_VERSION` (image release, default `latest`), `WEB_BIND` (default 127.0.0.1; `0.0.0.0` or this machine's address to reach the dashboard from other devices), `PORT_RANGE` (default
`20000-20999`), `SHIPDOK_PUBLIC`, `PUBLIC_URL`, `COOKIE_SECURE` (default `auto`), `WEB_ORIGIN` (optional extra origins; the dashboard accepts
requests from whatever address it is opened at), `MONITOR_INTERVAL_MS`, `STATS_INTERVAL_MS`, and the four secrets below (your value wins).
`LOG_DIR` is set by compose to the `shipdok_logs` volume (outside Docker it defaults to `~/.shipdok/logs`). **`DOCKER_GID` is gone.**

Tests: API 974, worker 594, shared 232, web 618. Worker tests reuse the `_test` database the API tests create and
migrate, so run the API tests first on a fresh machine. Tests refuse to touch any DB not ending in `_test`.
`infrastructure/.env` is now needed only for development with npm (`POSTGRES_*`, `REDIS_PASSWORD`, `SESSION_SECRET`, `APP_SECRETS_KEY`: 64 hex, losing
it makes stored secrets unrecoverable) and for the optional settings above. **The GitHub App is NOT configured here any more** (dashboard,
GitHub page; see "What is built").

## Testing notes

- A throwaway database for the tests (the name must end in `_test`, the suites create it): `docker run -d --name shipdok-testdb -e POSTGRES_USER=shipdok -e POSTGRES_DB=shipdok -e POSTGRES_PASSWORD=testdb-password-only -p 55432:5432 postgres:16`,
  then `env POSTGRES_PASSWORD=testdb-password-only POSTGRES_PORT=55432 npm test`. Never pipe the whole run through `head` (it cuts the later suites off).
- Real-Docker and browser checks run in an isolated compose project (`COMPOSE_PROJECT_NAME=...`, `--env-file /dev/null`, `env -u POSTGRES_PASSWORD`, other ports,
  images renamed with an override so the administrator's own `latest` tags and stack are never touched; anything that needs a Docker daemon the tests may wipe goes to a
  throwaway docker:dind). Compose's build override re-tags the published image names: never run it unprotected on this machine.
- After changing how the worker starts, check a real clone and a real `docker build`, not only `docker ps`.

## What is built

Full record (how each was checked for real, what was NOT tested, known limits): [docs/built.md](docs/built.md). Read the matching entry there before changing a
feature. Below: what exists, the administrator's decisions (do not re-litigate), and the invariants that must not break.

**Accounts and access**
- **Auth:** one admin, argon2id, sessions in Postgres (30 min idle / 12 h absolute), Origin-header check (same-origin, plus optional `WEB_ORIGIN` and the public address),
  rate limits. Change password needs the session AND the current password (wrong one = 403, not 401).
- **Password policy and lockout:** 12-256 characters, no repeated unit, no plain run, no username inside. **Decision: no bundled word lists** (so `password123456` is not
  caught). Lockout per typed name AND per address after 5 failures in a row (30 s doubling, caps 15 min per name, 60 min per address; while locked even the right
  password is refused); advisory locks make the check and record one step. Security page: recent sign-ins, Sign out everywhere.
- **Recovery codes:** 10 at setup (shown once, must be acknowledged), stored as SHA-256 only, each works once, same lockout as login; "Make new codes" needs the password.
  Host reset: `docker compose exec api node scripts/reset-password.js` (prints a new password once, ends all sessions, forgives failed tries). Notice bar at 3 or fewer left.
- **Public access:** modes `local` (default) / `webhook` / `full`, set in the DASHBOARD (Security page, needs the password); `SHIPDOK_PUBLIC` / `PUBLIC_URL` override and lock.
  Fail closed (`visitor.js`): only a connection provably from a private/loopback/VPN address (with a trusted proxy's `X-Forwarded-For` if any) is local; everything else is
  outside and gets a plain 404 (the same as an unknown route) except `POST /api/webhooks/github` in `webhook` mode. The dashboard's nginx (`apps/web/nginx.conf`) passes the real
  visitor through (`real_ip`, `auth_request` to `/api/_visitor`). Never forward the dashboard port straight from a router. Docs with Nginx / Caddy / NPM / tunnel examples:
  `docs/public-access.md`. **The default is `local`, so the Cloudflare-tunnel webhook is blocked until the mode is Webhook only.**
- **Connect GitHub:** GitHub App credentials live ONLY in the dashboard, encrypted in the DB (`github_app`, one row); the manifest flow creates a private `Shipdok-xxxx` app, or
  enter one by hand; replacing or disconnecting needs the password; `createGithubProvider` serves both API and worker. Installation ids belong to ONE app, so entering,
  connecting or disconnecting clears every remembered `apps.github_installation_id`, and the worker re-looks-up a remembered id that answers 404. Old `GITHUB_*` env settings
  are ignored with a log warning. Still untested with the real github.com button: the confirmation, the conversion, installing, and a push through the new app.
- **First-run secrets:** `docker compose up -d` works with no env file. A one-shot `secrets` service writes missing secrets into the `shipdok_secrets` volume (0444, never
  overwritten); every process loads `<NAME>_FILE` into `<NAME>` at start and **an environment value always wins**. The setup token is generated, printed in the API log and
  asked for on the setup screen only while no admin exists. The worker has no `DOCKER_GID`: its entry script reads the socket's group, sets `HOME=/home/node`, drops to `node`.
  Back up the database and `shipdok_secrets` together.
- **Webhooks:** `POST /api/webhooks/github` raw-body HMAC (constant time), dedupe by delivery id, branch filtering, stopped apps skipped, exact-commit build with strict hex
  validation, 503 until an app is connected. A Cloudflare tunnel on the administrator's machine forwards only that path.

**Apps, deployments and the worker**
- **Apps/deployments API:** `repo` is `owner/repo` (clone URL built server-side, repo cannot be edited, nor the slug). Settings are snapshotted per deployment; an edit never touches
  what runs (`running_settings`, `settings_pending`); a deployment or rollback uses the CURRENT settings. Host port empty = lowest free in `PORT_RANGE` (default 20000-20999).
- **Deploy engine:** clone -> build -> candidate on a temp port -> health check -> swap -> retire; a failure leaves the running version untouched. Ownership labels
  `shipdok.managed/app-id/deployment-id/role`. Containers: memory and CPU limits, `PidsLimit: 512`, **deliberately NO `no-new-privileges` and no capability drop**, no host mounts,
  no Docker socket. Git runs with a minimal environment and ignores the admin's git config; the GitHub token reaches git only through `GIT_CONFIG_*` env.
- **Queue:** one BullMQ queue, concurrency 1, no retries, `maxStalledCount: 0`; jobs `deploy`, `control`, `prune`, `removeimage`, `deleteapp`, `removevolume`, `cleancache`
  (`dispatch.js` routes each by name; an unknown name becomes a deployment). Boot reconcile removes orphan candidates/temp clones and marks in-flight deployments `interrupted`.
  The API never touches Docker: it records intent and queues; the worker does the work.
- **Cancel/supersede:** latest wins; the swap is the point of no return.
- **Env vars:** AES-256-GCM bound to `env:<appId>:<name>`; masked API, reveal only via POST; values never in jobs, logs, errors or snapshots (masked `***` in logs).
- **Start / stop / restart:** intent saved first (`desired_state`), then a `control` job; a stopped app stays stopped when deployed unless `start: true`.
- **Crash handling:** the monitor (15 s) compares `desired_state` with Docker (pure rules in `supervisor.js`): crash restarts with back-off, `max_restarts` in 10 min = `crashed`,
  3 failed health checks = `unhealthy` (left running), a stop from outside Shipdok is NOT restarted, a removed container is `missing` (**decision: show it, do not recreate it**).
- **Logs:** a build log per deployment (kept until the deployment is deleted); ONE runtime log per app plus the run before it, reset on every restart or new deployment
  (**decision**); secrets masked; capped; deleting logs is always an explicit action.
- **Images and rollback:** keep the live image plus `keep_previous_images` (default 1); prune only on request (opt-in `auto_prune`), never touching logs or volumes; rollback runs an
  existing image with no clone or build and never deletes a reused image; deployments over 10% free disk need `ignoreDiskWarning`.
- **Deleting an app:** exact name typed; removes containers, images and logs but **keeps its volumes by default**; recorded webhook deliveries stay; the worker does it, records last.
- **Persistent storage:** Docker named volumes `shipdok-vol-<uuid>` per container path (Settings tab only). The candidate gets THROWAWAY volumes; the real ones are created only
  after it passed. Removing a path DETACHES (data kept); a volume is deleted only on an explicit request; `removeVolumeStrict` requires our name AND the `shipdok.managed` label.
  Persisting the code folder (`/app`) hides new code: a soft warning, not a block. Adopting an orphaned volume into another app is out of scope.
- **Build time limit:** per-app `build_timeout_minutes` (5 min to 7 days, NULL = unlimited, the default); covers clone and build only; a timeout is a failure.
- **Build cache:** shared by all builds, so one row (`build_cache`) and global actions: the worker samples its size every 5 min and cleans on request (`cleancache` job: "unused" =
  not used for 24 h, or everything unused); only build cache is touched. `noCache: true` on a deployment request builds that one deployment with `--no-cache` (not a setting, not for
  webhooks or rollbacks).
- **CPU and memory:** the worker samples running apps every `STATS_INTERVAL_MS` (15 s), keeps an hour, `latest` is null when older than 90 s.

**Dashboard, docs and delivery**
- **Dashboard:** Vite + React (JavaScript), Tailwind v4, shadcn/ui (copied into `src/components/ui`; the shadcn CLI wrongly installs an unrelated npm package `cn`, remove it), React
  Router, TanStack Query. Same origin: nginx serves the build and forwards `/api`. Pages: login/setup, apps list, create app, app detail (Overview, Deployments, Images, Logs, Variables,
  Settings), Storage, GitHub, Security, API reference link. Theme Light/Dark/System (dark is near-black, never pure black).
- **API reference:** `/api/docs` (Scalar, served locally, signed-in only, `API_DOCS=false` turns it off). Descriptions live in `apps/api/openapi/operations/`; tests fail when a route has
  none or `openapi.json` is stale. Deviation from SPEC.md: swagger-autogen was rejected, `inventory.js` records the real routes instead.
- **Images and releases:** `.github/workflows/images.yml` builds api, worker, web for amd64 + arm64; a push to `main` or a PR only builds, a push to `publish` also publishes to
  `ghcr.io/tianyu-00/shipdok-*` (tags `latest`, the number in `VERSION`, `sha-<commit>`) and creates the GitHub Release `v<VERSION>`; bump `VERSION` for a new release. `check-image.sh`
  fails an image containing `.env*`, `*.pem`, `jar.txt`. Compose has only `image:` lines; `compose.build.yaml` adds `build:`.
- **No `migrate` service:** the API runs migrations itself at start (advisory lock); the worker waits for a healthy API.
- **Docs:** `README.md`, `docs/public-access.md`, `docs/operations.md` (upgrade, backup, restore, persistent storage, build cache, password reset, troubleshooting), `docs/security.md`
  (residual risks, stated plainly), MIT `LICENSE`.
- **Pi:** the administrator ran the full stack from the published images on a Pi and it works; ARM64 builds work. The Pi runs the version they last pulled (check `VERSION`).

## Next

Nothing from Milestone 6 is left except the optional Caddy compose profile (low priority, for people without a proxy). Shipdok does NOT ship or manage a tunnel. One admin
account, no two-factor login (strong password policy, lockout, recent logins, recovery codes instead). No periodic polling.

Candidates (the administrator picks):
- Caddy compose profile (optional).
- Build-time env vars; Railpack / custom build commands (deploy repos without a Dockerfile; needs a design discussion first).
- Volume sizes on the Storage page (Docker measures slowly, so on demand only).
- Several GitHub accounts or organisations. Option A (small): a checkbox on Connect GitHub that makes the app public so one app can be installed on any account the administrator
  controls, plus an allow-list so a stranger's installation does not show in the repository picker. Option B (large): several separate GitHub Apps (a table, the webhook receiver finds
  the secret from the app id header, a client per app in the worker, merged repository picker). Do A first if the repositories live on more than one unrelated account.

Known gaps: old `shipdok/*` images pile up until pruned (or `auto_prune`); DB backup is a documented manual recipe only. The portfolio backend (`tianyu-00/TianYuSiteV2`, `backend/`,
port 9090) is not yet deployed through the platform.
