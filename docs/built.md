# Built and verified (full record)

The detailed history of what was built, how it was checked for real, what could NOT be tested and the known limits, feature by feature.
CLAUDE.md holds the short version (what exists, the administrator's decisions and the invariants); read the matching entry here before changing a feature.
Newest work is at the bottom of the Milestone 6 entries. SPEC.md is the target design; where it and this record disagree about what exists, this record is right.

- **Auth:** single admin, argon2id, sessions in Postgres (30 min idle / 12 h absolute), rate limits, Origin-header CSRF check.
  `POST /api/auth/password` ({currentPassword, newPassword}, 12-256 chars, must differ) needs a session AND the current password (a wrong
  one is a 403, not a 401, so the dashboard does not mistake it for an ended session), ends every OTHER session and gives this one a new
  id; limited like login (10 per 15 min). There is still no "forgot password": delete the `users` row in Postgres to get the setup screen
  again, or use a recovery code or the host reset (next bullet but one).
- **Password policy, lockout, recent logins (Milestone 6 step 1; verified in a real browser against an isolated compose project):**
  `passwordProblem` (`packages/shared/src/password.js`, used by setup and change-password; the answer is `weak_password` on change)
  refuses under 12 or over 256 characters, a whole password made of one 1-4 character unit repeated, a plain run of characters
  (`123456789012`, `abcdefghijkl`, digits wrapping round), and one that contains the username (3+ characters). **Administrator's
  decision: no bundled word lists** (neither a common-passwords list nor a passphrase word list), so common passwords such as
  `password123456`, keyboard walks and short common words are NOT caught, and there is no passphrase generator; the strength bar and the
  hint to use several random words are the only guidance. SPEC.md section 4 was updated to match. **Lockout** (`lockout.js`,
  table `login_attempts`, migration 015, one row per login/setup attempt, kept 30 days): failures in a row since the last success, per typed
  name (any name, real or not, so nothing reveals who exists) AND per client address, in the last 24 h. Five failures are answered normally;
  after the fifth the next tries are refused with 429 `{code:'locked', retryAfterSeconds}` + `Retry-After`: 30 s, doubling per further
  failure, capped at 15 min per name and 60 min per address (the name cap is short on purpose: anyone can type the administrator's name, so a
  long lock would let a stranger keep them out). While locked nothing is checked (even the right password is refused) and the refused try
  is not counted. A success clears the count. An advisory lock per name and per address (taken in a fixed order) makes the check, the
  password check and the record one step, so nine parallel tries cannot all pass (checked; a bug found by a flaky test: a transaction that
  began slightly earlier than the failure row it read made a negative age, which locked after only four failures). The old 10 per 15 min
  limiter stays as an outer layer. Wrong CURRENT password on change-password is only limited by that outer limiter, not counted by the
  lockout. `GET /api/auth/logins?limit=` (default 20, max 100) lists the latest attempts (good and bad, typed names included, with address
  and kind login/setup/recovery); `POST /api/auth/logout-all` ends every session including this one. Dashboard: new **Security** page
  (header link; icon only on phones): the honest "no second login step" note, Change password, **Sign out everywhere** (asks first),
  recent sign-ins table; the setup form and the change-password dialog show a length-based strength bar and the rules. Checked for real
  (before the word lists were removed, which touched only the password rules and the generator): pattern passwords refused with the
  reason, five wrong tries then "Try again in 30 seconds", the right password refused during the wait and
  accepted after it, failed attempts in the list, Sign out everywhere, no console errors beyond the expected failed requests. Not tested:
  a hundred simultaneous addresses, behind a real reverse proxy. Known limit: through the dashboard's nginx the address recorded is the
  Docker gateway (`172.19.0.1`), not the real client, until step 3 (trusted proxies and real client address).
- **Recovery codes and host-side reset (Milestone 6 step 2; verified in a real browser against an isolated compose project, and the reset
  command run for real with `docker compose exec`):** account setup now returns `recoveryCodes` (10, once; the account and the codes are one
  transaction) and the dashboard shows them BEFORE the dashboard opens, with Copy, Download (`shipdok-recovery-codes.txt`), Print and an
  "I have saved these codes" box that must be ticked before Done. A code is 16 characters (80 bits) of a 32-letter alphabet without I, L, O, U,
  written `XXXX-XXXX-XXXX-XXXX`; typing is forgiving (case, spaces, dashes, O/I/L read as 0/1/1). Table `recovery_codes` (migration 016) holds
  only `SHA-256("shipdok-recovery:" + code)`: the codes are random and long, so a slow hash adds nothing and the database can find one by
  equality; guessing is held back by the lockout. `GET /api/auth/recovery` ({remaining, createdAt}, never the codes), `POST /api/auth/recovery`
  ({password}: the current password again, 403 `wrong_password`; replaces the whole set, so the old codes stop working; limited 10 per 15 min),
  `POST /api/auth/recover` ({username, code, newPassword}, no session needed): the new password must pass the password rules (400
  `weak_password`, checked BEFORE the code is looked at so it neither reveals nor spends the code), then, under the same per-name and per-address
  lock and counters as login (kind `recovery`; failures and successes share the login wait), the code is spent with one UPDATE ... WHERE used_at
  IS NULL (two parallel uses: exactly one wins), the password is set, EVERY session of the user ends and this browser is signed in. A wrong code, a
  used code and an unknown name all give the same 401. Dashboard: "Lost your password? Use a recovery code" on the login form (name, code, new
  password with strength bar); Security page card "Recovery codes" (how many of 10 are left, a warning at 3 or fewer, "none left", "Make new
  codes" asking the current password; once the codes are on screen the dialog cannot be closed by Escape or a click outside, only by "I have
  saved these codes" + Done). **Host reset:** `docker compose -f infrastructure/compose.yaml --env-file infrastructure/.env exec api node
  scripts/reset-password.js` (or `npm run reset-password -w apps/api` from a checkout) sets a new random 24-character password (alphabet without
  look-alikes), prints it ONCE, ends every session, marks all failed tries `forgiven` (they stay in the recent-sign-ins list but stop counting,
  so a locked-out administrator can log in at once) and records a `reset` entry ("Password reset on the host", address `host`); unused recovery
  codes are untouched; with no administrator it says so and exits 1. Checked for real: setup showing ten codes and holding the dashboard back,
  recovery with a lower-case code, the used code refused, a new set replacing the old, Escape not closing the codes, the reset command's
  password logging in after the reset signed the browser out, phone width without sideways scroll. Not tested: the print window in a real
  browser (the popup is unit-tested with a fake window), the download in a real browser (unit-tested with a fake link), a Pi. Known limits:
  recovery is by username + code, so anyone who steals the saved codes can take the account (the dashboard says so); no way yet to see which
  codes were used, only how many are left; the old SPEC wording "set a new password" is met in one step on the login screen.
- **Public access (Milestone 6 step 3; verified with the real dashboard nginx and API in an isolated compose project, and in a real
  browser):** **Administrator's decisions: the mode and the public address are set in the DASHBOARD (Security page, "Public access"), the
  environment (`SHIPDOK_PUBLIC`, `PUBLIC_URL`) overrides and locks the field; modes are `local` (the default), `webhook`, `full`; visitors
  are judged by fail-closed rules; changing it needs the password.** Table `settings` (migration 017; also a `settings` kind in the sign-ins
  list, shown as "Public access changed"). `GET /api/settings/public` ({mode, publicUrl, modeLocked, urlLocked, visitor}) and `PUT` ({password,
  mode?, publicUrl?}: password re-checked (403 `wrong_password`, 10 tries per 15 min), 400 for a bad mode or address, 409 `locked_by_environment`,
  recorded in the sign-ins list; an address is tidied to an origin `https://host[:port]`, no path, no credentials). Cached 5 s, dropped at once on a
  change. **Who counts as local** (`visitor.js`): only a visitor that can be shown to be on the local network, i.e. the connection itself comes from a
  private, loopback, link-local or shared (100.64/10, VPN) address AND either no forwarding header exists, or a trusted proxy (`TRUST_PROXY`, default
  loopback; compose adds private ranges) reports a private client in X-Forwarded-For. Everything else is OUTSIDE: a public socket, a forwarder
  that is not trusted, forwarding headers (X-Real-IP, CF-Connecting-IP, Forwarded ...) without X-Forwarded-For, an unreadable address, and a request
  addressed to the public host name that no proxy vouched for. **Enforcement** (`middleware/publicAccess.js`, the very first thing in the app,
  before the webhook receiver): local visitors always get everything; outside visitors get a plain `{"error":"Not found"}` 404 (the same as an
  unknown route) for every path in `local`, for every path except `POST /api/webhooks/github` in `webhook`, and nothing is refused in `full`.
  **The dashboard's nginx** (`apps/web/nginx.conf`): `real_ip` from private ranges so a proxy's X-Forwarded-For is believed and the API sees the real
  visitor (the sign-ins list now shows real addresses, not `172.19.0.1`); `auth_request` to `GET /api/_visitor` (204/403, mounted before the rule) in
  front of the pages and assets, a refusal answers 404; a proxy that sent other address headers but no X-Forwarded-For gets the documentation address
  192.0.2.1 passed on (so it counts as outside); `X-Shipdok-Proxied` says whether the visitor's own request carried X-Forwarded-For (nginx adds its own
  to every request, which alone must not vouch for a visitor using the public name); `X-Forwarded-Proto` is passed through for the cookie. **Origins:**
  `WEB_ORIGIN` stays, the public address is added (never replaces). **Cookies:** `COOKIE_SECURE` unset or `auto` (compose's default now) sets
  Secure only when a trusted proxy says the visitor used https; `true`/`false` still force it. Dashboard: a "Public access" card on the Security page
  (three radios with explanations, address field, the webhook address GitHub should use, whether this visit is local or outside, a warning that a
  narrower mode would lock out an outside visit, a warning for `full`, locked fields explained, Save asks for the password) and a banner on every
  page while the mode is `full`. Checked for real (curl with simulated outside visitors through the real nginx): local default, webhook (the webhook
  gets a 401 for a bad signature, not 404, everything else 404), full, a forged "local, real-public" chain, CF-Connecting-IP without X-Forwarded-For,
  the public name with and without a vouching proxy, outside logins recorded with their real address, Secure cookie behind an https proxy, and
  back to local; in the browser: bad address, wrong password, save, banner on and off, phone width. The tunnel-style webhook tests now run in
  `webhook` mode (`settingsFor('webhook')` in `tests/helpers.js`). **Consequence for the administrator's own setup: the default is `local`, so the
  Cloudflare-tunnel webhook is blocked until Security > Public access is set to Webhook only once** (and the tunnel's ingress can keep forwarding
  only the webhook path as well). Also checked by the administrator on the real setup: with the mode set to Webhook only, a real push through the
  Cloudflare tunnel (`hooks.tianyu00.com`) still deployed the test app, and the dashboard was reachable from a Raspberry Pi on the LAN (Windows host,
  WSL mirrored networking: needed `WEB_BIND=0.0.0.0`, `WEB_ORIGIN`, a Windows Firewall rule and a Hyper-V firewall rule for the port). Not tested: a real
  Nginx Proxy Manager in front, a visitor connecting from a real public
  address to the dashboard (only simulated with headers), IPv6 clients, a LAN user reaching the dashboard through the public name. Known limits: a dashboard port
  forwarded straight from the router (WEB_BIND=0.0.0.0) through Docker's userland proxy can lose the real address and look local, so never forward
  the dashboard port directly, always go through a proxy; trusted proxies stay in `.env`; the docs with Nginx / Nginx Proxy Manager / Caddy examples
  are not written yet.
- **Connect GitHub (Milestone 6 step 4; verified with a fake GitHub in tests, against the real api.github.com for the error path, and in a real
  browser through the real nginx):** **Administrator's decisions: GitHub App credentials live ONLY in the dashboard, encrypted in the DB; no
  import from `.env` (re-enter once by hand); Disconnect and replacing credentials ask for the password; a new GitHub page in the header; the app
  is created private with a name `Shipdok-xxxx` (editable).** Table `github_app` (migration 018, one row, `id = 1`): app id, slug, name, owner, page
  link, client id and three encrypted fields (private key, webhook secret, client secret; AES-256-GCM with the platform key, each bound to its
  field name `github:<field>`; a value moved between fields does not decrypt). `packages/shared/src/githubapp.js`: `saveGithubApp`,
  `loadGithubApp`, `githubAppSummary`, `deleteGithubApp` and `createGithubProvider(db, key)` which the API AND the worker use: it hands out the
  GitHub client (built once per saved version, keeps its token cache), the webhook secret and a status, reading the DB at most every 5 s (the
  API drops its cache at once on a change), keeps what it knew if the DB is briefly unreachable, and reports `cannot_decrypt` when the platform
  key does not fit. The webhook receiver reads its secret per request and answers 503 until an app is connected; the worker asks for the client
  when a job needs it (`github` may be a function in `processDeployJob`). `loadGithubAppConfig` is gone; `parsePrivateKeyPem` accepts GitHub's
  PKCS#1 download (and PKCS#8, CRLF, surrounding spaces; RSA only). **Routes:** `GET /api/github` ({connected, app (no secrets), problem}),
  `POST /api/github/manual` ({password, appId, privateKey, webhookSecret}: validated, password checked, THEN proven with a real `GET /app` (401/403/404 =
  `github_rejected`, id differs = `app_id_mismatch`, unreachable = 502 `github_unreachable`) and only then stored, so a typo never replaces a working
  connection), `DELETE /api/github` ({password}; running apps untouched; Shipdok cannot delete the app on github.com), `GET /api/github/repos`
  and `/installations` (501 until connected), `GET /api/github/webhook` ({expected = public address + /api/webhooks/github, actual from GitHub,
  matches}) and `POST /api/github/webhook/sync` (PATCH `/app/hook/config`, only the address). Changing the public address in Public access also
  updates GitHub when an app is connected (`githubWebhook` in the answer: updated, or a plain failure that does not undo the setting). Connecting,
  replacing and disconnecting are recorded in the sign-ins list as kind `github` ("GitHub changed"). **Manifest flow** (`routes/githubconnect.js`):
  `POST /api/github/connect/start` ({owner?, name?}; refused while an app exists; needs an Origin that is one of the dashboard's addresses) returns
  `{postUrl, manifest}` and keeps a random 256-bit `state` in the session for 10 minutes; the manifest asks only for `contents: read` +
  `metadata: read`, the `push` event, `public: false`, the webhook address from the public address (or the dashboard's own address as a stand-in
  until one is set) and `redirect_url` = this dashboard + `/api/github/connect/callback`. The dashboard posts the manifest to github.com in a form
  (`lib/githubconnect.js` refuses any target but https://github.com; nginx's `form-action` now allows it). `GET /api/github/connect/callback` is
  mounted before the authenticated router and answers only with redirects to `/github?connected=1` or `/github?error=login|state|exchange_failed|
  github_unreachable|already_connected`: state compared in constant time and consumed whatever happens (a wrong guess burns the real one), code
  shape checked, `POST /app-manifests/{code}/conversions` (outbound, no login, works on localhost), answer validated (id, webhook secret, a usable
  key), saved encrypted, no secret ever in a redirect, log or answer. **Leftover settings:** the API and worker log one warning naming
  `GITHUB_APP_ID` etc. if they are still set (names only). `scripts/send-webhook.js` now reads the secret from the DB. Dashboard (`/github`, header
  link): not connected shows two cards (the Connect GitHub button with personal/organisation choice, app name, a note when no public address is set;
  and "I already have a GitHub App" with app ID, private key, webhook secret, password, cleared after success and kept after a failure); connected
  shows the app (link, ID, owner, how it was added), "Install on repositories" + "Check again" (installations asked only on demand), a Webhook
  address card (right address / different address with an "Update on GitHub" button / no public address) and Disconnect (password). Checked for real:
  the manual form with a made-up key against the real GitHub (refused with the plain message, form kept), a callback nobody started (redirect and
  message, gone on reload), Connect GitHub leaving for github.com/login with no CSP error, the leftover-setting warning in both api and worker logs.
  **Bug found on the administrator's real setup right after connecting a NEW app: "Deployment failed: Could not get a GitHub access token (HTTP 404)".**
  Installation ids belong to ONE GitHub App, but each Shipdok app remembers the installation id found for the OLD app, so the new app got a 404
  for it. Fixed twice: (1) entering, connecting or disconnecting an app now clears every remembered `apps.github_installation_id` (`forgetInstallations`,
  only after a successful save, never after a refusal); (2) the worker, when a REMEMBERED installation answers 404 (only 404, only a remembered
  id), looks the repository up once more, remembers the new id and retries with the same scoped token (this repository, `contents: read`), or, if the
  app is not installed there, forgets the id and tries an anonymous clone with a build-log line saying so; a lookup that fails, or a second refusal,
  fails with the status only. **NOT tested (needs the administrator's GitHub account): the real confirmation on github.com and the real conversion, installing the app, and a
  real push through the new app.** Unknown until then: whether GitHub accepts a manifest whose webhook address is the dashboard's own (localhost)
  address when no public address is set; if it does not, the fix is to require a public address before Connect GitHub. Known limits: the app is
  only ever one (no multiple apps); a manifest app created while another is connected is refused at start; replacing an app requires Disconnect
  first for the button flow (the by-hand form replaces directly); the page cannot delete the app on github.com.
- **First-run secrets, setup token, same-origin check, no DOCKER_GID (Milestone 6 step 5; verified with the real compose stack from nothing and
  with the secrets given in the environment, and in a real browser):** **Administrator's decisions: the first admin is created on the dashboard's
  setup screen (no `SHIPDOK_USERNAME`/`SHIPDOK_PASSWORD`); the setup token is generated and printed in the API log, never set in `.env`;
  `WEB_ORIGIN` is not needed (same-origin check); database user and name are optional (default `shipdok`); the Docker group is read from the
  socket.** `docker compose up -d --build` works with NO env file. A one-shot `secrets` service (the API image, run as root only to write into a
  fresh volume; `apps/api/scripts/init-secrets.js`, `packages/shared/src/secretfiles.js`) writes, into the `shipdok_secrets` volume, every secret
  that is not given in the environment and not already there: `app_secrets_key` and `session_secret` (64 hex), `postgres_password` and
  `redis_password` (48 hex), `setup_token` (`XXXXX-XXXXX-XXXXX-XXXXX`, no look-alike characters since it is typed from a log). Files are mode 0444,
  written atomically (temp file + rename), never overwritten, a blank leftover is replaced; it prints names only (Generated / Kept / Taken from
  the environment). Services mount the volume read-only (not web) and every process loads `<NAME>_FILE` into `<NAME>` at start
  (`loadSecretFiles`, imported FIRST via `loadsecrets.js` in api config/pool/queue and worker db/queue/worker.js); **an environment value always wins
  and its file is not even read**; a missing, empty, relative-path or over-4-KB file stops the process with a message naming the setting and path,
  never a value. Postgres and Redis use `entrypoint` wrappers (the password you set, else the file); their healthchecks read the same. Checked for
  real from nothing: all five secrets generated, volume files 0444, api/worker/postgres/redis healthy, a restart (volumes kept) regenerates
  nothing (file checksums unchanged) and the same password still logs in; with all four secrets (and a custom `POSTGRES_USER`/`POSTGRES_DB`)
  given in the environment only the setup token is generated and Postgres really uses the custom user and database. **Setup token:** the API
  prints it in its log at start while no administrator exists (`setupnotice.js`; "Find it again with: docker compose logs api"), `GET
  /api/auth/status` carries `setupTokenRequired` (never the token), the setup screen shows the token field only then (with that hint) and checks
  it is filled in; after setup it is never asked for or printed again. **Same-origin check** (`origin.js`): a state-changing request is accepted
  when its Origin is exactly scheme://host[:port] of the request itself (Express's `protocol`/`host`, which honour X-Forwarded-Proto/-Host only from
  a trusted proxy), or in the optional `WEB_ORIGIN` list, or the public address; the dashboard's nginx now sends `Host $http_host` (with the port).
  Also used by Connect GitHub. Safe because a page on another site always has a different Origin than the Host it talks to; a DNS-rebinding page
  would have the same Origin and Host but no session cookie (cookies are per host) and the setup screen needs the token. **Worker without
  `DOCKER_GID`:** `apps/worker/docker-entrypoint.sh` starts as root only to read the group of the Docker socket, then `setpriv` drops to `node`
  with exactly that group (checked for real: the `node worker.js` process runs as uid 1000, gid 1000, groups 1001 = the socket's group on this
  machine, no capabilities, and can run `docker ps`; the init process (tini) stays root, and `docker compose exec worker` opens a root shell
  because the image no longer has `USER node`). **Bug found on the administrator's real setup right after
  rebuilding: every deployment failed with `unknown flag: --progress`, `open /root/.docker/config.json: permission denied` and git warnings about
  `/root/.config/git`.** The entry script dropped to `node` but left `HOME=/root`, which node cannot read, so the Docker CLI could not load its
  config and buildx plugin and git could not read its config. Fixed: the script now exports `HOME=/home/node USER=node LOGNAME=node` before dropping
  (tests with a fake `setpriv` check the environment the command sees; mutation-proofed). Checked for real through the entry script in an isolated
  worker: user node, groups 1000 and 1001, HOME `/home/node`, a `git clone` with no warnings and a `docker build --progress=plain` that builds.
  Lesson: an earlier check only ran `docker ps` as the worker; check a real build and clone after changing how the worker starts. Not tested: ARM64, a socket owned by root (gid 0: the node user then joins group 0), the
  old `shipdok_*` volumes of an existing install with an `.env` after pulling this (the four secrets in your `.env` are used, so nothing changes;
  the new `shipdok_secrets` volume will hold only a setup token). Known limits: if an install's database was created with a password and the
  password is later removed from `.env`, a new random one will not match the database (keep it in `.env`, or keep the volume); deleting only the
  `shipdok_secrets` volume while keeping the database makes stored secrets unreadable (back both up together).
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
- **GitHub App config (replaced by "Connect GitHub" below):** the administrator's own App was created by hand on github.com
  (webhook URL above, Contents read-only, Push event, installed on selected repos only). Its ID, key and webhook secret used to live in
  `infrastructure/.env`; they are now entered once on the dashboard's GitHub page and `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_FILE` and
  `GITHUB_WEBHOOK_SECRET` are no longer read (`GITHUB_APP_ID` is still passed into the containers so that a leftover value gets a log
  warning naming it).
- **Docker Compose hosting (api, worker verified on x86/WSL2 in an isolated project; there is NO `migrate` service any more, see "No migrate service" below):** formerly `migrate` ran once, then `api`
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
- **A container removed outside Shipdok is noticed (found on the Pi: `docker rm` of an app's container showed nothing; verified against real Docker
  and a real browser in an isolated compose project):** the monitor used to treat "no live container" as "never deployed" and return silently, so the
  dashboard kept saying Running. Now an app with a successful deployment and no live container becomes runtime state **`missing`** (migration 019:
  also the crash-history cause `removed_outside`), recorded ONCE (a second check changes nothing), with the message "The container was removed outside
  Shipdok (for example with docker rm). Nothing is running. Deploy the app again to bring it back." **Administrator's decision: show it, do not
  recreate it** (same spirit as a stop from outside; a new Deploy, or a roll back, is the way back). Rules in `supervisor.js` (`decideGone`): never
  deployed = ignored; a job in progress = ignored (the monitor checks `activity` AGAIN after Docker answers empty, because a swap removes the old
  container before the new one exists); an app being deleted = ignored; a stopped app whose container vanished is `missing` too; a container that
  appears again makes it `running` and a second removal is a second history entry. Start/Stop/Restart on a missing app answer "The container was
  removed outside Shipdok, so there is nothing to start, stop or restart. Deploy the app again to bring it back." (an app never deployed still
  gets "Nothing is deployed for this app yet"). Dashboard: red **Missing** badge (list and app page), the message in the Status card, "Removed
  outside Shipdok" in the crash history, no Start/Stop/Restart buttons (Deploy stays). Checked for real: `docker rm -f` of a running labelled
  container turned the app to missing within one monitor round (3 s interval), one history entry after 20 more seconds, Start refused with the
  message, a container appearing again turned it back to running; browser at 1100 and 390 px, no console errors. Not tested: a real deployed app
  (the container and the successful deployment row were made by hand, because the isolated stack has no GitHub App), a removed IMAGE (a Deploy
  rebuilds from git as usual). Known limit: the Overview card is still called "Running now" while the app is missing.
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
  clean-up; the build cache is cleaned separately (see "Build cache clean-up" below).
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
  and "Delete this log" for a finished deployment's build log inside the log window; all behind a confirmation. **Change password**: now
  on the Security page (the header key icon was removed). Checked for real: port taken (named, typed value kept), edit then rollback = container on the new port with the new
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
- **Published images (Milestone 6 step 6; the compose side and the secret check verified locally, the workflow itself NOT yet run on GitHub):**
  **Administrator's decisions: images are published only when a stable release is pushed to the `publish` branch; the repo and the images
  will become public later; use whatever build method works.** `.github/workflows/images.yml` builds `api`, `worker`, `web` (one job
  each) for linux/amd64 + linux/arm64 with QEMU (native ARM runners are free only for public repos; switch once the repo is public). A push
  to `publish` also pushes to `ghcr.io/<owner>/shipdok-<name>` with tags `latest`, the number in the root `VERSION` file and `sha-<commit>`
  (publishing the same VERSION again moves that tag; bump `VERSION` for a new release); a push to `main` or a pull request only builds.
  Before any push each image is built for amd64 and checked by `.github/scripts/check-image.sh`, which fails on `.env*`, `*.pem`, `jar.txt`,
  `id_rsa*` anywhere in the image (outside node_modules and system certificates); checked on the real api, worker and web images (clean) and on
  an image with a planted `.env` and `.pem` (fails, listing both); an unknown image also fails. `infrastructure/compose.yaml` now has only
  `image:` lines (`ghcr.io/tianyu-00/shipdok-api|worker|web:${SHIPDOK_VERSION:-latest}`; secrets and api share the api image);
  `infrastructure/compose.build.yaml` is the override that adds the `build:` sections. Checked: `docker compose config --images` for both file
  sets and for a pinned version. **Checked by the administrator on GitHub: the workflow ran, the images were published and made public, each has amd64 and arm64
  (`docker buildx imagetools inspect` from here, no login).** A second job, `release`, runs after all three images are published (push to `publish`
  only) and creates the GitHub Release and tag `v<VERSION>` with the image names, the run command and generated notes; if that release exists it
  leaves it alone (bump `VERSION` for a new release); VERSION is validated. The release script was run locally with a fake `gh` (new, existing,
  bad version); actionlint clean; **the release job itself has not run on GitHub yet. Not tested: pulling on the Pi.** To do once, after the first publish: set the three packages to Public on github.com (GHCR starts
  private) or `docker compose pull` needs a login. Do a pre-release on the `publish` branch to see it work.
- **No `migrate` service (fewer services; verified with the real stack from nothing):** **Administrator's decision: drop `migrate`.** The API runs
  the migrations itself at start (`runMigrations()` in `apps/api/src/server.js`, before it listens, under the same Postgres advisory lock, so
  `/health` passes only once the tables exist); a failed migration logs "The database could not be prepared: Migration X failed: ..." and exits 1
  (compose restarts it until it works). The worker now waits for a healthy `api` instead. `npm run migrate -w apps/api` still works for
  development. `compose.build.yaml` builds the API image only through `api` (`secrets` uses it, `pull_policy: never`; building one image from
  three services at once collided on the new Docker image store). Checked for real: fresh start applies all 18 migrations and the stack comes up
  (api healthy, then worker and web), a restart says "Database is up to date", a migration that fails stops the API with that message and it
  recovers on its own once the cause is fixed. Not covered by an automated test (server.js is not imported by the tests). Long-running services
  are now postgres, redis, api, worker, web (plus the one-shot `secrets`).
- **API documentation (Milestone 6 step 7; verified in a real browser through the dashboard's nginx):** **Administrator's decisions: the
  descriptions live in a SEPARATE file, not as comments in the routes, and a test fails when a route has none; `/api/docs` is for the
  signed-in administrator only, on by default, `API_DOCS=false` turns it off; MIT licence.** `apps/api/openapi/`: `operations/{auth,apps,more}.js` describe
  every route (summary, description, parameters, request body, success and error answers, whether it needs the session) with the builders in
  `helpers.js`; `schemas.js` has the response shapes and takes the REQUEST bodies of the app calls straight from the zod validators the routes use
  (exported from `routes/apps.js`, `z.toJSONSchema`) so they cannot drift; `build.js` assembles an OpenAPI 3.0.3 document and compares it with the
  routes; `generate.js` (`npm run openapi -w apps/api`) writes `openapi.json` (committed) or fails listing the undocumented and stale routes.
  **Deviation from SPEC.md ("use swagger-autogen"): swagger-autogen was tried and rejected as the route list**: it found 71 operations for 56 real
  routes (it mixes up routers that are built by functions and mounted under variable paths, e.g. it invented `/api/deployments/{id}/crashes`).
  `inventory.js` instead records the real routes while `createApp` builds the app (it wraps `Router.prototype.route`/`use`, because Express 5 does
  not keep the path strings); SPEC.md was not edited. **Tests** (`openapi.test.js`, `apidocs.test.js`): every real route is described and
  every description has a route; `openapi.json` is up to date; the document validates (`@apidevtools/swagger-parser` 10, the 13 line is ESM-only
  and Jest cannot load it); every operation has a summary, description, success answer, declared tags; calls that need a session document the 401
  and every error answer is the shared `Error` shape; and **the documented sign-in requirement equals the real one** (every route is called without
  a session: documented-as-session ones answer 401, the others do not). Mutation-proofed: a renamed route, a new undocumented route, a stale
  `openapi.json`, a route documented as open that needs a session; and for the page: docs mounted without the sign-in, the CDN instead of the local
  bundle, `API_DOCS=false` ignored, `unsafe-eval` in the policy. **The page** (`src/docs.js`, Scalar via `@scalar/express-api-reference`): `/api/docs`
  (HTML, a fresh nonce per request and its own Content-Security-Policy: nothing but this origin, one nonce-allowed inline script, no
  `unsafe-eval`), `/api/docs/openapi.json`, `/api/docs/scalar.js` (Scalar's standalone bundle served from here, so it works on a LAN with no
  internet); all behind `requireAuth`, so an outside visitor gets the usual 404 and a signed-out one a 401; Scalar's hosted-product menus (AI
  assistant, share, deploy, developer tools, MCP) and telemetry are off. **The Docker image** gets the bundle from a separate build stage
  (`SCALAR_BUNDLE`; keep `SCALAR_VERSION` in `apps/api/Dockerfile` equal to the `@scalar/api-reference` devDependency): the package has ~200 MB of
  dependencies the bundle does not need (the image grew 373 -> 622 MB until this was fixed; now 385 MB). `apps/web/nginx.conf` has a location for
  exactly `/api/docs` that leaves out the dashboard's own policy (the page sets its own; the other headers are repeated there). Checked for real
  in headless Chromium through nginx: Scalar renders the tags and operations, nothing is requested from another origin, "Test Request" on
  `GET /api/auth/logins` returns a real 200 with the session cookie sent automatically, no console errors. **Reaching it:** the header has an **API** link (book icon, icon only on phones) that opens `/api/docs` in a new tab. A browser that is NOT
  signed in and asks for the page (`Accept: text/html`) is redirected (302) to `/api-docs`, a dashboard route: the dashboard shows its login
  form there and, once signed in, `ApiDocsPage` sends the browser on to `/api/docs` (no query parameter, so no open redirect). The document, the
  script and a program asking for JSON still get the plain 401 (`docsGate` in `src/docs.js` only redirects the page). Checked for real in Chromium
  through nginx: signed out `/api/docs` -> login at `/api-docs` -> after login the reference; the header link and its new tab; phone width. Known limits: Scalar tries `eval` once
  and the policy blocks it (nothing visible is lost); Scalar's "Generate SDK" button is still shown; response shapes are written by hand from the
  routes (only the app request bodies come from validators), so a changed response is not caught by a test unless the route list changes.
- **Hardening slice: per-app build time limit, container hardening, security doc, two dashboard notices (verified with real Docker and a real
  browser; the reveal rate limit and HSTS were dropped by the administrator on purpose: a session can already deploy code that reads every variable,
  and HSTS only matters in `full` mode over HTTPS):** **Administrator's decisions: the build time limit is a per-APP setting in the dashboard, not an
  environment variable; 5 minutes up to 7 days or UNLIMITED, and the default is UNLIMITED.** Column `apps.build_timeout_minutes` (migration 020, NULL = no limit,
  CHECK 5..10080); on the create form (under "Limits and clean-up") and the Settings tab ("Build time limit (minutes)", empty = no limit, hint says a
  hanging build with no limit blocks the queue until cancelled); it is part of the deployment snapshot and the list of settings that wait for the next
  deployment; zod validators (so the API docs follow); the job carries `buildTimeoutMinutes` (absent = no limit). `deploy()` starts a timer just before
  the clone and stops it when the build ends (so a LATER failure, for instance an unhealthy candidate, is never blamed on it); the timer aborts the clone
  and `docker build` through the same signal a cancel uses (`AbortSignal.any`), and a timeout is reported as a FAILURE with "The build took longer than N
  minutes and was stopped (the limit is a setting of the app)" while a user cancel stays "stopped"; the running version is never touched; a rollback builds
  nothing so it is not limited. Checked for real: the real worker engine against a local repo whose Dockerfile runs `sleep 600` and a limit of 0.1 minutes:
  stopped at 6.0 s, BuildKit printed `#6 CANCELED`, no process and no image left. Two mutants that first survived (timer not cleared after the build; a dead
  `!signal.aborted` condition) led to a new test and a simplification. **Containers** now get `PidsLimit: 512`. **Administrator's decision: NO `no-new-privileges` and no capability drop**
  (a repository may legitimately need to elevate; I had added it, it was removed again and a test now pins that it is absent); checked for real: PidsLimit 512 on a real container and
  starting 700 processes fails with "can't fork: Resource temporarily unavailable". **`docs/security.md`** states what is protected and the residual risks
  plainly (no 2FA; a signed-in administrator owns the host; deployed code is trusted; no build limit by default; HTTP is not encrypted; backups hold secrets);
  linked from the README and operations. **Dashboard:** a notice bar in the header area when 3 or fewer recovery codes are left (0 says "no recovery codes left",
  links to Security; checked for real with 2 left), and the Overview card says "Last deployed" instead of "Running now" while the container is missing.
  Not tested: a truly hostile repository, a build that ignores SIGTERM inside BuildKit for a long time, Pi limits.
- **Persistent storage for apps (SPEC section 9; verified with the real worker engine against real Docker, and in tests; the dashboard parts in unit tests only, no browser
  pass yet):** **Administrator's decisions (all "your suggestions"): the candidate gets THROWAWAY volumes, never the real ones; deleting an app KEEPS its volumes by default
  (permanent delete is an unticked box on top of typing the name); removing a path DETACHES its volume (data kept, re-adding the path re-attaches the same volume); paths are set
  on the Settings tab only; adopting an orphaned volume into another app is out of scope.** Table `app_volumes` (migration 021: id, app_id (SET NULL when the app goes), app_name,
  container_path, docker_name `shipdok-vol-<uuid>` generated by us, state in_use/detached/orphaned, remove_error, one in-use volume per app+path). Paths (`volumepaths.js`, mirrored
  in `apps/web/src/lib/volumes.js`): absolute, tidied, `[A-Za-z0-9._/-]`, no `.`/`..`, not `/`, not under `/proc` `/sys` `/dev`, no duplicates, none inside another, at most 10, 200
  characters. API: `GET/PUT /api/apps/:id/volumes` (PUT replaces the list: new path = new volume, earlier removed path = SAME volume back, a path left out = detached, nothing deleted),
  `GET /api/volumes` (detached and orphaned only), `DELETE /api/volumes/:id` (409 `volume_in_use` for a mounted one, else queues `removevolume`; the API never touches Docker), and
  `deleteVolumes: true|false` on `DELETE /api/apps/:id` (anything else is a 400; the default false). The deployment snapshot and job carry `volumes: [{path, name}]` and a change is
  `settings_pending: ['volumes']` (a record from before this counts as none mounted). Worker: `containerSpec` mounts `Mounts: [{Type:'volume', Source:name, Target:path}]` (named volumes
  only, never `Binds`); the candidate gets `{Type:'volume', Target:path}` = an anonymous throwaway volume; the REAL volumes are created (`ensureVolume`, labels `shipdok.managed` +
  `shipdok.app-id`) only after the candidate passed and the old container stopped, inside the swap's try (a failed swap restores the old version and keeps the volumes);
  `removeQuietly` now passes `v: true` so a candidate's throwaway volumes are removed with it (named volumes are never touched by that); `removeVolumeStrict` refuses a name that is not
  `shipdok-vol-...` AND a volume without our label, and tells removed/gone/in-use apart; `deleteapp` removes (after the containers) or orphans the volumes; the new `removevolume` job
  (`removevolume.js`) refuses a mounted volume and records `remove_error`; image clean-up and boot reconcile never touch volumes (a test traps any volume call). Dashboard: Settings tab
  "Persistent storage" card (add/remove paths, Docker name shown for backups, detached ones listed, permission hint), the delete dialog's keep/delete choice (checkbox only when the app
  has volumes), Storage page "Volumes kept without an app" with a confirmed Delete and the failure reason. Docs: `docs/operations.md` section with a backup and restore recipe (tested
  for real, restore into a new volume), `docs/security.md`. **Checked for real (20 checks, real `git`, `docker build`, containers and volumes):** v1 creates the labelled named volume and
  Docker copies the image's files into it once; data written by v1 survives the v2 redeploy; WHILE v2 was validating the old version still ran and the candidate could NOT see the real data
  (it had its own throwaway volume) and did not mount the real one; no throwaway volume leaked; a broken v3 was refused, v2 kept running with its data, nothing leaked; a volume with the
  wrong label or a foreign name is refused; removal of our volume works and a second removal says gone. **Found by the administrator testing it: persisting `/app` (the code folder) makes later deployments run OLD code** (Docker copies the image's files into the new volume once, then the volume hides every later image). Added: an up-front warning in the card and a soft, non-blocking warning for `/app`, `/usr/src/app`, `/home/node/app`, `/code`, `/workspace`, `/srv`, `/var/www/html`, `/usr/share/nginx/html` (typed or already saved; `codeFolderWarning` in `apps/web/src/lib/volumes.js`; subfolders such as `/app/data` are fine); also in `docs/operations.md`. Known limits: sizes of volumes are NOT shown (Docker measures them slowly and
  the API does not talk to Docker; deferred, the plan had said "on demand"); a retry of a failed app delete uses the safe default (keep) unless the box is ticked again; a volume is
  initialised from the image folder, so a non-root app needs the folder created and owned in its Dockerfile (documented); an app deployed before this has no volumes until paths are
  added; adopting an orphaned volume into another app is not possible. Not tested: the Pi, an SD card under write load, a real browser pass of the new cards.
- **Build cache clean-up and "Deploy without cache" (verified with the real worker against a throwaway Docker-in-Docker daemon, through the real queue, and in a real
  browser; no new environment setting):** **Administrator's decisions (all "your suggestions" plus one addition): "unused" means not used for 24 hours; the worker measures the
  size in the background (every 5 minutes, hard-coded); no automatic clean-up after deployments; both buttons ("Clean unused cache" and "Clean everything unused"); plus a
  per-deployment "Deploy without cache".** Docker's BuildKit cache is shared by every build, so it has no owner and image clean-up never touched it. Table `build_cache`
  (migration 022, ONE row, `id = 1`: total/reclaimable bytes and `sampled_at` from the worker's last look; `requested_at`/`requested_all` while a clean-up is waiting; `last_*` =
  the most recent clean-up with `last_error`). Worker (`buildcache.js`, `docker.js`): `buildCacheUsage` (sums `df().BuildCache`, `InUse` entries are not reclaimable; null when this
  Docker does not report it) and `pruneBuildCache({olderThanHours})` (`POST /build/prune?all=1` through dockerode's modem, with an `until` filter for the default; dockerode has no
  call for it), the `cleancache` job (same queue as deployments, one at a time, so never during a build; dispatch routes it explicitly, an unknown name would otherwise become a
  deployment), and a sampler loop. A failed clean-up is recorded with its reason and the job fails; a failed measurement afterwards never fails a good clean-up. Only build
  cache is touched: no images, containers, volumes or logs. API: `GET /api/build-cache` ({totalBytes, reclaimableBytes, sampledAt, cleaning, last}; `cleaning` stops being true
  30 minutes after a request that was never reported back, so a dead worker does not block for ever) and `POST /api/build-cache/clean` ({all?: boolean}, strict; 202, 409
  `already_queued` decided by ONE upsert so parallel requests queue exactly one, the request is undone if the queue is down); `POST /api/apps/:id/deployments` accepts
  `noCache: true` (job field `noCache`, only when asked; NOT in the settings snapshot, not for webhooks, ignored for a rollback), and the worker adds `docker build --no-cache`
  and logs "Building ... without the build cache" (only the exact value `true` counts; the base image is not re-pulled). Dashboard: Storage page **Build cache** card (size,
  reclaimable, "measured N min ago", the last result or its error, "Cleaning..." with both buttons off, a confirmation for each button, the "everything" one warning that the next
  builds start from nothing), and a menu arrow beside **Deploy** with **Deploy without cache...** (confirmation; the disk-almost-full question keeps the choice). Docs:
  `docs/operations.md` "Build cache". **Checked for real:** a real `docker build` three times (second fully cached, `--no-cache` reran both RUN steps; the only CACHED line is the
  base image, which is what the dialog says); the "unused for 24 h" clean-up freed 0 on a minutes-old cache; "everything" freed 221 MB (cache 211.6 MB to 0), while the images, a
  running container and a labelled volume were untouched; the real worker container (its `DOCKER_HOST` pointed at the throwaway daemon, so this machine's Docker was never used)
  measured the cache, accepted the API's request through Redis, freed 312 MB and the API then showed the result; a second request while one was waiting was a 409; in headless Chromium
  the menu, both dialogs, the request bodies (`{"noCache":true}` and `{}`), the card and its "Cleaning..." state, no console errors. Mutation-proofed (worker, API and web: flag
  dropped, truthy instead of `true`, default age dropped, `all` not sent, in-use counted as reclaimable, request never ended, unknown job name, error not recorded, duplicate guard,
  stale window, strict body, queue-failure undo, plain Deploy sending noCache, disk question forgetting the choice, buttons not disabled, confirmation skipped). **Not tested:** the
  Pi (BuildKit on ARM64, how long `df` takes with a very large cache), a real push-triggered build with the button (the arguments are unit-tested and the flag was run by hand
  with the same options), a build running WHILE a clean-up is requested (the queue serialises them; BuildKit also protects entries a running build holds), and the card at phone
  width. Known limits: the measurement is up to 5 minutes old, and a clean-up done outside Shipdok shows only at the next look; "Deploy without cache" does not also offer
  "and start" for a stopped app (it stays stopped, like Deploy); no per-app cache.
- **Build-time variables (verified with the real worker engine and a real `docker build` against a throwaway Docker-in-Docker daemon, and in unit tests; the variables dialog was also looked at in a real browser):**
  **Administrator's decisions (all "your suggestions"): build ARGUMENTS only (BuildKit secrets are a possible later step); a scope on each existing variable (Runtime / Build only /
  Build and runtime) instead of a separate list; names that change how the build runs are refused for Build and Both; a pasted `.env` import stays runtime-only.** Column
  `app_env_vars.scope` (migration 023, CHECK runtime/build/both, default `runtime`, so every existing variable is unchanged); a scope change gets a new version number like a change
  of value, so "pending changes" shows it. `packages/shared` constants: `ENV_SCOPES`, `reachesBuild`, `reachesRuntime`, `isReservedBuildName` (`PATH HOME USER LOGNAME SHELL TMPDIR
  TERM PWD LANG TZ` and the prefixes `LD_ DOCKER_ BUILDKIT_ BUILDX_ COMPOSE_ XDG_ LC_`; names reserved for every scope, like `NODE_OPTIONS`, keep their older message). API:
  `PUT /api/apps/:id/env/:key` takes `{value?, scope?}` (a value alone keeps the scope and a new variable starts `runtime`; a scope alone changes where an EXISTING variable is
  available and keeps its value, 404 if it does not exist, no version bump when the scope is the same; unknown scope or a reserved build name = 400); `GET` lists `scope`; an import
  never changes the scope of a variable that exists. Worker: `loadAppEnv` returns `env` (runtime/both, for the container), `buildEnv` (build/both) and `versions` for every
  variable; `buildenv.js` `dockerBuildEnvironment` turns `buildEnv` into `--build-arg NAME` (NO value on the command line, so nothing shows in `ps`) and an environment for the
  docker command made from a short list (PATH, HOME, DOCKER_*, BUILDKIT_*, BUILDX_*, XDG_*, proxies, locale...) plus the build variables, so the worker's own secrets
  (`APP_SECRETS_KEY`, database and Redis passwords) never reach it; `DOCKER_BUILDKIT=1` is always set; a bad name fails the deployment before anything is built, naming the
  variable and never its value; the build log says which names were passed and that the Dockerfile must declare them with `ARG`; build values are masked `***` in the log like
  runtime ones; a rollback builds nothing and ignores them. Dashboard: Variables tab has an "Available in" choice on the add form (always sent, so adding an existing name sets
  the scope you chose), a badge beside each name (Runtime muted; Build and Build + runtime highlighted, since both reach the build), the scope choice shown only in the Edit dialog (pencil) next to the value, drawn like the other dialogs (an earlier inline edit panel inside the table looked cramped and was cut off on a phone; checked in headless Chromium, light and dark, at 1200 and 390 px) - only what changed is sent (a value alone, a scope alone, or both), nothing can be saved until something changes, a reserved name cannot be moved to the build, and the "baked into the image" note is an amber notice (`role=note`) like the pending-changes bar, a note (shown for Build and Both) that a used build argument is baked into the image
  and readable from its history, an immediate refusal of the reserved names, and the note that an imported `.env` is added as runtime variables (`lib/env-scope.js`, mirrors the
  API rules). Docs: `docs/operations.md` "Build-time variables" (with the `ARG` example), `docs/security.md`. **Checked for real:** a Dockerfile with `ARG VITE_API`,
  `ARG NPM_TOKEN`, `ARG NEVER_USED` built through the worker's own `run` with the arguments and environment `dockerBuildEnvironment` produced: both used values reached a `RUN`
  step (`api=https://api.example.com`, token length 33); over 176 looks at the process list the value never appeared in any command line; `APP_SECRETS_KEY` set in the
  "worker" was not in docker's environment; the container started from the image had none of the build variables in its environment; `docker history` DID contain the token (the
  baked-in caveat the dashboard states; Docker itself warns about `ARG NPM_TOKEN` as "sensitive data"). Mutation-proofed in all three layers (23 mutants: build variable also given to
  the container, never reaching the build, value on the command line, the worker's whole environment passed, reserved names unchecked, build values unmasked, `buildEnv` not handed
  on, BUILDKIT not forced, value-only PUT resetting the scope, an import changing it, scope change without a new version, a same-scope change bumping it, reserved build names
  allowed, unknown scope allowed, scope missing from the list, a scope-only PUT creating a variable, and the form sending or hiding the wrong things). **Not tested:** a real
  push-triggered deployment that uses a build variable (the deploy step is covered with a fake engine and the build step by hand with the same arguments), a real browser pass of the
  new controls (jsdom only), the Pi (BuildKit secrets were added afterwards, see the next entry). Known limits: Docker only passes an argument the Dockerfile declares (an undeclared one is ignored, with
  Docker's own warning); the same name cannot be both a build and a runtime variable with DIFFERENT values (one variable, one value: use "Build and runtime" for the same value); a
  build variable changes the image, so a deployment with a changed one rebuilds from the step that uses it.
- **Build secrets (BuildKit; verified with the real worker code and a real `docker build` against a throwaway Docker-in-Docker daemon, and in unit tests):** **Administrator's decisions:
  add them because it is a security feature; a separate "Passed to the build as" choice (Build argument / Build secret) next to "Available in" and shown only when the variable
  reaches the build, instead of more options in the scope list; existing variables stay arguments.** Column `app_env_vars.build_as` (migration 024, CHECK `arg`/`secret`, default
  `arg`); a change gets a new version number like any other, no bump when nothing changes; `BUILD_PASSES` in `packages/shared`. API: `PUT /env/:key` takes `buildAs` (alone it keeps
  the value and the scope; a value alone keeps `buildAs`; a rename keeps it or changes it in the same request; unknown value 400; no such variable 404; an import never changes it),
  `GET` and the answers carry `build_as`. Worker: `loadAppEnv` returns `buildSecretEnv` beside `buildEnv` (a runtime-only variable reaches neither, whatever its `build_as`);
  `dockerBuildEnvironment(buildEnv, buildSecretEnv, base)` adds `--secret id=NAME,env=NAME` (name only; the value is in docker's own environment, the same short environment and
  the same name rules as arguments, a bad name fails before the build naming it); `process-job` masks the values in the log; the build log names the secrets and says the Dockerfile
  must ask for them and that a changed secret does not re-run a cached step. Dashboard: the badge says "Build secret" / "Build secret + runtime", the Edit dialog and the add form
  have the second choice, an argument keeps the amber "baked into the image" note (now pointing to secrets for tokens) and a secret shows a plain note "Not stored in the image"
  with the exact Dockerfile line for the name being typed (it follows a rename) and the cache gotcha; only what changed is sent, and a secret moved to runtime sends the scope alone.
  Docs: `docs/operations.md` "Build secrets", `docs/security.md`. **Checked for real:** a Dockerfile with `RUN --mount=type=secret,id=NPM_TOKEN,env=NPM_TOKEN` and `ARG VITE_API`
  built with the arguments and environment the worker code produced: the step saw the real value (its length, 23, was written to a file), the argument arrived too,
  `APP_SECRETS_KEY` was not in docker's environment, the value was not in the build output, `docker history --no-trunc` and every layer of `docker save` (0 matches), and the image
  holds no `/run/secrets` file; **a rebuild with a different secret (length 30) reused the cached step and still said 23, and `--no-cache` said 30** (the documented caveat).
  Mutation-proofed (18 mutants: secrets treated as arguments, never passed, the `env=` part dropped, not masked, not handed on, not given to `dockerBuildEnvironment`; same-value no-op
  ignoring `buildAs`, a value-only PUT or an import resetting it, a rename or an import dropping it, unknown value accepted; in the dashboard: sent for a runtime variable,
  not reset on cancel or after adding, the wrong note, the badge). A first round of mutation runs was wrong (the database suites refused to start under bare `node --test`, so
  every mutant looked "killed"); it was redone through `npm test` with the unmutated baseline shown passing first. **Not tested:** a real push-triggered deployment that uses a secret,
  the Pi / ARM64, a real browser pass of the new controls (jsdom only), BuildKit versions older than Docker 28's bundled one (the worker image ships Docker 28 CLI + buildx).
  Afterwards, at the administrator's request: the name and value fields on the Variables tab (add form and Edit dialog) no longer get the saved Shipdok sign-in offered by the browser or a password
  manager (`autocomplete="new-password"` on the value, `off` on the name, plus the `data-1p-ignore` / `data-lpignore` / `data-bwignore` opt-outs); checked only as attributes in tests, **not in a real browser
  with a real password manager** (browsers may still ignore hints).
  Known limits: a changed secret does not invalidate the cache; there is no warning when the Dockerfile forgets to ask for a secret; a step that asks for it can read it (and print it).
 **Rename (added after the first version; verified in tests with a real database and in a real browser):** `PUT /api/apps/:id/env/:key` also takes `newKey`. The name is part of what the value is
  encrypted for (`env:<appId>:<name>`), so the server decrypts the stored value and encrypts it again for the new name, in the SAME transaction as any value or scope sent with it (all or
  nothing, one request, no half-renamed variable); the value never leaves the server. The new name follows the usual rules (shape, names reserved everywhere, and the build-reserved names
  when the resulting scope reaches the build); a name another variable has is a 409 `name_taken` (the primary key decides, so two requests racing for one name let exactly one in); a
  variable that does not exist is a 404 (a rename never creates one); a stored value that cannot be decrypted (APP_SECRETS_KEY changed) cannot be carried over, 500 with a plain message
  and nothing changed, but renaming WITH a new value works; the version is bumped, so until the next deployment the old name shows as removed and the new as added (accurate: the
  running app still has the old name); the answer carries `previous_key`. Dashboard: a Name field at the top of the Edit dialog (trimmed; nothing to save until something changes; shape
  checked at once; a build name rule on the NEW name; a note that the running app keeps the old name until the next deployment; a 409 is shown and the dialog stays open). Mutation-proofed
  (10 API and 7 web mutants; removing the explicit "taken" check was an equivalent mutant, so the redundant check was dropped and the primary key does the work). Not tested: a rename of a
  variable that a running app reads while a deployment is building (the running container is unaffected by design).
- **Build logs as an inline console (dashboard; looked at in a real browser through Vite with a stubbed API: light, dark, 1200 and 390 px; unit-tested; not yet tried on a real build):**
  **Administrator's decisions: option A of three (inline expanding row; the alternatives were a bottom drawer and a separate page), a toolbar with a search box. The console was first built always-dark and the administrator said it looked odd on a light page, so it now follows the theme.**
  The Deployments tab no longer opens the log in a dialog: **pressing anywhere on a deployment row** expands its log directly under it (a pointer cursor and an arrow that turns say so; a press that
  ended a text selection, such as copying a commit id, is ignored, and a DOUBLE press never starts a word selection (found by the administrator: the browser selected a word, and the "ignore a selection" rule then swallowed the next press until it was cleared), while a drag to select text still works; the actions cell stops the press, so Roll back, Delete and Cancel never also toggle the log), and the Log icon button
  (`aria-expanded`/`aria-controls`) does the same for the keyboard and screen readers. The **Why** column was dropped (administrator's decision): the reason a deployment did not succeed (the stored summary, or Cancelled / Replaced by a newer deployment) is now a tinted line above the console in the opened row (red for a failure, amber for interrupted, grey for cancelled or superseded), so it is also there when the log itself was deleted. The actions are icon-only buttons with names and tooltips (a Delete that is not allowed carries its reason as the
  tooltip). Several logs can be open at
  once, and **Delete this log** (finished deployments only) closes it. The cell has `max-w-0` so the console cannot widen the table (the first version made the table scroll sideways and
  clipped the Actions column), and the panel is `sticky left-0` and never wider than the screen, so on a phone it stays in view while the table scrolls. `LogViewer` (also used by the
  app's Logs tab) is now a console that follows the theme (pale with darker line colours in light mode, dark with brighter ones in dark mode; every tone has a light and a `dark:` colour, tested), a title bar with a status dot (pulsing green "Live" while following, grey "Finished"), the title (commit and age),
  the line count, a **find** (case-insensitive; every line stays on screen, every match is highlighted and the current one is stronger with a tinted row; "3 of 12" / "No matches"; Enter and Shift+Enter or the arrow buttons step through the matches and wrap round; Escape or the clear button end it; the current match is scrolled to the middle of the console only when the person types or steps, never when new lines arrive, and searching or stepping turns following off so new lines do not pull the view away; **decision: a find rather than a filter, because the lines around a match are usually what explains it**), **copy** (the whole log with its times), **download** (every loaded
  line in the log file's own format, named `<app>-<commit>-build.log`; only what is loaded in the page, up to 5000 lines), the follow switch and a **Latest** button that appears after
  scrolling away. **Colours follow the text, not the stream** (`lib/logtone.js`, pure and tested): BuildKit step headers (`#5 [2/4]`) bold blue, `DONE`/`CACHED` quiet green, errors red,
  warnings amber, Shipdok's own lines cyan with success green and failure red. The old rule painted every stderr line red, which would have made a healthy build look like a failure
  because `docker build --progress=plain` writes ALL its progress to stderr. Mutation-proofed (27 mutants over the console and the find: stderr always red, steps and warnings and Shipdok failures not recognised, a case
  sensitive filter, copy and download using the wrong lines, "Latest" not turning following on, the console following the theme, "Finished" shown wrongly, one log at a time, missing
  `aria-expanded`, deleting not closing the console, delete offered while running). Not tested: a very long live build in the page (the 5000-line cap is old behaviour), the Logs tab in
  a real browser, other browsers.
- **Branch picker (verified in tests with a fake GitHub, against the real api.github.com for the anonymous and error paths, and in unit tests of the dashboard; not looked at in a browser, by the administrator's choice; NOT tried with an installed private repository):**
  **Administrator's decisions: a searchable list (not a plain dropdown), public repositories the app is not installed on are listed too (anonymously), branch names only with the default marked.**
  `packages/shared/src/github.js`: the request helper moved out of the client (`githubApi`, a `bearer` is now optional: no token, no Authorization header at all) and `listRepoBranches(fullName,
  {bearer})` (the repository's default branch first, the rest alphabetical, duplicates and nameless entries dropped, at most 5 pages = 500 branches with `truncated`, a Link header is only followed
  back to the same API host, the name validated before any request); `client.listBranches` looks the installation up and, when installed, uses a token for THIS repository with `contents: read` (the
  same scoped token a deployment uses), otherwise goes anonymously; a failed installation lookup is an error, not a silent anonymous call. API: `GET /api/github/branches?repo=` (400 `bad_repo` for
  anything that is not owner/name, an array included; the router lists anonymously when NO GitHub App is connected, which works for public repositories; 404 `repo_not_found` (private and not installed, or
  no such repository), 502 `rate_limited` for 403/429, otherwise a generic 502 `github_unreachable`; good answers are kept for 60 s per repository (case-insensitive, at most 100 entries), failures
  never). Dashboard: `ui/popover.jsx` (written by hand in the other ui files' style: the shadcn CLI installs an unrelated package here), `components/branch-picker.jsx`, `lib/branches.js`
  (`branchOptions`, `stepActive`, `startActive`, `isRepoName`), `lib/use-debounced.js`, `useBranches`. The trigger shows the current branch; the list has a search box (case-insensitive), the default
  branch with a "default" badge, a check on the current one, arrows (wrapping) and Enter, Escape closes, up to 100 matches drawn with "N more matches: keep typing", a note when GitHub's list was cut
  short, and, for text that is not exactly a branch, a last option "Use “text”". While loading it is a disabled "Loading branches…" button; if the branches cannot be listed it is the plain text box with
  the reason and "Type the branch name."; a branch that is not among the listed ones gets a quiet warning (not when the list was truncated). The repository is only asked of GitHub once it has settled
  for 400 ms (not on every key). Create form: the branch starts as the repository's default as soon as its branches are known (also for a typed repository the app list does not know), unless the
  person already chose or typed a branch (a branch typed while the list was still loading is kept; a different repository starts again from its own default). Settings tab: the same picker for the
  app's repository. **Checked for real (anonymous, api.github.com):** `octocat/Hello-World` lists `master` first (its default) then the others, a repository that does not exist and a private one
  (`tianyu-00/shipdok-test-app`) are 404, a large public repository (`torvalds/linux`) works. Mutation-proofed (about 55 mutants over the client, the route and the dashboard; the survivors showed that
  duplicates were hidden by the default branch in a test, that failures-not-cached had been mutated in the wrong place, and that the "typed while loading" race and the highlight reset needed their own
  tests; all are now caught). **Not tested:** an installed private repository (needs the administrator's GitHub App; the scoped-token path is the one deployments use and is covered with a fake),
  a repository with hundreds of branches in the list, the picker in a real browser or on a phone, GitHub's real anonymous rate limit (about 60 calls an hour per address, one call pair per repository per
  minute at most).
- **Pasting a GitHub link as the repository (dashboard only, unit-tested; not looked at in a browser):** the create form's repository field accepts a GitHub link and turns it into `owner/name`
  (`apps/web/src/lib/repo.js`): `https://github.com/o/r`, `http://`, `www.`, no scheme, a trailing `/`, `.git`, `/tree/<branch>/...`, `/blob/...`, `/pull/12`, `?query`, `#fragment`, a user@ part,
  `git@github.com:o/r.git`, `ssh://git@github.com/o/r.git`. Only github.com counts (not `github.com.evil.example`, not another host that merely mentions it, not `javascript:` tricks); the result must
  still have the API's owner/name shape; plain `owner/name` and other hosts are left alone (the server says what is wrong). A paste (more than one character arriving at once) converts at once and then
  fills in the name and default branch like a picked repository; a link typed key by key is left alone until the field is left (blur), so it is not rewritten under the person's fingers; a link pasted into
  text already there is not guessed at. **The API stays strict (owner/name only)**; the link is never stored or sent. Mutation-proofed (19 mutants; one survivor showed the `git@github.com:` special case was
  redundant, so it was removed). Not tested: other browsers' paste handling, a link with a port or an unusual host form (`github.com:443`).
- **Repository picker (dashboard; unit-tested; not looked at in a browser, by the administrator's choice):** the repository field of the create form was the browser's native `<input list>` dropdown, which
  the administrator found ugly next to the branch picker. It is now `components/repo-picker.jsx` on a shared `components/combobox.jsx` (the branch picker was moved onto it, with its tests unchanged: the search
  box, the highlight that starts on the current choice and moves with the arrows (wrapping), Enter, Escape, "Use “...”", the footer; the shared version also fixed the "scroll the highlighted option into view"
  selector, which used to require the option to be both selected and highlighted). `lib/repos.js` `repoOptions`: the repositories the GitHub App can see, alphabetical, each marked `private` (with a lock) or `public`;
  the search ignores case and understands a pasted GitHub link (it finds the repository the link points at); a usable owner/name nobody listed is offered last as "Use ..." (a public repository the app is not
  installed on, listed by the branch picker anonymously); a listed repository is not offered twice, whatever its case; 100 are drawn with "N more matches: keep typing". The trigger shows the chosen
  repository with its badge; "Loading repositories…" while the list loads; with no GitHub App (501) or a failed list it is the plain text box again (with the paste-a-link behaviour), so typing always works.
  Create-form tests were moved to the picker flow (open, search, Enter); the link-paste tests now cover both modes. Mutation-proofed (19 mutants over the rules, the picker and the combobox; two survivors were
  an equivalent mutant (the fallback condition, simplified) and a collation option that only matters for names that differ solely by case, which GitHub does not allow, so it was removed). Not tested: the
  picker in a real browser or on a phone, a user with hundreds of repositories.
- **Pi:** early prototype ran on the Pi (ARM64 builds work). The full stack has not been run on the Pi.

## Earlier "Next" notes (Milestone 6 build order, as written before the split)

Kept for the details of what was checked for the docs and the direction decided at the time. CLAUDE.md now has a short "Next".

Direction decided by the administrator and now written into SPEC.md (section 4 password policy and recovery codes, section 5 Connect
GitHub, section 8 "Public exposure", section 20 Milestone 6): Shipdok does NOT ship or manage a tunnel (no `cloudflared`). One admin
account only. No two-factor login; instead a strong password policy, progressive lockout, recent logins and recovery codes. The
administrator provides a public address (own IP, or Nginx / Nginx Proxy Manager / Caddy, possibly behind a tunnel they run) and picks
the mode (`local` / `webhook` / `full`) and the public address in the DASHBOARD (Settings, Public access; stored in the DB, `SHIPDOK_PUBLIC` / `PUBLIC_URL` in `.env` override and show as locked). Goal: `docker compose up`, log in, press "Connect GitHub", install the app, deploy
private repos. No periodic polling. Caddy is an optional, low-priority profile only.

Build order (SPEC.md Milestone 6); steps 1 to 5 (password policy and lockout, recovery codes, public access, Connect GitHub, first-run secrets) are built, step 6 is built and published, see above:
3. Public access is BUILT (see "Public access" under Built and verified); what remains of it is the docs with Nginx / Nginx Proxy Manager / Caddy
   examples, which go with step 7.
4. Connect GitHub is BUILT (see "Connect GitHub" under Built and verified); the administrator still has to try the real button once.
5. First-run secrets is BUILT (see above).
6. Ready-made multi-arch images: BUILT and published (see "Published images"); the Pi pull is part of step 7.
7. Pi: the administrator ran the full stack from the published images on a Pi and it works. DOCS WRITTEN: `README.md` (install, first login,
   Connect GitHub, first deploy), `docs/public-access.md` (modes, what a proxy must do, Nginx / Caddy / Nginx Proxy Manager / Cloudflare Tunnel
   examples), `docs/operations.md` (upgrade, backup, restore, password reset, troubleshooting, uninstall). Checked for real: backup and restore
   into a fresh project (old password logs in, app listed, a stored secret decrypts; backup files need `chmod 600`), the Nginx and Caddy examples in
   all three modes against a live stack (webhook-only and full proxies, Secure cookie, wrong Origin 403, real client address in the sign-ins list;
   Caddy needs `handle` blocks, a bare `respond 404` swallows everything). NOT tested: Nginx Proxy Manager itself, restoring over a non-empty
   install. API docs and the MIT LICENSE are DONE (see "API documentation"). Hardening is DONE (see "Hardening slice"). Nothing from the Milestone 6 list is left except the optional Caddy profile (step 8).
8. Optional: Caddy compose profile for people without a proxy.

Later (idea from the administrator, not started, decided to come back to it): deploying from several GitHub accounts or organisations. Option A (small):
a checkbox on Connect GitHub that makes the app public so one app can be installed on any account the administrator controls, plus an allow-list of
accounts so a stranger's installation does not show up in the repository picker. Option B (large): several separate GitHub Apps (a table instead of
one row, the webhook receiver finds the secret from the app id header GitHub sends, each Shipdok app records its GitHub app, a client per app in the
worker, a merged repository picker, webhook sync per app). Do A first if repositories live on more than one unrelated account; B only for isolation.

- **Several GitHub Apps, one per project (verified with a fake GitHub and signed webhooks in tests through the real receiver, a real database, and the migration run by hand on databases that had the old single app; the dashboard only in jsdom):**
  **Administrator's decisions: one GitHub app's repositories at a time (the app is chosen first, then its repositories); disconnecting an app that projects use is allowed, with a list of those
  projects; a push deploys only the projects assigned to the app that sent it; no limit on how many apps.** Migration 025: table `github_apps` (uuid id, GitHub's `app_id` UNIQUE so the same
  GitHub App cannot be connected twice, the three encrypted secrets, `legacy_context`), `apps.github_app_id` (FK, ON DELETE SET NULL), the old `github_app` row copied with `legacy_context = true` (its
  ciphertext is bound to the field name alone, so it stays readable until saved again) and every existing project assigned to it; the old table is dropped. Checked by hand on a database with the old
  app and two projects (one with a remembered installation: kept) and on one with no app (nothing assigned). Shared `githubapp.js`: `saveGithubApp` (upsert by GitHub's number, returns `{id, created}`),
  `listGithubApps`, `githubAppSummary(id)`, `loadGithubApp(id)`, `loadGithubApps` (an app that cannot be decrypted is listed with `problem: 'cannot_decrypt'`, the others still work), `deleteGithubApp(id)`
  (returns the projects that used it and clears their `github_app_id` and installation), and the provider (`client(id)`, `clients()`, `webhookSecrets()` = `[{id, secret}]`, `status()`; one client per saved
  version of each app so its token cache survives). API: `GET /api/github` lists apps with their `projects`; `POST /api/github/apps` (manual; 201 new, 200 replaced); `DELETE /api/github/apps/:id` (password,
  404 for none); per app `GET .../repos`, `.../installations`, `.../webhook`, `POST .../webhook/sync` (404 `github_app_not_found`, 409 `cannot_decrypt`); `GET /api/github/branches?repo&app=` (anonymous without
  `app`; the one-minute memory is per app); the manifest flow no longer refuses a second app and redirects with `connected=<id>`; a changed public address updates EVERY app's webhook (one failing does not
  stop the others; `githubWebhook.failed` names it). `github_app_id` on create and in `PUT /api/apps/:id` (not a pending setting; the installation is looked up again with the new app, warning if absent,
  nothing asked when the app is unchanged or none). The webhook receiver tries every app's secret and takes the app that signed the delivery; it deploys only projects with that `github_app_id` and the
  history says when the project exists but uses a different app. The job carries `githubAppId`; the worker asks the provider for that app (none: public repositories only). Dashboard: GitHub page = a card
  per app (owner, projects using it as links, install link, check again, its own webhook card, Disconnect with the affected projects listed) then the two ways to add another; the create form has a "GitHub
  app" choice (the only app is chosen for you; with several you must choose, or None; the repository list and branch lists are that app's; None = a plain box and anonymous branches); the Settings tab has a
  "GitHub app" card; native select moved to `components/native-select.jsx`. **Checked:** the migration by hand (above); the receiver with two apps and signed deliveries; mutation-proofed (28 planted bugs on the
  server side all caught, 1 harmless equivalent found and simplified; 40 in the dashboard, 6 survivors that each got a test). **Not tested:** real github.com with two apps (needs a second account: creating the
  second app with the button, installing it, a push through it), a real browser pass of the new screens, the Pi. Known limits: a job queued before the upgrade has no `githubAppId` (rare; deploy again);
  an app with no GitHub app is never deployed by a push; the same repository tracked by projects of two apps is deployed by each app's own pushes only.
  **The GitHub page was then restructured at the administrator's request (option A; checked in jsdom only, mutation-proofed: 21 planted bugs, 4 survived and each got a tighter test or a simplification, one a real
  find: a card for an app whose credentials cannot be read still asked GitHub about its webhook on every refresh, now it does not):** one card per app (name and account, the webhook as a status in the header, the link on GitHub, the App ID and the Install button always visible: *Webhook OK*,
  or *Webhook address differs* with the fix button, *No public address*, *Webhook not checked* with a retry; then folded into Details: the projects using it, where it is installed (asked on demand), Check again, source, date and the webhook address; the Install button stays outside), the two ways to add an app behind one **Add a GitHub app** button (a dialog with two tabs, the manual form closes it when saved), an empty state when none is connected.
  **Afterwards, at the administrator's request:** the GitHub app card in a project's Settings says, in its description above the choice, "Saving does not deploy. Your latest commit is picked up on the next push, or when you press Deploy." (a first longer wording was confusing and ugly, a boxed note was not wanted) (first tried as a pop-up after saving, the administrator preferred it on the card), because the running version looks unchanged after a save and it read as if nothing had happened.
  **Log line for a refused webhook (asked for after a real case: pushes went to a different Shipdok that did not know the app's secret and the only symptom was an empty history):** a delivery no stored secret
  signed is still answered with the same plain 401, and now also leaves one `console.warn` line in the API log: the GitHub App number from `X-GitHub-Hook-Installation-Target-ID` (digits only, else it
  says GitHub did not say), whether a connected app has that number (then "does not match the webhook secret stored for <name>", else "no connected GitHub app with that ID" and where to add it), never the
  signature, body or a secret; at most one line a minute per sender (a 100-sender memory that resets), nothing stored in the database. Nothing is logged for the 503 (no app connected). `webhookSecrets()`
  entries now also carry `appId` and `name`. Not tested: against a real misconfigured GitHub app (the header's presence is GitHub's documented behaviour).
  **The same, in the dashboard (asked for next):** `src/webhookrefusals.js` keeps, in memory only, one entry per sender (GitHub's app number or none): number, time of the newest, count; bounded to 100 senders, forgotten after a
  day, cleared by a properly signed delivery from that app, by entering that app again (new secret) and by disconnecting it. `GET /api/github` adds `refusedPush {at, count}` to the app whose secret did not match and
  `unknownSenders [{appNumber|null, at, count}]` for the rest; nothing from the request is kept. Dashboard: a warning on the app's card with an **Enter the secret again** button (opens "I already have one" with the
  App ID filled in, never a secret), a notice at the top for each unknown sender with **Add this app** (same, with the number from the push), none of it when nothing was refused; the GitHub list is read every 30 s so
  it shows up without a reload. Lost when the API restarts (the next refused push repeats it). Not looked at in a real browser.
  **Dismiss (asked for after):** every unknown-sender notice has a **Dismiss** button: `DELETE /api/github/refusals/:sender` (digits, or `none` for a push that did not say; anything else 404; needs a session, no password) forgets that sender's record and nothing else, so the next refused push brings the notice back. Server-side, so it is gone in every browser. Checked: API tests (only that sender forgotten, comes back, `none`, bad value 404, signed-in needed), web tests (the right path is called, the notice goes on the next fetch), three planted bugs (no validation, wrong sender sent: caught; one redundant mapping survived as equivalent and was removed). Not on the app-card warning (asked for only the unknown-sender notices). Not looked at in a real browser.
  The separate webhook cards and the two big forms are gone (`github-app-card.jsx`, `github-add-dialog.jsx`, `github-connect-form.jsx`, `github-manual-form.jsx`). Not looked at in a real browser.

- **Volume sizes (verified with the worker's own code against the real Docker daemon, a real database and in unit tests; the screens in jsdom only):** **Administrator's decision: measured on request, never by itself** (Docker has
  to walk every file of a volume: about 4 seconds for 29 volumes here, more on a big one or a Pi's SD card). Migration 026: `app_volumes.size_bytes` and `measured_at`, and a one-row table `volume_sizing`
  (`requested_at`, `finished_at`, `last_error`). API: `POST /api/volumes/sizes` records the request (202; 409 `already_measuring`; an unanswered request stops blocking after 30 minutes; **no job on the
  deployment queue**), `GET /api/volumes/sizes` says how it stands (`measuring`, `finishedAt`, `error`, `totalBytes`, `measured`); every volume in `GET /api/apps/:id/volumes`, the save answer and
  `GET /api/volumes` carries `sizeBytes` / `measuredAt`; `GET /api/storage` has `volumes {totalBytes, measuredAt, apps [{appId, slug, count, measured, bytes}]}` (volumes whose app is gone are in the total only).
  Worker: `volumesize.js` looks for a request every 3 seconds (one cheap query) beside the queue, asks Docker once (`docker.js` `volumeSizes`: `GET /system/df?type=volume`, a Map of name to bytes; -1 or a missing
  size is left out, zero is kept), writes every Shipdok volume's size and the time (a volume Docker has not created yet gets the time and no size), ends the request and records "Docker could not measure the
  volumes" on failure (never Docker's own words; the old sizes stay); it keeps listening after a failure. Dashboard: a **Measure sizes** button with its state ("Not measured yet", "Measuring… Docker adds up every
  file", "Measured 5 min ago", the error), on the Storage page and in an app's Persistent storage card; it polls every 2 s only while measuring, then reads every size again and says so; a **Volumes** column on the Storage
  page (none / not measured / the size and how many, "2 of 3 measured"), counted in each app's total and in the card's total line; a size under each path in Settings ("5.0 MB, measured 3 min ago", "Size not measured yet",
  "Not created in Docker yet"); a Size column for the volumes kept without an app. **Checked for real:** a throwaway volume holding exactly 3,000,000 bytes in a file and 1,000 in another; `volumeSizes()` against the local
  Docker said 3,001,000 (then removed). Mutation-proofed (36 planted bugs across worker, API and dashboard; 2 survived, a button that was not off while its own request was on its way or while the status loaded, and both
  got a test; a route that returned zeros when the single status row was missing was found by a test and fixed). **Not tested:** the Pi (SD card speed), a volume of many gigabytes, a real browser pass. Known limits:
  the figures are a snapshot (measure again to refresh), a path added since is not counted until measured, nothing measures automatically.

Known gaps (persistent volumes are built; see above): old `shipdok/*` images pile up until the administrator prunes (or turns on `auto_prune`); build-time env vars; Railpack; DB backup docs.
The portfolio backend (`tianyu-00/TianYuSiteV2`, `backend/`, port 9090) is not yet deployed through the platform.
