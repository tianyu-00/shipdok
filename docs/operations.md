# Operations

Everyday care of a Shipdok installation: upgrading, backing up and restoring, getting back in when you are locked out, and fixing common
problems. All commands are run **in the folder that holds `compose.yaml`**, the same folder every time (Docker Compose names its storage after
the folder, so a different folder means an empty installation).

- [Upgrade](#upgrade)
- [Backup](#backup)
- [Restore](#restore)
- [Persistent storage of your apps](#persistent-storage-of-your-apps)
- [Build cache](#build-cache)
- [Build-time variables](#build-time-variables) (and [build secrets](#build-secrets))
- [Forgot the password](#forgot-the-password)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)

## Upgrade

Releases are published as versioned images. Upgrading is a pull and a restart, and it keeps all your data.

1. **Back up first** ([Backup](#backup)). Database changes only go forward: Shipdok cannot undo them, so the safe way back from a bad
   upgrade is a restore.
2. Get the newest Compose file if the release notes say it changed (see the [releases page](https://github.com/tianyu-00/shipdok/releases)).
3. Pull and restart:

```bash
docker compose pull
```

```bash
docker compose up -d
```

The API updates the database itself when it starts (you will see `Applied N migration(s)` in `docker compose logs api`). Your running apps keep
running; they are separate containers.

**Pinning a version.** By default Compose uses `latest`. To stay on a release until you choose to move, put it in a `.env` file next to
`compose.yaml`:

```bash
echo 'SHIPDOK_VERSION=0.1.2' >> .env
```

Then `docker compose pull` and `docker compose up -d` install exactly that version. Remove the line (or change it) to move.

**If an upgrade fails to start.** `docker compose logs api` shows `The database could not be prepared: Migration NNN failed: ...`. The API keeps
restarting and changes nothing else. Go back by restoring the backup you took in step 1 together with the previous version
(`SHIPDOK_VERSION=<old>`), and report the message.

## Backup

Two things hold everything that matters, and **they must be backed up together**:

- **The database** (`shipdok_pgdata`): your apps, settings, history, and your secrets, encrypted.
- **The secrets volume** (`shipdok_secrets`): the encryption key and the other generated secrets. **Without this key the encrypted data in the
  database (app variables, GitHub credentials) can never be read again.**

Not included, and not needed: the job queue (Redis), Docker images and the containers of your apps, and your apps' own data volumes. After
a restore your apps are redeployed from GitHub. Back up the logs volume (`shipdok_logs`) too only if you care about old logs.

The backup files contain secrets. Make them readable by you only, and keep them somewhere safe and **off this machine**.

Make files private as they are created, then take both backups:

```bash
umask 077
```

```bash
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > shipdok-db.dump
```

```bash
docker compose run --rm --no-deps --user "$(id -u):$(id -g)" -v "$PWD":/backup --entrypoint tar secrets czf /backup/shipdok-secrets.tgz -C /run/shipdok-secrets .
```

```bash
chmod 600 shipdok-db.dump shipdok-secrets.tgz
```

You now have `shipdok-db.dump` and `shipdok-secrets.tgz`. Copy both away. A copy of only one of them is not a backup.

## Restore

Restoring into a **new, empty** installation (a new machine, or after you removed the old one) is the tested path. Use the same folder name as
before or any new folder; the commands do not depend on it.

1. Put `compose.yaml`, `shipdok-db.dump` and `shipdok-secrets.tgz` in the folder. If you pinned a version, set `SHIPDOK_VERSION` in `.env` to the
   one the backup came from (or newer; older is not supported).

2. Restore the secrets first, into the new secrets volume. This must happen before the first `docker compose up`, which would otherwise
   generate new ones:

```bash
docker compose run --rm --no-deps -v "$PWD":/backup --entrypoint tar secrets xzf /backup/shipdok-secrets.tgz -C /run/shipdok-secrets
```

3. Start only the database. It takes its password from the restored secrets:

```bash
docker compose up -d postgres
```

4. Wait until `docker compose ps postgres` says `healthy`, then load the dump:

```bash
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' < shipdok-db.dump
```

5. Start everything:

```bash
docker compose up -d
```

Log in with your old password. Your apps are listed with their settings and history; their containers are gone, so each shows **Container missing**: press **Deploy**
on it (or push to GitHub). Stored variables work because the key came back with the secrets.

**Replacing a broken installation on the same machine.** Remove its storage first, then follow the steps above. This deletes all Shipdok data on this
machine, so be sure the backup is good:

```bash
docker compose down -v
```

## Persistent storage of your apps

An app's files normally disappear when it is redeployed, because a new container replaces the old one. To keep files (uploads, a SQLite
database), list the folders to keep in the app's **Settings → Persistent storage**. Each becomes a Docker volume that every version of the app
mounts, so the files survive redeploys, rollbacks, restarts and image clean-ups.

- **It applies from the next deployment.** The first deployment after you add a path creates the volume. Image files that already exist at that
  path are copied into the new volume once.
- **A new version is first checked with a throwaway volume**, not your real one, so the old version's data is not touched while both run.
- **Rolling back does not roll back the data.** Only the image and the settings go back.
- **Do not persist the folder your app's code lives in** (often `/app` or `/usr/src/app`). The volume keeps an old copy of the code and hides
  every new deployment's code behind it, so new pushes keep running old code. Use a data folder such as `/data` or `/app/data`. The dashboard
  warns when you type one of the common code folders (it does not block it).
- **Permissions:** if your app runs as a non-root user, create the folder in your Dockerfile and give that user ownership
  (`RUN mkdir -p /data && chown app:app /data`), or the app cannot write to it.
- **Removing a path never deletes data.** The volume is kept (shown as "kept but not mounted"), and adding the same path again brings it back.
- **Deleting an app keeps its volumes by default.** They stay listed on the **Storage** page as "Volumes kept without an app". Tick "Also permanently
  delete its volumes" in the delete dialog to remove them with the app, or delete one later from the Storage page. Deleting is permanent.
- **Image clean-up and log deletion never touch volumes.**

**Back up a volume.** Shipdok does not back up your apps' volumes. The Docker name of each volume (`shipdok-vol-...`) is shown under its path in
Settings. Stop the app first if it writes continuously, then, in a folder you control:

```bash
umask 077
```

```bash
docker run --rm -v shipdok-vol-XXXX:/data:ro -v "$PWD":/backup alpine tar czf /backup/my-app-data.tgz -C /data .
```

```bash
chmod 600 my-app-data.tgz
```

**Restore** into an empty volume (for example a new app's, after its first deployment created it):

```bash
docker run --rm -v shipdok-vol-XXXX:/data -v "$PWD":/backup alpine tar xzf /backup/my-app-data.tgz -C /data
```

Backups of app data can hold anything your app stores, so keep them private. They are separate from the [platform backup](#backup).

## Build cache

Docker keeps the steps of every build so the next build is faster. All apps share this cache, so it belongs to no app, it grows with every
build, and the per-app image clean-up does not remove it. On a small disk (a Raspberry Pi's SD card) it can become the biggest thing Shipdok leaves
behind.

The **Storage** page has a **Build cache** card with its size (measured every few minutes, so the figure says how old it is) and two buttons:

- **Clean unused cache** removes cache that no build has used for the last 24 hours. Apps you deploy often keep their cache and stay fast.
- **Clean everything unused** removes all cache that no build is using right now. The next build of each app starts from nothing, runs every step
  again and downloads packages again, which can take several minutes on a Pi.

A clean-up waits its turn on the same queue as deployments, so it never runs during a build, and only one runs at a time. It removes build cache
only: **no images, containers, volumes or logs**.

**Deploy without cache.** If a build keeps an old result it should not (a layer that never refreshes, a dependency that was cached), open the menu
next to **Deploy** on the app page and choose **Deploy without cache…**. That one deployment runs every build step again (`docker build --no-cache`).
The base image is not downloaded again if it is already on the machine, and the next deployment, or a push, uses the cache as usual. It is not
available for webhook pushes or rollbacks (a rollback builds nothing).

## Build-time variables

Most variables are for the running app. Some frameworks need a value while the app is **built**: Vite reads `VITE_*` and Next.js reads
`NEXT_PUBLIC_*` when they bundle the code, and a build may need a token to install private packages. Each variable on the app's **Variables** tab shows a badge
saying where it is available, and the **Available in** choice is in the pencil (edit) view and on the add form:

- **Runtime** (the default, and what every existing variable is): the running container only.
- **Build only**: passed to `docker build` as a build argument. The container never sees it.
- **Build and runtime**: both.

For the build to receive a value, **the Dockerfile must declare it**:

```dockerfile
ARG VITE_API_URL
RUN npm run build
```

A variable the Dockerfile does not declare is simply ignored (Docker may print a warning). The value is available to the `RUN` steps after its `ARG` line.

- **A build argument is baked into the image if the Dockerfile uses it.** `docker history` on the image shows it, and so does anyone who can read the
  image. Use arguments for public settings such as an API address. Docker itself warns about `ARG` names such as `TOKEN` and `PASSWORD`. For a token or
  password use a **build secret** instead (next section).
- Changing a variable or its setting applies from the next deployment, like any variable.
- Values never appear on a command line: they travel in the environment of the `docker build` command, which has only what it needs, none of the
  worker's own secrets. They are masked (`***`) in the build log, like other variables.
- Names that change how the build itself runs cannot be build variables (`PATH`, `HOME`, `LANG`, `DOCKER_*`, `BUILDKIT_*`, `LD_*` and a few more); they can
  still be runtime variables. The dashboard tells you before you save.
- A changed build argument makes Docker rebuild from the step that first uses it (a changed build secret does not; see below).
- You can rename a variable in its edit dialog: the value is kept (it is re-encrypted for the new name on the server), the running app keeps the old name
  until the next deployment, and a name another variable already has is refused.
- A pasted **.env** import adds runtime variables, and never changes the setting of a variable that already exists. Rollbacks build nothing, so they ignore
  build variables.

### Build secrets

When a variable reaches the build (**Build only** or **Build and runtime**), the **Passed to the build as** choice says how: **Build argument** (the default, above) or
**Build secret**. A secret is handed to BuildKit with `docker build --secret id=NAME,env=NAME`. It exists only while the one `RUN` step that asks for it runs, and
**nothing of it is stored in the image or its history**. The Dockerfile has to ask for it, with the variable's name as the id (the dashboard shows the line for the
name you have typed):

```dockerfile
RUN --mount=type=secret,id=NPM_TOKEN,env=NPM_TOKEN npm ci
```

- Inside that step the value is the environment variable `NPM_TOKEN`. (The `env=` part is what gives it that name; without it the secret is a file under
  `/run/secrets/` instead, which Shipdok does not rely on.) Other steps do not see it, and neither does the running container unless the variable is **Build and runtime**.
- A step that does not ask for it never sees it, and there is no warning if the Dockerfile forgets to ask.
- **A changed secret does not re-run a step Docker has cached**, because BuildKit does not put the secret's value in the cache key. After changing one, use
  **Deploy without cache** (the menu next to Deploy) so the step runs again with the new value.
- The same name rules apply as for arguments, the value travels the same way (docker's own environment, never a command line) and it is masked in the build log.
  Only what the step itself prints could leak it: do not echo it.
- A secret used by a step is still readable by that step's commands, so anything that step installs or runs can read it.

## Forgot the password

Use a **recovery code** on the login screen: *Lost your password? Use a recovery code.* Each code works once.

If you have no codes left, reset the password on the machine. This prints a new random password once, signs every browser out and lifts any
sign-in lockout:

```bash
docker compose exec api node scripts/reset-password.js
```

Then log in with the printed password and change it on the **Security** page. While you are there, make a new set of recovery codes.

A locked-out account (too many wrong passwords) opens by itself after the wait the login screen shows (30 seconds, growing to 15 minutes).

## Troubleshooting

**Where are the logs?** `docker compose logs api`, `docker compose logs worker`, and `docker compose ps -a` for what is running.
The `secrets` container shows as *Exited (0)*; that is normal.

**I lost the setup token.** It is printed while no account exists: `docker compose logs api`.

**The dashboard shows "Not found" or a message about the address.** Shipdok is refusing the request:
- From another device on your network: set `WEB_BIND=0.0.0.0` (see the README).
- Through a proxy: the proxy must pass the original `Host` header and add `X-Forwarded-For` and `X-Forwarded-Proto`
  ([Public access](public-access.md#what-your-proxy-must-do)).

**Port 8080 (or 4000) is already in use.** Set another one in `.env`: `WEB_HOST_PORT=8081` (or `API_HOST_PORT`). The API's port is not
the dashboard's.

**GitHub says the webhook delivery failed.** In **Security → Public access** the mode must be *Webhook only* or *Full access* and the public address
must be right. Check the GitHub page's *Webhook address* card, and `docker compose logs api`. A delivery that arrived appears in the app's history.
A `503` means no GitHub App is connected yet.

**An app shows "Container missing".** Its container was removed outside Shipdok (for example `docker rm`). Nothing is running. Press **Deploy** to
bring it back.

**A deployment fails.** Open the deployment's build log in the dashboard; the reason is almost always in the last lines. For problems before the
build (cloning, GitHub access) also check `docker compose logs worker`.

**A deployment never finishes.** A build that hangs blocks the other deployments until you press **Cancel** on it. To have a runaway clone or
build stopped automatically, set a **Build time limit** (minutes) in the app's **Settings** (empty means no limit, the default). The
limit applies from the next deployment and covers the clone and the build; the running version is never touched.

**The disk is filling up.** The **Storage** page shows where. Old images are cleaned up from each app's **Images** tab (or turn on
automatic clean-up), old logs from the Storage page, and the shared [build cache](#build-cache) from its card there.

**My data seems empty after restarting.** Compose was probably run from a different folder, which starts a new installation. List the storage
with `docker volume ls` (names end in `_shipdok_pgdata`) and go back to the original folder.

## Uninstall

This removes Shipdok and all its data (not your apps' containers, which Shipdok created; remove those separately if you want them gone):

```bash
docker compose down -v
```

To keep the data, leave out `-v`.
