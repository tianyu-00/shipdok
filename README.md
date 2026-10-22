# Shipdok

Shipdok is a small, self-hosted platform for running your own apps. Point it at a GitHub repository and it builds the
app into a Docker container and runs it. Every time you push, it deploys the new version, checks that it is healthy
before switching to it, and keeps the old version running if anything goes wrong.

It is made for **one administrator on one machine**: a Raspberry Pi, a home server or a small VPS. There is no
multi-user system, no cluster and no hosted service. It is meant to be installed with Docker Compose and then managed from a web
dashboard.

- Deploys any repository that has a `Dockerfile` (or, with Railpack, code that has none), from GitHub (private repositories too), with a GitHub App that you create from the dashboard in one click. Connect one for each GitHub account or organisation, and choose which one each app uses.
- Every push to the tracked branch builds and deploys automatically. The newest push wins.
- A new version replaces the old one only after it starts and passes its health check. Roll back to the previous version in one click.
- Persistent storage: keep an app's files across redeploys (Docker volumes), with safe defaults when you delete things.
- Encrypted environment variables, build and app logs, CPU and memory charts, crash detection with automatic restarts.
- Runs on **ARM64 (Raspberry Pi 4/5)** and **x86-64**. Ready-made images for both.
- Nothing is exposed to the internet unless you choose to ([public access](docs/public-access.md)).

## What you need

- A Linux machine with **Docker Engine** and the **Docker Compose** plugin (`docker compose version` should work).
- A GitHub account that owns, or can read, the repositories you want to deploy.
- To receive push notifications from GitHub, a public address that reaches Shipdok (see [Public access](docs/public-access.md)). Without one
  you can still deploy by pressing a button in the dashboard.

Shipdok was developed for a Raspberry Pi 4 (8 GB) and tested on x86-64 Linux.

## Install

Pick a folder and keep using it: Docker Compose names its storage after the folder, so running it from somewhere else later would start
with an empty installation.

```bash
mkdir -p ~/shipdok && cd ~/shipdok
```

Download the Compose file:

```bash
curl -fsSLO https://raw.githubusercontent.com/tianyu-00/shipdok/publish/infrastructure/compose.yaml
```

Start everything. This pulls the ready-made images and needs no other file or setting:

```bash
docker compose up -d
```

The first start generates the passwords and keys Shipdok needs. Print the one-time **setup token**:

```bash
docker compose logs api
```

Open the dashboard at `http://localhost:8080` and create the administrator account with that token. To open it from another
device on your network, see [Reaching the dashboard](#reaching-the-dashboard-from-another-device).

### Save your recovery codes

When the account is created Shipdok shows ten **recovery codes**. Save them somewhere safe (a password manager is ideal). If you forget
your password, a recovery code is how you get back in without touching the server. Each code works once, and anyone who holds the codes can
take over the account, so keep them private.

## Deploy your first app

1. Open **GitHub** in the dashboard and press **Add a GitHub app** (the first tab, **Create one for me**). Shipdok creates a private GitHub App for you (you confirm it on
   github.com). Then press **Install on repositories** and choose which repositories Shipdok may read. It only ever asks for read-only access to
   code.
2. Press **Check again** on the GitHub page. Your repositories appear.
3. Create an app (three steps): choose the GitHub app (or none, for a public repository) and the repository, and Shipdok checks it can see it; then choose where the app is in the repository and how to build it (**Railpack** by default, or your own **Dockerfile**: [how Railpack works](docs/operations.md#apps-without-a-dockerfile-railpack)); then fill in the rest. A private repository needs a GitHub app that is installed on it: if Shipdok cannot see the repository it says so and how to fix it. Creating an app does not deploy it: press Deploy when you are ready.
4. Press **Deploy**. Watch the build log, then open the app's address.

Pushes to the tracked branch now deploy automatically once GitHub can reach Shipdok: set a public address under **Security → Public
access** (see [Public access](docs/public-access.md)). Each GitHub app's card shows whether its webhook address is right (and fixes it with one click), and Shipdok keeps GitHub's copy in sync.

Repositories on more than one GitHub account or organisation? Press **Add a GitHub app** again on the GitHub page for each one, and see
[Several GitHub accounts](docs/operations.md#several-github-accounts).

## Reaching the dashboard from another device

By default the dashboard only answers on the machine itself. To open it from other devices on your network, tell Compose which address to
listen on. Create a file named `.env` next to `compose.yaml`:

```bash
echo 'WEB_BIND=0.0.0.0' > .env
```

```bash
docker compose up -d
```

Then open `http://<the machine's address>:8080`. Do not forward this port from your router; to reach Shipdok from the internet use a proxy
as described in [Public access](docs/public-access.md).

## Everyday use

| Task | Where |
|---|---|
| Upgrade, back up, restore, troubleshoot | [Operations](docs/operations.md) |
| What is protected, and the risks to know about | [Security](docs/security.md) |
| Put Shipdok behind Nginx, Caddy, Nginx Proxy Manager or a tunnel | [Public access](docs/public-access.md) |
| Forgot the password | use a recovery code on the login screen, or [reset it on the host](docs/operations.md#forgot-the-password) |
| Look up an API call | the API reference at `/api/docs` in the dashboard's address (signed in; switch off with `API_DOCS=false`) |
| Every setting | [`.env.example`](.env.example) (all optional) |

## How it is put together

Five containers, started by one Compose file:

| Service | What it does |
|---|---|
| `web` | Serves the dashboard and passes `/api` on to the API. This is the only service published to your network. |
| `api` | The backend: accounts, apps, deployments, GitHub webhooks. Brings the database up to date when it starts. |
| `worker` | Clones, builds and runs your apps. It is the **only** service that can use the Docker socket. |
| `postgres` | Shipdok's own database (apps, settings, history, encrypted secrets). |
| `redis` | The job queue. |

A one-shot `secrets` service also runs at every start to generate any missing passwords and keys, and then exits. Its stopped container
is expected.

**Security notes.** The worker holds the Docker socket, which is equivalent to root on the machine, so only deploy code you trust. Secrets are
encrypted in the database with a key stored in the `shipdok_secrets` volume. Back that volume up together with the database: the Storage page of the
dashboard makes backups of both (one file, optionally encrypted with a passphrase, daily by default) that you can download; see
[Operations](docs/operations.md#backup).

## License

MIT, see [LICENSE](LICENSE).

## Developing Shipdok

See [CLAUDE.md](CLAUDE.md) for how the code is laid out and how to run it with npm and the test suites, and [SPEC.md](SPEC.md) for the
full design.

To build the images from this checkout instead of pulling the published ones:

```bash
docker compose -f infrastructure/compose.yaml -f infrastructure/compose.build.yaml up -d --build
```
