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
  migrations/    001_init ... 006_webhooks
  src/           app.js, config.js, deployments.js (supersede/cancel), routes/ (auth, apps, env, webhooks, github)
  scripts/       send-webhook.js (signed fake webhook; `npm run webhook`)
apps/worker/     BullMQ worker, dockerode, Postgres; node:test
  src/           deploy.js, docker.js, git.js, gitauth.js, process-job.js, envvars.js, db.js, reconcile.js, paths.js
  worker.js      entry point; cli.js: manual deploy
apps/web/        empty (dashboard not started)
packages/shared/ @shipdok/shared: crypto (AES-256-GCM), .env parser, github.js (app JWT, installation tokens), constants
infrastructure/  compose.yaml (Postgres 16, Redis 7 on 127.0.0.1), .env (never committed)
```

## Run it

```bash
docker compose -f infrastructure/compose.yaml --env-file infrastructure/.env up -d
npm run migrate -w apps/api
npm run dev -w apps/api          # API on 127.0.0.1:4000
npm start -w apps/worker         # reconciles on boot, then waits for jobs
npm test                         # API (Jest), worker (node:test), shared (node:test)
```

Tests at last commit: API 218, worker 116, shared 118. Worker tests reuse the `_test` database the API tests create and
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
- **Webhooks (verified manually):** `POST /api/webhooks/github` (raw-body HMAC SHA-256, constant time, dedupe by
  `X-GitHub-Delivery`, branch filtering, stopped apps skipped, exact-commit build with strict hex validation).
  History at `GET /api/webhooks/deliveries`.
- **GitHub App auth (tested, not yet run against github.com):** RS256 app JWT; installation tokens scoped to one repo with
  `contents: read`, cached until 5 min before expiry; token reaches git ONLY via `GIT_CONFIG_*` env (never argv/URL/logs/
  `.git/config`); git runs with a minimal environment (no `APP_SECRETS_KEY` etc.); creating an app looks up the
  installation (warns, never errors, if not installed); `GET /api/github/repos` lists installed repos.
- **Pi:** early prototype ran on the Pi (ARM64 builds work). The full stack has not been run on the Pi.

## Next

1. GitHub App setup walkthrough: create the App (webhook URL + secret, Contents + Metadata read-only, push event), set
   env vars, Cloudflare tunnel exposing only `POST /api/webhooks/github`, one real push end to end.
2. Start/stop/restart + `desired_state`, crash handling, runtime health.
3. Persistent log storage. 4. Image retention, rollback, disk cleanup. 5. Dashboard (`apps/web`, React + Tailwind).
4. Automatic host-port allocation and app deletion (currently SQL by hand). 7. Pi hardening, docs, API docs (Scalar).

Known gaps: no audit/rate limit on `reveal`; old `shipdok/*` images pile up; build-time env vars; Railpack; DB backup docs.
The portfolio backend (`tianyu-00/TianYuSiteV2`, `backend/`, port 9090) is not yet deployed through the platform.
