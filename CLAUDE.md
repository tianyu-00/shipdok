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
  migrations/    001_init ... 031_volume_backups
  src/           app.js, config.js, deployments.js (supersede/cancel/rollback requests), control.js (start/stop/restart requests), disk.js (free-space levels), images.js (which versions keep an image), ports.js (automatic host ports), lockout.js (sign-in lockout and attempt record), recovery.js (recovery codes), version.js (running version and newest published one), openbackup.js (opens a backup file on the host),  resetpassword.js (host-side reset), authutil.js, settings.js + publicurl.js (public-access settings), visitor.js (local or outside), middleware/ (originCheck, publicAccess, requireAuth), routes/ (auth, recovery, settings, apps, env, webhooks, github, logs, volumes, buildcache, backups, images, version)
  openapi/       API documentation: operations/*.js (one description per route), schemas.js, build.js, inventory.js (real routes), generate.js, openapi.json (generated, committed)
  scripts/       send-webhook.js (signed fake webhook; `npm run webhook`), reset-password.js (host-side password reset; `npm run reset-password`), open-backup.js (decrypt and unpack a backup file for a restore)
apps/worker/     BullMQ worker, dockerode, Postgres; node:test
  src/           deploy.js, docker.js, git.js, gitauth.js, process-job.js, control.js, dispatch.js, supervisor.js (pure crash/health rules), prune.js (image clean-up), deleteapp.js (removing an app), stats.js (CPU and memory samples), monitor.js, activity.js, buildlog.js (the log sink), buildcache.js (Docker's build cache: size and clean-up), buildenv.js (build-time variables for docker build), volumesize.js (sizes of the persistent volumes, measured on request), railpack.js (apps built with Railpack: plan, docker build of the plan, labels), static.js (static sites: the Dockerfile Shipdok writes, nginx or Caddy), backup.js (making a backup of Shipdok itself), volumebackup.js (making a backup of an app's volumes), backuprunner.js (answers backup requests, the schedule, keeping the newest, stopping an app for its copy), version.js, runtimelog.js (collects the app's output), dockerlogs.js (Docker log frames), envvars.js, db.js, reconcile.js, paths.js
  worker.js      entry point; cli.js: manual deploy
apps/web/        Vite + React (JavaScript) dashboard, Tailwind v4 + shadcn/ui (copied into src/components/ui); Vitest + Testing Library
  src/           App.jsx, pages/ (auth, apps list, create app, app detail), components/ (tabs, log viewer, actions), lib/ (api client, queries, format)
  nginx.conf, Dockerfile   production image: nginx serves the build and forwards /api to the API
packages/shared/ @shipdok/shared: crypto (AES-256-GCM), backupcrypto.js (passphrase encryption of a backup file), backupstore.js (backup file names, schedule maths), .env parser, github.js (app JWT, installation tokens), logstore.js (log format, masking, safe read/delete), constants
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
`LOG_DIR` is set by compose to the `shipdok_logs` volume (outside Docker it defaults to `~/.shipdok/logs`); `BACKUP_DIR` likewise to the `shipdok_backups` volume (default `~/.shipdok/backups`), and `BACKUP_POSTGRES_CONTAINER` names Shipdok's own Postgres container when the worker cannot find it itself. **`DOCKER_GID` is gone.**

Tests: API 1426, worker 815, shared 290, web 1277. Worker tests reuse the `_test` database the API tests create and
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
- Before pushing to `publish`: `npm run check-images` (the workflow itself runs only there). If it fails with "error getting credentials", Docker's credential helper (a Windows one, through WSL) is unreachable, the same fault that breaks `git push`; it is not the Dockerfile.
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
- **Connect GitHub (several apps):** GitHub App credentials live ONLY in the dashboard, encrypted in the DB (`github_apps`, one row per app, **no limit**; the secrets are bound to their field AND the
  row id; the app from before there could be several keeps the old binding via `legacy_context` until it is saved again); the manifest flow creates another private `Shipdok-xxxx` app each time, or
  enter one by hand (the same GitHub App entered again replaces its credentials, same id); disconnecting one needs the password and the dashboard lists the projects that use it first;
  `createGithubProvider` serves both API and worker (`client(id)`, `clients()`, `webhookSecrets()`). **Each project is assigned to ONE app (`apps.github_app_id`, create form and Settings tab; none = a
  public repository deployed by hand)**: that app lists the repositories and branches, clones a private repo (job field `githubAppId`) and its pushes deploy the project. Installation ids belong to one app, so
  they are looked up again (best effort, a warning, never a block) whenever the assignment changes, and removing an app leaves its projects with no app and no installation. **Decisions: one app's
  repositories at a time (chosen first), disconnect allowed with a list of the affected projects, a push deploys only the projects of the app that sent it (the signing secret says which), no limit.**
  Old `GITHUB_*` env settings are ignored with a log warning. Still untested with the real github.com button: the confirmation, the conversion, installing, a push through the new app, and two real apps.
- **First-run secrets:** `docker compose up -d` works with no env file. A one-shot `secrets` service writes missing secrets into the `shipdok_secrets` volume (0444, never
  overwritten); every process loads `<NAME>_FILE` into `<NAME>` at start and **an environment value always wins**. The setup token is generated, printed in the API log and
  asked for on the setup screen only while no admin exists. The worker has no `DOCKER_GID`: its entry script reads the socket's group, sets `HOME=/home/node`, drops to `node`.
  Back up the database and `shipdok_secrets` together.
- **Webhooks:** `POST /api/webhooks/github` raw-body HMAC (constant time; a refused signature leaves ONE log line a minute per sender naming GitHub's app number from `X-GitHub-Hook-Installation-Target-ID` and whether Shipdok has that app, nothing stored; the dashboard's GitHub page shows the same from an in-memory record: `refusedPush` on the app, `unknownSenders` for apps not connected here, cleared by a good delivery, by entering/removing the app, after a day, or dismissed with `DELETE /api/github/refusals/:sender`: a Dismiss button on the unknown-sender notices), dedupe by delivery id, branch filtering, stopped apps skipped, exact-commit build with strict hex
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
- **Env vars:** AES-256-GCM bound to `env:<appId>:<name>`; masked API, reveal only via POST; values never in jobs, logs, errors or snapshots (masked `***` in logs). Each has a
  `scope`: `runtime` (default), `build` (only `docker build --build-arg NAME`, value in docker's own environment never on the command line, which holds none of the worker's
  secrets) or `both`; the Dockerfile must declare `ARG NAME`; a used build argument is baked into the image (documented; public settings only). Names that change how the build
  runs (`PATH`, `HOME`, `DOCKER_*`, `BUILDKIT_*`, `LD_*`...) are refused for build. A variable can be renamed (`PUT /env/:key` with `newKey`: the server decrypts and
  encrypts again for the new name in one transaction, 409 `name_taken`; the value never leaves the server). A variable that reaches the build is passed either as a build argument (`build_as` `arg`, the default) or as a **BuildKit secret** (`secret`: `--secret id=NAME,env=NAME`, value again only in docker's environment, never stored in the
  image; the Dockerfile asks with `RUN --mount=type=secret,id=NAME,env=NAME`; BuildKit does not put a secret in the cache key, so a changed one does not re-run a cached step: documented, use Deploy without cache).
  **Decisions: both ways exist (a second "Passed to the build as" choice, shown only when the variable reaches the build); an import is runtime-only and never changes either choice.**
- **Build method (Dockerfile or Railpack):** `apps.build_method` (default `dockerfile`) plus optional `install_command`, `build_command`, `start_command` (Railpack only, one line each, kept when switching back; in the snapshot, so pending like other build settings). With Railpack (`worker/src/railpack.js`) `railpack prepare` writes a plan and the same `docker build` builds it through Railpack's BuildKit frontend (version taken from the installed binary); every build variable is a BuildKit secret (the plan gets a placeholder, never a value; so a variable cannot change the plan, and `RAILPACK_*` variables are left out); the install command travels as the secret `RAILPACK_INSTALL_CMD`; the frontend ignores `--label`, so a second instant build adds the ownership labels plus `shipdok.build-method=railpack` (first build under a temporary tag that is removed, else Docker's classic store leaks the unlabelled image); a Railpack app gets `PORT` = container port (a rollback decides by the OLD image's label). The binary is pinned and checksum-checked in `apps/worker/Dockerfile` (change the version AND both checksums). Commands run only inside the build. **Decisions: explicit per-app choice even when a Dockerfile exists; commands are fields of the Railpack method, no third engine; `PORT` set for Railpack apps; build variables are secrets.** Checked on the Pi (ARM64) by the administrator: the front end of `tianyu-00/TianYuSiteV2` is deployed through it and works.
- **Static site (third build method):** `apps.build_method = 'static'` plus `output_dir`, `node_version`, `spa_fallback` (default true) and `static_server` (`nginx` default | `caddy`), and the same `install_command` / `build_command` (both optional; neither = nothing is built and the folder is served as it is); migration 029. `worker/src/static.js` writes the Dockerfile OUTSIDE the clone (the repository's own is not used) and runs one `docker build` with the ownership labels plus `shipdok.build-method=static` given directly (no second build): stage 1 `node:<version>-bookworm-slim` (Corepack on; commands as RUN lines with every build variable mounted as a BuildKit secret; a `test -d` of the output folder with a readable message), stage 2 `nginxinc/nginx-unprivileged:1.29-alpine` or `caddy:2.10-alpine` with a configuration written by the worker, the folder copied in, run as a normal user; `.git` kept out of the build by a `.dockerignore` next to the Dockerfile; **both servers refuse every dot file/folder** (`.env`, `.git`; `.well-known` allowed; Caddy's `route` forces that rule before the fallback). The folder, Node version and port are written into the Dockerfile only after a strict pattern check (the API and the database check them too). A static site's `container_port` must be 1024 or more (no root; API 400 on create and edit, checked against the result of an edit); no `PORT` is set for it; a rollback goes by the old image's label. The wizard's Static card fills in port 8080, 128 MB, `npm ci`, `npm run build` and `dist` (only what is still at its starting value; leaving the method puts back only what it filled in; `lib/build-methods.js` `methodChanges`). **Decisions: Shipdok's own Dockerfile, not Railpack (a variable cannot change Railpack's plan); the administrator chose that the web server is a setting (nginx or Caddy), a Node version field, and the single-page fallback on by default; build variables are secrets.**
- **Backups of Shipdok itself (the Storage page's "Backups of Shipdok" card):** ONE file = the database dump + the secrets volume (the encryption key; the dump is useless without it) + a manifest, as a tar, optionally encrypted with a passphrase (AES-256-GCM, scrypt key, `shared/backupcrypto.js`; `.tar.enc`). The worker makes it (`backup.js`): `pg_dump --format=custom` run INSIDE the Postgres container through `docker exec` with the container's own environment (the worker image has no Postgres client and needs no database password), found as the compose service `postgres` of the worker's own project (`BACKUP_POSTGRES_CONTAINER` overrides; more than one match without a project is an error, never a guess), read back with `pg_restore --list` (**a dump that cannot be read is not a backup**), built in a temporary folder inside the backups folder and moved into place at the end (never a half file), mode 0600, the temporary folder removed on failure; a missing secrets folder still makes the backup but with a warning. **Asking** = a row in `backups` (`queued`, one unique index allows ONE queued or running at a time); the worker's `backuprunner.js` polls every 3 s BESIDE the queue (a backup never waits behind a build), the schedule is checked once a minute (`isBackupDue`: the latest slot passed since the last backup STARTED and since the schedule was last changed; after downtime ONE backup, not one per missed slot); a backup that was running when the worker stopped is marked failed. Schedule and passphrase are `settings` rows (`backup_schedule`; `backup_passphrase` encrypted with the platform key and bound to `backup:passphrase`, so scheduled backups can use it; an unreadable stored passphrase FAILS the backup, **never a plain one by surprise**). `/api/backups`: list + settings + `persistent` (is the folder a volume of its own, by comparing devices inside a container), `POST` (409 `already_running`), `PUT /settings`, `PUT /passphrase` (password), `POST /:id/download` (password in the BODY, recorded in the sign-ins list as `download`, passphrase changes as `backup`), `DELETE /:id`; file names are strict (`shipdok-backup-<UTC>-<8 hex>.tar[.enc]`, also a database CHECK) so no path can come from a row. Retention: keep the newest N good ones (1 to 60, default 7) and the newest 10 failed. Compose: volume `shipdok_backups` in api (lists, serves, deletes) and worker (writes); both images create the folder owned by `node`. Restore stays a documented procedure (`scripts/open-backup.js` decrypts and unpacks into a new empty folder, files 0600, only the three known names are extracted). **Decisions: `docker exec` for the dump; an optional passphrase (recommended) the person must remember, with a "written it down" box; automatic backups ON by default (daily 03:00 UTC, keep 7, hour in UTC with the local time shown; the first one is made soon after the worker first starts), all adjustable on the Storage page (off, daily, weekly, hour, keep); the card is on the Storage page; no automatic copy off the machine (Download is the way); volume backups were added afterwards (next entry).**
- **Backups of an app's volumes (a second kind in the same list; the "Backups of your apps' data" card):** one file per app = a tar per MOUNTED volume + a manifest, optionally encrypted with the same passphrase (`volumebackup.js`). The worker creates a helper container (created, never started, from the app's own image, no network) that mounts the volumes READ-ONLY and streams them out with Docker's archive call; every tar is read back and must not be empty; the helper is always removed (stale ones at worker start). Room check first: twice the data (last measurement, else asked of Docker) and 10% of the disk must stay free, else the backup fails with the sizes in the message. Per app (columns on `apps`): `volume_backup_enabled` (in the schedule, default OFF), `volume_backup_stop` (default off; on = stop the app through `controlApp`, copy, start again whatever happened unless the administrator stopped it meanwhile; refused when `activity` says a job is working on the app; a failed start is a warning on the backup), `volume_backup_keep` (1-60, default 3, counted per app; a deleted app's backups stay, found by `app_name`). Scheduled ones use Shipdok's own schedule with a per-app once-per-slot rule (`requestVolumeBackupsIfDue`; switching an app on never backs up a slot that already passed). One waiting or running backup per kind and app (unique index); `backups.kind` platform|volumes; file names `shipdok-volumes-<UTC>-<8 hex>.tar[.enc]` (never the app's name). Restore is documented (`open-backup.js` opens it, then `tar xf` into an empty volume). **Decisions: live copy by default with an optional stop per app; opt-in per app for the schedule; keep per app (default 3); refuse on low disk.**
- **Start / stop / restart:** intent saved first (`desired_state`), then a `control` job; a stopped app stays stopped when deployed unless `start: true`.
- **Crash handling:** the monitor (15 s) compares `desired_state` with Docker (pure rules in `supervisor.js`): crash restarts with back-off, `max_restarts` in 10 min = `crashed`,
  3 failed health checks = `unhealthy` (left running), a stop from outside Shipdok is NOT restarted, a removed container is `missing` (**decision: show it, do not recreate it**).
- **Logs:** a build log per deployment (kept until the deployment is deleted); ONE runtime log per app plus the run before it, reset on every restart or new deployment
  (**decision**); secrets masked; capped; deleting logs is always an explicit action.
- **Images and rollback:** keep the live image plus `keep_previous_images` (default 1); prune on request or, for a NEW app, automatically after each successful deployment (`auto_prune` now defaults to true; **decision: old apps keep their setting**), never touching logs or volumes; **the Storage page's Old images card** (`/api/images`: total and per-app reclaimable bytes, Clean up old images = one prune job per app, Turn auto clean-up on/off for every app, a user-set size in GB at which a notice shows on the apps list and the Storage page, **default never**); a deployment that built but failed its health check removes its own image at once (not after a failed swap, never a reused rollback image); rollback runs an
  existing image with no clone or build and never deletes a reused image; deployments over 10% free disk need `ignoreDiskWarning`.
- **Deleting an app:** exact name typed; removes containers, images and logs but **keeps its volumes by default**; recorded webhook deliveries stay; the worker does it, records last.
- **Persistent storage:** Docker named volumes `shipdok-vol-<uuid>` per container path (Settings tab only). The candidate gets THROWAWAY volumes; the real ones are created only
  after it passed. Removing a path DETACHES (data kept); a volume is deleted only on an explicit request; `removeVolumeStrict` requires our name AND the `shipdok.managed` label.
  Persisting the code folder (`/app`) hides new code: a soft warning, not a block. Adopting an orphaned volume into another app is out of scope.
- **Volume sizes:** measured ON REQUEST only (Docker walks every file, seconds on a Pi): `POST /api/volumes/sizes` records the request (`volume_sizing`, one row, an unanswered request stops blocking after 30 min), the worker's `volumesize.js` notices it (a 3 s poll, NOT a queue job, so it never holds a deployment up), asks Docker once (`GET /system/df?type=volume`) and writes `app_volumes.size_bytes/measured_at`; `GET /api/volumes/sizes` says how it stands; the sizes show on the Storage page (Volumes column, in each total), in Settings under each path and for kept volumes. **Decision: on demand, not continuous.**
- **Build time limit:** per-app `build_timeout_minutes` (5 min to 7 days, NULL = unlimited, the default); covers clone and build only; a timeout is a failure.
- **Build cache:** shared by all builds, so one row (`build_cache`) and global actions: the worker samples its size every 5 min and cleans on request (`cleancache` job: "unused" =
  not used for 24 h, or everything unused); only build cache is touched. `noCache: true` on a deployment request builds that one deployment with `--no-cache` (not a setting, not for
  webhooks or rollbacks).
- **CPU and memory:** the worker samples running apps every `STATS_INTERVAL_MS` (15 s), keeps an hour, `latest` is null when older than 90 s.

**Dashboard, docs and delivery**
- **Dashboard:** Vite + React (JavaScript), Tailwind v4, shadcn/ui (copied into `src/components/ui`; the shadcn CLI wrongly installs an unrelated npm package `cn`, remove it), React
  Router, TanStack Query. Same origin: nginx serves the build and forwards `/api`. Pages: login/setup, apps list, create app, app detail (Overview, Deployments, Images, Logs, Variables,
  Settings), Storage, GitHub, Security, API reference link. **Logs are a console, not a dialog:** pressing a deployment row (or its Log icon) expands its build log right under it (several can be open; the actions are icon-only with tooltips and names; `LogViewer` is shared with the app's
  Logs tab), follows the theme (a pale console on a light page, a dark one on a dark page; **decision: first built always-dark, which looked out of place on a light page**); lines are coloured by what they SAY (`lib/logtone.js`: BuildKit steps, DONE/CACHED, errors, warnings, Shipdok's own lines), never by stream
  (docker writes all its normal progress to stderr, so stderr is not red); toolbar: **find** (Ctrl+F style: every line stays visible, matches highlighted, "3 of 12", Enter / Shift+Enter or arrows step through and scroll the current match to the middle; **decision: a find, not a filter**, so the lines around a match stay readable), copy the log, download the loaded lines, follow switch, "Latest". Theme Light/Dark/System (dark is near-black, never pure black).
- **Not deployed yet:** creating an app only saves it; nothing is built until Deploy. An app with no deployment at all (`latest_deployment` is exactly `null`, on the list AND in the single-app answer; a missing field claims nothing; it goes away with a first deployment of any outcome) shows a "Not deployed yet" badge with "Open it and press Deploy when ready" on the apps list, a notice above the tabs on its page, and the toast after creating it says so.
- **Create-app wizard (three steps):** (1) **GitHub app first** (or None for a public repository; with several apps none is chosen for you), then the repository (the searchable list or a pasted link, below), then Shipdok CHECKS it can see it (`GET /api/github/repo-check?repo&app[&fresh=1]`: one request to GitHub, through the chosen app's installation or anonymously; always HTTP 200 with `accessible` true/false and a reason `not_found` | `rate_limited` | `unreachable`; good answers kept 60 s per app and repository, failures never; **a private repository and a missing one look the same to GitHub, so the message says both**; no app chosen: "connect a GitHub app"; app chosen: "install it on the repository" with the install link and Check again; a public repository without an app, or with an app that is not installed on it, is accepted with a note that pushes will not deploy it); Continue only when it is seen; the repository and app chosen are kept in this tab (`create-draft.js`, an hour) so connecting an app on GitHub and coming back loses nothing. (2) **Folder and build method**: the folder is typed (default `.`) and the method is chosen from cards, **Railpack preselected (default)**, Dockerfile, and Static site (**Nixpacks is not offered: decided not to build it, it is in maintenance mode**). **Decisions: the repository's contents are NEVER scanned or guessed from (no file tree, no suggestions; the administrator reconsidered the detection that was first planned); the method is the person's choice, Railpack by default; Docker Compose is out of scope (it collides with the one-container model).** (3) the other settings (the old form without repository, folder and method, which can each be changed from there). The check also gives the default branch, used before the branch list loads.
- **Version and updates:** the header shows `v<version>` beside the logo (under it on phones, where the badge is an icon and the API link is hidden) and a blue "Update available" badge when a newer release is published; pressing it says a new update is available with a link to GitHub releases for the changes (**decision: no update commands shown; Shipdok never updates itself**) and a Check now button. The apps list shows a notice "Shipdok X is available" with Details and **Dismiss** (remembered per version in this browser's localStorage; a newer release shows it again; the badge stays). `GET /api/version` (`?fresh=1`) = the `VERSION` file (copied into the API image) against the highest plain `x.y.z` tag of `ghcr.io/tianyu-00/shipdok-api`, read anonymously from the registry (**the repository is private, so GitHub Releases cannot be read without a login; the public image can**); asked only when someone asks, kept 1 h (5 min after a failure, `fresh` at most twice a minute), never in the background, a failed look is a 200 with `error`.
- **Repository field:** a searchable list in a popover (`RepoPicker`, on the shared `Combobox` that the branch picker uses too) of the repositories the GitHub App can see, alphabetical, each marked private or
  public; typing an `owner/name` (or pasting a GitHub link) offers "Use ...", which is how a public repository the app is not installed on is chosen. A pasted link (`lib/repo.js` `parseRepoInput`:
  `https://github.com/o/r`, with or without scheme or `www.`, a trailing `/` or `.git`, a `/tree/...` or `/pull/...` page, `git@github.com:o/r.git`, `ssh://`) is understood in the list's search box and in the
  plain text box used when no GitHub App is connected or the list cannot be loaded (there: converted at once on a paste, on leaving the field for a link typed key by key). Only github.com counts.
  **The API is unchanged and strict (`owner/name` only); the clone address is still built server-side.** (The native `<input list>` dropdown it replaced looked out of place.)
- **Branch picker:** the Branch field (create form and Settings tab) is a searchable list of the repository's real branches with the default marked (`BranchPicker`, hand-written
  `ui/popover.jsx`; **decisions: searchable list, public repos the app is not installed on are listed anonymously, names only with the default marked**); a name that is not in the list can
  still be used ("Use ..."), and if the branches cannot be listed the field is the plain text box again, so typing always works. `GET /api/github/branches?repo=owner/name` (shared
  `listRepoBranches`: default first, rest alphabetical, first 500; uses a token for that one repository, read-only, when the app is installed, otherwise no token, which works for public
  repos and when NO app is connected; 404 `repo_not_found`, 502 `rate_limited`; good answers kept 60 s). The repo is asked of GitHub only after it has settled for 400 ms.
- **API reference:** `/api/docs` (Scalar, served locally, signed-in only, `API_DOCS=false` turns it off). Descriptions live in `apps/api/openapi/operations/`; tests fail when a route has
  none or `openapi.json` is stale. Deviation from SPEC.md: swagger-autogen was rejected, `inventory.js` records the real routes instead.
- **Images and releases:** `.github/workflows/images.yml` builds api, worker, web for amd64 + arm64; only a push to `publish` runs it (a push to `main` or a PR runs nothing: it only used up Actions minutes; run `npm run check-images` (scripts/check-images.sh: builds api, worker, web here and runs the same secret check; `-- worker` for one, `KEEP=1` keeps the images; this machine's architecture only) before publishing) and it publishes to
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
- (Decided NOT to build Nixpacks: it is in maintenance mode, last release 1.41.0 in Oct 2025, and Railpack is its successor. Its "Coming soon" card was removed from the wizard.)
- Caddy compose profile (optional).

Known gaps: backups are made on this machine only (copy them off with Download; no S3 or similar yet), a restore of an app's volumes is a documented procedure, not a button. The portfolio backend (`tianyu-00/TianYuSiteV2`, `backend/`,
port 9090) is not yet deployed through the platform.
