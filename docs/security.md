# Security

What Shipdok protects, what it does not, and what you should do about the rest. Shipdok is built for **one administrator on one machine**.
Read the [residual risks](#what-it-does-not-protect-you-from) before putting it on the internet.

## The most important thing to know

Shipdok builds and runs code from your repositories, and its worker controls Docker. Docker control is the same as **root on the machine**.
So anyone who can sign in to the dashboard can run any program on the host, and a compromised dashboard is a compromised machine. Everything
below exists to make signing in hard for anyone but you, and to limit the damage when something goes wrong. There is **no two-factor login**.

## What is protected

**Signing in**
- Passwords are stored as argon2id hashes and must be 12 to 256 characters, not a short pattern repeated, not a plain run such as `123456789012`,
  and not contain the username. (There is no common-password list, so `password123456` is not caught. Use a long, random password.)
- Failed tries are counted per name and per address. After five in a row the next ones wait 30 seconds, doubling up to 15 minutes per name and
  60 minutes per address, and the right password is refused while locked.
- The **Security** page lists recent sign-in attempts (good and bad, with addresses) and security changes.
- Ten **recovery codes** are made at setup. They are stored only as hashes, work once, and are as powerful as a password: keep them offline.
- Sessions end after 30 minutes of inactivity or 12 hours in all. The cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` when your proxy says
  the visit used HTTPS. "Sign out everywhere" ends every session.
- Changing the password, making new recovery codes, changing public access and connecting or disconnecting GitHub all ask for your password
  again, so a stolen session alone is not enough.

**Who can reach it**
- By default **nothing is reachable from outside your network**. Three modes (`local`, `webhook`, `full`) decide what outside visitors get, and
  the rule fails closed: a visitor that cannot be shown to be local counts as outside. See [Public access](public-access.md).
- Every request that changes something must come from one of Shipdok's own addresses (an `Origin` check).
- Postgres and Redis are not published on the machine, and only the `worker` service gets the Docker socket.

**Secrets**
- App variables, each GitHub App's private key, webhook secret and client secret are encrypted in the database (AES-256-GCM, each bound to its
  own name, and a GitHub App's to that app as well, so a value moved to another field or to another GitHub App does not decrypt). The key lives in the `shipdok_secrets` volume and is generated on first run.
- Variable values are never returned by the API except by an explicit **reveal**, and are masked (`***`) in build and app logs.
- GitHub webhooks are accepted only with a valid HMAC signature, checked on the exact bytes received, in constant time, and each delivery is
  processed once. With several GitHub Apps connected, a delivery is believed if one of their secrets signed it, and then deploys only the apps assigned to
  that GitHub App: an app cannot cause a deployment of a project that uses another.
- The GitHub App asks only for **read-only** access to code and metadata. A build gets a token for the one repository it is cloning, handed to
  git through the environment (never on a command line or in a log), and git runs without access to Shipdok's own secrets.

**What your apps run in**
- Each app runs in its own container with a memory limit, a CPU limit, **no privileged mode, no Docker socket, no host mounts**,
  and a limit of 512 processes (so a fork bomb cannot take down the machine). Docker's default capabilities are kept, and `no-new-privileges`
  is **not** set, so a repository that needs to elevate inside its container (setuid programs, `sudo`, low ports) keeps working.
- The app is reached only on its own published port. Containers and images are labelled, so Shipdok only ever cleans up what it created.
- A new version replaces the old one only after it starts and passes its health check; otherwise the old one keeps running.

## What it does not protect you from

- **A signed-in administrator, or anyone who steals a session, recovery codes or your password, owns the host.** Treat these like root access.
- **Code you deploy is trusted.** Builds run `docker build` on your machine. BuildKit is not a complete security boundary, so only deploy
  repositories you trust. App containers can reach your local network and the internet like any container on the default Docker network.
- **No build time limit by default.** A build that never finishes blocks the queue until cancelled. Set a **Build time limit** on each app
  (Settings) to have a runaway clone or build stopped.
- **Railpack (apps without a Dockerfile) adds code you did not write to the build.** Its install, build and start commands run inside the build like a Dockerfile's steps (same
  trust as above). The *planning* step (`railpack prepare`) runs inside the **worker**, the one container that has the Docker socket, and reads the repository's files to decide
  what to build; a repository with a `mise.toml` containing command templates, hooks and tasks did not make it run anything in a test, but that is one test, not a proof. It
  also downloads a helper from github.com and builds on images from ghcr.io (`railpack-frontend`, `railpack-builder`, `railpack-runtime`) that Railpack's authors publish: you trust
  them as you trust any base image. Prefer the Dockerfile method for a repository you do not trust.
- **Build arguments are baked into the image.** A variable set to "Build only" or "Build and runtime" and passed as a *build argument* that the Dockerfile uses with `ARG`
  ends up in the image's layers and history, readable by anyone who can read the image (anyone who controls Docker on the host). Use arguments for public settings.
  For tokens and passwords choose **Build secret**: BuildKit mounts it for one `RUN` step and stores nothing in the image. A secret is still readable by the commands of
  that step, and a changed secret does not re-run a cached step (use Deploy without cache).
- **App data in persistent storage is not backed up or encrypted by Shipdok.** It is plain files in a Docker volume on the host, readable by
  anyone who controls Docker. Deleting an app keeps its volumes by default, and deleting a volume is permanent.
- **The disk.** Builds and logs use disk. The dashboard warns at 20% and 10% free and refuses new builds at 10%, but a build can still fill a disk
  quickly; keep an eye on the Storage page.
- **No audit of who revealed which variable.** Anyone signed in can reveal and change variables (and can deploy code that reads them anyway).
- **HTTP is not encrypted.** The dashboard itself speaks plain HTTP; HTTPS comes from your proxy or tunnel. Do not use `full` mode without it.
- **Volume backups hold whatever your app stores.** A backup of an app's volumes (Storage page) is a copy of its files, which may include passwords, tokens or personal data. It is made by a helper container with no network that mounts the volumes read-only and is removed at once, and it is encrypted with the same passphrase as the other backups when one is set (and downloading it asks for the password again). Without a passphrase it is a plain file on the backups volume.
- **A restore overwrites live data and runs as root in a helper container.** It asks for the current password and is recorded in the sign-ins list. The helper (made from the worker's own image, no network, read-only root) is the only thing that writes into an app's volumes, as root, because the files belong to the app's users; it is only given the volumes the backup holds, and the files come from a backup file that was opened by Shipdok (a plain backup file can be changed by whoever can write to the backups volume, so encrypt backups if that matters: the encrypted format is authenticated). The passphrase given with a restore is stored encrypted with the platform key for that one restore only and removed when it ends.
- **Backups contain secrets.** The database dump and the secrets volume together decrypt everything. Keep them private and off the machine. Backups made from the dashboard can be encrypted with a passphrase (AES-256-GCM, key from scrypt); the passphrase is also stored in the database, encrypted with the platform key, so that scheduled backups can use it: whoever has the database AND the platform key has it, which is the same trust as everything else Shipdok holds. A backup that is NOT encrypted holds every secret in a file readable by whoever can read the backups volume, which is why downloading one asks for the password again.
- **The setup token** is printed in the API log until the first account exists. Create the account before exposing the machine.
- **No two-factor login.** A strong unique password and offline recovery codes are what you have.

## What to do

1. Keep the default `local` mode, or `webhook` mode if you want deploy-on-push, and forward **only** the webhook path in your proxy
   ([examples](public-access.md)). Use `full` mode only over HTTPS, and only if you really need it.
2. Use a long, unique password. Store the recovery codes somewhere safe and offline.
3. Set a **Build time limit** on apps whose builds you do not fully control.
4. Deploy only code you trust, from repositories you control.
5. Back up the database and the secrets volume together ([Operations](operations.md#backup)), and keep the backups private.
6. Keep Docker, the operating system and Shipdok up to date ([Upgrade](operations.md#upgrade)).
7. Put the machine behind a firewall; Shipdok's dashboard port should not be forwarded from your router.

## Reporting a problem

If you find a security problem in Shipdok, please open a private security advisory on the GitHub repository instead of a public issue.
