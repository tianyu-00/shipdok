# Shipdok — Product & Technical Specification

**Status:** Consolidated MVP specification  
**Tagline:** Build it. Ship it. Own it.  
**Product type:** Self-hosted, single-host PaaS  
**Audience:** One administrator / personal use  
**Implementation preference:** JavaScript rather than TypeScript

> This document consolidates the decisions made during the Shipdok requirements discussion. Items marked **Open decision** remain unresolved; items marked **Validate in prototype** require practical testing before being treated as proven.

## 1. Product vision

Shipdok is an open-source, self-hostable platform inspired by Railway, Render, and Vercel. It lets an administrator connect a GitHub repository, configure a service, build an image, and deploy it as a Docker container on a Linux host they control.

The initial target is a Raspberry Pi 4 with 8 GB RAM. The design must remain useful on other standard Linux Docker hosts, but the MVP is deliberately single-host and resource-conscious.

### Goals

- Deploy one application container per Shipdok application.
- Support GitHub push-triggered deployments and manual deployments.
- Support Dockerfiles, automatic buildpack detection, and custom build/start commands.
- Make deployment state, logs, resource usage, and failures understandable.
- Preserve the last successful version when a new deployment fails, where technically possible.
- Keep applications and persistent data safe during cleanup and platform recovery.
- Operate privately on a LAN or VPN by default.
- Let the administrator choose, explicitly, to make Shipdok reachable from the internet on an address they provide: either the GitHub webhook only, or the whole dashboard (see section 8, "Public exposure").
- Be installable with Docker Compose alone: prebuilt multi-architecture images, secrets generated on first run, and the GitHub App created from the dashboard with one click.

### Non-goals for the MVP

- Kubernetes, Docker Swarm, or cluster orchestration.
- Multi-host scheduling or remote build agents.
- Full Docker Compose application import or multi-container application deployment.
- Public registration, teams, invitations, or multi-tenant access.
- Built-in domain routing for deployed applications, or TLS certificate issuance and renewal in the core platform. Shipdok does not ship, run, or manage a tunnel (for example Cloudflare Tunnel). An optional, off-by-default Caddy profile may be provided purely as a convenience for administrators who have no reverse proxy of their own.
- Two-factor authentication. The administrator's protection is a strong password, login lockout, and recovery codes (section 4). Optional two-factor login may be added later.
- Pull-request preview deployments.
- Provisioning or managing databases for deployed applications.
- Automatic scheduled backups of Shipdok's database or application volumes.
- Dashboard editing or uploading of arbitrary application configuration files.
- Existing-container adoption.
- Automatic Shipdok self-upgrades.
- Historical metrics, advanced alerting, or a dedicated time-series database.

## 2. Target environment and operating assumptions

- **Initial host:** Raspberry Pi 4, 8 GB RAM, Linux, Docker Engine.
- **Development environment:** Windows with WSL2 and Docker Desktop.
- **Architecture:** Native host architecture only in the MVP. On the Pi, target the host's actual architecture, expected to be ARM64 where the OS is 64-bit.
- Detect incompatible images or dependencies and show clear errors. Do not attempt cross-architecture emulation in the MVP.
- **Network access:** Private LAN/VPN access by default. Shipdok must not configure router port forwarding itself. Public exposure is an explicit administrator choice made through a public address that the administrator provides and a proxy or port forward that the administrator operates (section 8, "Public exposure").
- **Build concurrency:** One active build at a time; other build jobs wait in a persistent queue.
- **Resource constraints:** The host's RAM, CPU, and disk are shared by Shipdok, builds, and deployed applications.
- **Internet dependency:** Existing applications and the local dashboard should continue to work during an internet outage where the host and LAN remain operational. Internet-dependent builds fail clearly and require manual retry.

## 3. Technology and service architecture

### Preferred stack

- **Dashboard:** React JavaScript + Tailwind CSS.
- **API:** Node.js + Express.
- **Worker:** Separate Node.js process for builds, deployment jobs, reconciliation, and cleanup.
- **Platform database:** PostgreSQL.
- **Queue:** Redis + BullMQ.
- **Container runtime:** Docker Engine API.
- **Builds:** Dockerfile builds as a first-class path; evaluate Railpack for automatic buildpack detection. Support custom build/start commands as a fallback.
- **Build execution:** Restricted BuildKit-based build jobs, subject to security and compatibility validation.

### Platform services

Shipdok itself is run through Docker Compose and includes the dashboard, API, worker, PostgreSQL, and Redis. A reverse proxy or tunnel is optional and external to the core MVP: the administrator supplies it if they want a public address. Shipdok ships no tunnel. An optional Caddy compose profile (off by default) may be provided for administrators who have no proxy.

Compose pulls prebuilt images (`shipdok-api`, `shipdok-worker`, `shipdok-web`) for both amd64 and ARM64 from GitHub's container registry, built and published by a GitHub Actions workflow on tagged releases. A new installation needs only the Compose file and, optionally, a small environment file. Building from source remains possible for development through an override file. Published images must never contain secrets.

User application containers are created dynamically by the worker through the Docker Engine API. They are **not** declared as static services in Shipdok's own Compose file.

### Suggested repository structure

```text
shipdok/
├── apps/
│   ├── web/                  # React dashboard
│   ├── api/                  # Express API
│   └── worker/                # Build and deployment jobs
├── packages/
│   └── shared/                # Shared validation and utilities
├── docker/
│   └── Dockerfile.worker
├── infrastructure/
│   ├── compose.yaml
│   └── nginx-proxy-manager/   # Optional integration documentation
├── tests/
│   └── integration/
├── .env.example
├── package.json
└── README.md
```

The exact monorepo tooling and package-manager choice can be decided during implementation.

## 4. Identity, administrator setup, and authentication

- Shipdok is single-administrator in the MVP: exactly one account, which administers the whole dashboard. There are no other users, roles, or invitations.
- On first launch, guide the user through creating the administrator account.
- Disable first-run setup atomically after the account is created; concurrent setup requests must not create multiple administrators.
- No public registration or invitation system.
- Hash passwords using a modern password-hashing algorithm; never store plaintext passwords.
- Use secure session cookies (`HttpOnly`, appropriate `SameSite`, and `Secure` when served over HTTPS).
- Protect state-changing requests against CSRF where applicable.
- Use a sliding inactivity timeout and a maximum session lifetime. Exact timeout values remain an implementation decision.
- Support logout and session revocation, including a "sign out everywhere" action.

### Password policy and login protection

Because the dashboard may be exposed to the internet by the administrator's choice, the password is the main protection and is treated that way:

- Enforce a minimum length of 12 characters, and refuse passwords that are a short pattern repeated, a plain run of characters, or that contain the username. No word lists are bundled, so common passwords are not detected.
- Show a length-based strength indicator and a plain message that a dashboard reachable from the internet needs a long, unique password, and that several random words beat clever symbols.
- Rate-limit and slow down login attempts progressively, counted per account and per client address. Do not reveal whether a username exists, and keep response times uniform.
- Show a list of recent logins (time, address, success or failure), including any use of a recovery code.
- Two-factor authentication is not part of the MVP. The security documentation must say so honestly and explain that anyone who signs in can deploy and run arbitrary containers through the worker.

### Recovery codes

- When the administrator account is created (and on request later), generate a set of 10 long random recovery codes, shown once with copy, print, and download options and an explicit "I have saved these" confirmation.
- Store only hashes of recovery codes. Each code works once. Regenerating the set invalidates the previous set.
- A recovery code can be used on the login screen to set a new password. Using one signs out all other sessions, requires a new password immediately, and is recorded in the recent-logins list.
- Recovery-code attempts are rate-limited like logins.
- Provide a second recovery path for whoever controls the host: a documented command that resets the administrator's password (for example through `docker compose exec`). Access to the host is already full control.

### Platform secrets

**Decision (Q50):** Environment variables and protected secret files remain supported and always take precedence. By default, secrets that the administrator did not supply (session secret, encryption key, database and Redis passwords) are generated on first run into a protected volume, so that `docker compose up` works without a hand-made environment file. The trade-off, which the documentation must state, is that the encryption key then lives on the same disk as the database volume; administrators who want them separate supply the key themselves.

Credentials created by the GitHub App flow (private key, webhook secret, client secret) are stored encrypted in PostgreSQL with the platform encryption key, never returned to the browser after creation, and can be deleted with a "Disconnect GitHub" action. Environment-based GitHub App settings continue to work and take precedence.

Regardless of the source, real secrets must never be committed to source control, included in public images, or intentionally written to logs. Provide `.env.example` with placeholders only and protect actual secret files with restrictive permissions.

## 5. GitHub integration

- Use a GitHub App rather than long-lived personal access tokens.
- **Connect GitHub from the dashboard.** A single button starts GitHub's App Manifest flow: Shipdok sends the administrator to github.com with a prepared app definition (name, `contents: read`, the push event, and the webhook URL derived from the public address), the administrator confirms once, GitHub returns a one-time code, and the API exchanges it for the app's credentials. The exchange is an outbound call from the API, so the flow works on `localhost` or a LAN address; only webhook delivery needs a public address. The flow uses a random `state` value bound to the administrator's session, accepts each code once, supports personal and organisation accounts, and never logs or returns the private key. Afterwards the administrator installs the app on selected repositories. Public repositories work without a GitHub App.
- The webhook URL is a setting. When the public address changes, Shipdok updates the app's webhook URL through GitHub's API instead of asking the administrator to edit it on github.com.
- Request repository-scoped permissions and let the administrator install the app on selected repositories.
- List repositories available to the installation.
- Use short-lived installation access tokens; keep the app private key and webhook secret on the trusted platform side.
- Verify webhook signatures.
- Deduplicate deliveries by GitHub delivery ID.
- Record webhook processing failures without logging secrets.
- Deploy only pushes to the application's configured branch.
- Do not poll GitHub periodically in the MVP. If a webhook is missed, the administrator can inspect GitHub's delivery history and manually redeploy. An administrator who does not provide a public address uses manual deployment.
- Manual deployment and redeployment are available from the dashboard.

### Latest-commit-wins policy

For a new push to an application's configured branch:

- Cancel older queued deployments for that application.
- Request safe cancellation of its active build if one is in progress.
- Queue the newest commit.
- Do not cancel another application's job.
- Keep the currently running application available while the replacement is built, unless the administrator explicitly stops it.
- Record cancelled or superseded jobs in history.
- Ensure an older commit cannot replace a newer successful version.

If an application is intentionally stopped, skip automatic deployments. Record the push or skipped event as appropriate, explain the reason in the dashboard, and allow the administrator to deploy manually later. A manual deployment of a stopped application must preserve its stopped state unless the administrator explicitly chooses to start it.

## 6. Application creation and configuration

### Initial setup flow

1. Connect or select a repository available through the GitHub App.
2. Select a branch.
3. Choose an application name; default to the repository name but allow editing.
4. Configure the application root directory (repository root by default).
5. Detect a Dockerfile or attempt buildpack detection.
6. Review the detected build method, commands, ports, resource limits, health check, and persistent mounts.
7. Confirm the initial deployment explicitly.

### Names and identity

- Application names must be unique within Shipdok.
- Use a stable internal application ID separate from its display name.
- Generate validated, normalised slugs for Docker resource names.
- Permit renaming at any time.
- A rename updates the display name and the normalised name used for future resources. Existing resources can keep their current names until naturally replaced.
- Renaming must not require a rebuild or restart by itself.

### Root directory and build settings

- Default application root is the repository root.
- Allow a configurable subdirectory, such as `frontend/` or `services/api/`.
- Discover Dockerfiles and detect buildpacks relative to the configured directory.
- Validate the path and provide clear errors if it is missing or invalid.
- Full monorepo/multiple-app support is deferred.

### Pending configuration

- Saving settings creates a pending configuration; it does not alter the live deployment.
- The administrator explicitly clicks **Deploy** to apply saved changes.
- Show which settings are pending and will be used by the next deployment.
- Automatic GitHub deployments use the latest saved configuration.
- If a deployment fails, preserve the prior working version and its effective configuration where possible.

### Build methods

1. **Dockerfile:** First-class, explicit build method.
2. **Railpack:** Preferred candidate for automatic buildpack detection, subject to a Raspberry Pi/ARM64 compatibility, security, and performance prototype.
3. **Custom commands:** Allow configured build and start commands if detection is insufficient.

Keep build methods behind a modular interface so Railpack can be replaced. Build commands execute only in the isolated build environment, not inside the privileged API service.

## 7. Deployment lifecycle and versioning

### Deployment flow

1. Persist the requested commit and configuration snapshot.
2. Queue a job through BullMQ.
3. Fetch the intended repository commit using GitHub installation credentials.
4. Build the image using the selected build method.
5. Validate the resulting image's architecture and runtime configuration.
6. Create a candidate container with configured environment, mounts, resource limits, and network policy.
7. Run startup checks and the configured health check.
8. If validation succeeds, switch to the candidate and retire the prior container as safely as the port model allows.
9. If validation fails, remove temporary resources and preserve the prior successful deployment where possible.
10. Persist status, logs, image reference, commit, and configuration snapshot.

Because a direct host port cannot usually be bound by both old and candidate containers simultaneously, a candidate may be tested on a temporary port before a brief port swap. If the old container must be stopped first, retain enough metadata and image state to restore it if the swap fails. Do not promise zero downtime for direct-port deployments.

### Deployment history and rollback

- Keep deployment history and failure records.
- Retain the current successful version plus the five previous successful versions per application.
- Rollback reuses an existing retained image; it does not rebuild from source.
- Protect images referenced by active containers or retained successful deployments from cleanup.
- Failed and cancelled jobs remain visible in history but do not count toward the five previous successful versions.
- Rollback changes the application image/version, not persistent-volume contents or external database state. Database migrations require application-specific handling.

### Job cancellation and retries

- No automatic retries for failed deployments; the administrator manually retries.
- Queued jobs can be cancelled without starting.
- Running builds can be cancelled with safe termination and cleanup.
- Cancellation must not delete the current working application, retained images, logs, or persistent volumes.
- Record commit/configuration details for retries.
- On worker restart, reconcile interrupted jobs and Docker resources. Mark incomplete jobs interrupted or failed, clean temporary resources, and preserve the existing working app. Do not silently retry.

## 8. Ports, networking, and exposure

- Configure the application container port.
- Allocate a host port automatically by default.
- Allow the administrator to request a specific host port.
- If a requested port conflicts, fail clearly; do not silently choose another port.
- Port allocation must be race-safe and account for the actual Docker host state.
- Persist port settings across redeployments.
- Default access to deployed applications is private LAN/VPN through the host IP and assigned port. Shipdok does not make deployed applications public and has no domain routing for them.
- Shipdok must not configure router port forwarding. Making Shipdok itself reachable from the internet is covered by "Public exposure" below.
- Applications are isolated from the control plane and from each other by default.
- Outbound internet access is allowed by default, subject to host policy.
- LAN access to private devices and inter-app communication require deliberate administrator-controlled configuration.
- Docker networks alone are not a complete host/LAN security boundary. Validate the actual host firewall and Docker-published-port behaviour.
- Do not grant application containers access to the Docker management socket or API.

### Public exposure

The administrator chooses one mode with a single setting, `SHIPDOK_PUBLIC`, and gives the public address in `PUBLIC_URL` (for example `https://shipdok.example.com`). Both are environment settings in the MVP; entering the domain in the dashboard is deferred.

1. **`off` (default):** nothing is reachable from the internet. The dashboard listens on loopback by default and is reached from the same machine, over the LAN by binding it to a LAN address, or over a VPN.
2. **`webhook`:** only `POST /api/webhooks/github` is reachable through the public address. Every other path answers 404. The dashboard stays private. This is the lowest-risk way to receive GitHub pushes.
3. **`full`:** the whole dashboard is reachable on the public address, for administrators who want to manage Shipdok from outside their network. The password policy, lockout, recent logins, and recovery codes in section 4 apply, and the dashboard shows a banner whenever it is reachable from the internet.

Shipdok ships and manages no tunnel and no certificate authority. The administrator provides the public address in whatever way suits them: their own public IP with a port forward, a reverse proxy such as Nginx, Nginx Proxy Manager, or Caddy, or a tunnel they run themselves in front of such a proxy. HTTPS is terminated by that proxy.

Behind a proxy, Shipdok must:

- Derive the allowed origin, secure cookies, and the GitHub webhook URL from `PUBLIC_URL`.
- Accept forwarded headers only from trusted proxies configured with a trusted-proxy setting, and use the real client address from those headers for rate limits, lockout, and the recent-logins list. The dashboard's own web server must not discard an address that a trusted proxy supplies.
- Never expose the dashboard port in `webhook` mode, and document that the proxy must forward only the webhook path, with Nginx and Caddy examples.
- Keep the API, PostgreSQL, and Redis unreachable from outside the Compose network or loopback.

### TLS

- Direct host-port access is the MVP path for deployed applications.
- The core platform does not issue or renew TLS certificates and has no built-in domain routing. HTTPS for a public address is provided by the administrator's proxy.
- An optional Caddy compose profile, off by default and lower priority, may provide automatic HTTPS for administrators who have no proxy.
- Document Nginx Proxy Manager and Nginx integration, including using a tunnel in front of them.
- Explain that HTTP does not encrypt traffic; protect dashboard access and credentials accordingly, and do not use `full` mode without HTTPS.

## 9. Persistent volumes and external databases

### Persistent storage

- Support optional user-configured Docker named volumes.
- The administrator specifies container paths to persist, such as `/app/uploads`.
- Reuse the same volumes across redeployments.
- Do not automatically infer persistent paths.
- Normal container/image/build cleanup must never delete persistent volumes.
- When deleting an application, explicitly ask whether to preserve or permanently delete its volumes. Permanent deletion requires clear confirmation and warning.
- Track preserved/orphaned volumes so the administrator can identify and remove them later.
- Application volume backup/restore is not included in the MVP.

### Databases

- Deployed applications use external databases in the MVP.
- The administrator supplies connection details through environment variables.
- Shipdok does not provision or manage databases for user applications.
- Shipdok's own PostgreSQL and Redis are separate platform services.
- Do not expose a database publicly merely to connect an application; networking must be configured deliberately.
- Rolling back an application does not roll back external database contents or schema migrations.

### Configuration files

- Use repository files for ordinary configuration, or user-configured mounts where appropriate.
- Environment variables remain the primary mechanism for secrets and environment-specific settings.
- No dashboard file editor or configuration-file upload feature in the MVP.
- Files baked into an image change through deployment; mounted files have a separate lifecycle and permission model.

## 10. Environment variables and secrets for applications

- Add, edit, and delete variables individually, or import a `.env` file.
- Parse `.env` files safely.
- Encrypt application secret values at rest in PostgreSQL.
- Mask secrets by default in the UI.
- Ordinary API responses must not include decrypted secret values.
- Only trusted platform components should decrypt secrets when required to configure a container.
- Never intentionally log secret values or error messages that may contain them.
- Variables persist across redeployments until changed.
- Masking and encryption are separate controls; both are required.

## 11. Health checks and runtime behaviour

- Allow an optional configurable HTTP health-check path, such as `/health`.
- Use container-running status as the fallback when no HTTP check is configured; clearly explain that this does not prove application readiness.
- Startup health-check timeout: 120 seconds.
- Detect early container exit and fail promptly rather than waiting for the full timeout.
- If a candidate fails its startup check, mark the deployment failed and preserve the prior working version where possible.
- Continue checking health after deployment.
- If a previously successful application later becomes unhealthy, mark it `Unhealthy`, show failures and logs, and keep it running. Do not automatically restart or roll back solely because an ongoing health check fails.
- Let the administrator decide whether to restart or roll back.
- Keep deployment status separate from current runtime health.

### Crash handling

- Automatically restart a container after unexpected crashes, subject to a configurable retry limit.
- After repeated crashes, stop retrying and mark the app `Crashed` or `Unhealthy`.
- Allow manual recovery after inspection.
- Never automatically restart an application intentionally stopped by the administrator.
- Distinguish intentionally stopped containers from crashed applications.

### Application controls

Provide **Start**, **Stop**, and **Restart** controls:

- Stop the container without deleting application configuration, history, images, or volumes.
- Start the currently deployed version/configuration.
- Restart without rebuilding.
- Manual deployment of a stopped application should leave it stopped unless the administrator explicitly requests a start.

## 12. Resource limits and monitoring

- Default application memory limit: suggested 512 MB, configurable per app.
- CPU limit: configurable per app; exact default quota is an implementation decision to be measured on the Pi.
- Apply Docker-enforced limits to application containers.
- Build jobs also need CPU, memory, time, and concurrency limits.
- Reserve enough resources for Shipdok services and the host itself.
- Show live CPU usage, memory usage, configured limits, and container status.
- No historical resource charts, advanced alerts, or dedicated metrics database in the MVP.
- Surface out-of-memory and resource-limit failures clearly.

## 13. Logs and disk management

### Centralised logs

- Store build and runtime logs in Shipdok-managed persistent storage, associated with the application and deployment.
- Logs remain accessible after containers are replaced or removed.
- Keep logs until the administrator explicitly deletes them.
- Keep deployment status and error summaries even if detailed logs are deleted.
- Avoid intentionally logging secrets.
- A file-based log store with metadata in PostgreSQL is a candidate implementation; validate disk usage and indexing needs.

### Disk cleanup

- Automatically remove disposable build containers, temporary files, and unused build cache.
- Preserve the current image and images required by the five previous successful versions.
- Preserve logs and persistent volumes.
- Never automatically delete retained logs to reclaim space.
- Show disk and log storage usage, and warn when storage is running low or critical.
- Require manual deletion of retained logs and other protected data.
- Because the chosen log policy can exhaust disk space, document the operational risk prominently.
- Cleanup must be ownership-scoped and never touch unrelated Docker workloads.

## 14. Application deletion and Docker resource ownership

- Shipdok manages only applications and resources it creates; existing Docker workloads remain untouched.
- Tag Shipdok-managed resources with explicit ownership and application/deployment identifiers.
- Before deletion, show a resource summary covering containers, configuration, deployment records, images, and volumes.
- Require explicit confirmation.
- Ask whether to preserve or permanently delete persistent volumes.
- Remove only resources verified as belonging to that application.
- Report partial cleanup failures rather than claiming deletion fully succeeded.
- Stable internal application IDs preserve associations across renames.
- Never implicitly delete volumes during image/container cleanup.

## 15. Platform database backups and upgrades

### Database backup and restore

- Provide a manual PostgreSQL backup and documented restore procedure for Shipdok's own database.
- No scheduled automatic backups in the MVP.
- Protect backup files because they may contain sensitive metadata and encrypted secrets.
- Explain that restoring PostgreSQL does not restore Docker images, containers, or application volume contents.

### Platform upgrades

- Upgrade Shipdok manually by pulling newer published images (`docker compose pull`, then `up -d`) and following documented steps. Images are versioned, so administrators can pin a release.
- Use versioned, ordered database migrations.
- Recommend a database backup before an upgrade.
- Document diagnosis and recovery for failed migrations.
- No dashboard-driven or automatic self-upgrade feature in the MVP.

## 16. Worker reliability and network outages

- Persist queue/job state so the worker can reconcile after restart.
- At startup, identify interrupted jobs and abandoned temporary resources.
- Mark incomplete jobs interrupted or failed; do not auto-retry.
- Preserve the currently working application.
- Keep existing apps running during internet outages.
- Keep the local dashboard/API available over the LAN when the host and local network are operational.
- Report internet-dependent build failures clearly and allow manual retry.
- Do not require an external Shipdok service for core local management.

## 17. Security requirements

Security is a core requirement because the worker interacts with Docker and processes potentially untrusted repository code.

- Never expose the Docker management socket/API to deployed application containers or build steps.
- Treat Docker Engine access as highly privileged.
- Keep API/control-plane services separate from build and application execution.
- Use restricted BuildKit-based build jobs with CPU, memory, and time limits.
- Restrict mounts, capabilities, network access, and build secrets.
- Do not run arbitrary build steps in the privileged API container.
- Do not grant build steps privileged mode or host filesystem access.
- Validate image architecture and configuration before starting a candidate.
- Use scoped GitHub App permissions, verify webhook signatures, and protect private keys.
- Encrypt application secrets at rest and mask them in the UI/API.
- Protect session cookies, login routes, and state-changing requests.
- When a public address is configured, apply the controls in section 4 and section 8: strong password policy, progressive lockout per account and address, recent-logins list, recovery codes stored hashed, security headers (including HSTS over HTTPS), an origin check taken from `PUBLIC_URL`, and trusted-proxy handling of client addresses.
- State the residual risk plainly: there is no two-factor login in the MVP, and anyone who signs in can run arbitrary containers through a worker that controls Docker. Compromise of the dashboard is therefore compromise of the host.
- Keep GitHub App credentials encrypted at rest and never return the private key to the browser.
- Use ownership labels and stable internal IDs to scope cleanup.
- Keep applications isolated by default and test host/LAN access controls.
- BuildKit is not, by itself, a complete security boundary. Prototype and test isolation before claiming arbitrary untrusted repositories are safe. Document residual risks honestly.

## 18. UI and status model

The dashboard should make the following information readily visible:

- Application name, repository, configured branch, and latest deployed commit.
- Current deployment status and runtime status as separate concepts.
- Current version and retained successful versions.
- Pending configuration changes.
- Build and runtime logs, including historical logs.
- Container port and private access address.
- CPU and memory usage with configured limits.
- Health-check status and crash history.
- Disk/log usage and storage warnings.
- Why a deployment was skipped, cancelled, superseded, interrupted, or failed.
- Whether an app is intentionally stopped.

Suggested deployment/job states include `Queued`, `Building`, `Starting`, `Validating`, `Successful`, `Failed`, `Cancelled`, `Superseded`, and `Interrupted`. Runtime states include `Running`, `Stopped`, `Restarting`, `Crashed`, and `Unhealthy`. Final enum names should be standardised during schema design.

## 19. Testing and acceptance criteria

The MVP should not be considered ready until automated tests cover at least:

- First-run administrator setup is atomic and cannot create multiple admins.
- Authentication, session expiry, logout, rate limits, and CSRF-sensitive routes.
- Password policy (minimum length, repeated patterns, plain runs, username in password), progressive lockout per account and per address, and the recent-logins list.
- Recovery codes: generated once, stored hashed, single use, invalidated by regeneration, rate-limited, and ending other sessions when used.
- Public modes: `off` exposes nothing; `webhook` answers 404 for every path except the webhook; `full` applies the origin check, secure cookies, and the real client address behind a trusted proxy, and ignores forwarded headers from untrusted sources.
- The GitHub App Manifest flow: `state` binding, one-time code use, encrypted storage of credentials, no private key in any response or log, and Disconnect.
- GitHub webhook signature verification and duplicate delivery handling.
- Branch filtering and latest-commit-wins cancellation.
- Stopped-app behaviour for incoming pushes and manual deployments.
- Build success, build failure, cancellation, and worker restart reconciliation.
- Docker resource ownership and protection of unrelated containers.
- Port conflicts and race-safe host-port allocation.
- Environment variable encryption, masking, and log redaction.
- Candidate health-check failure preserves the prior successful version.
- Rollback uses a retained image without rebuilding.
- Persistent volumes survive redeployments and normal cleanup.
- Application deletion requires confirmation and follows the selected volume policy.
- Disk cleanup preserves retained images, logs, and volumes.
- Architecture incompatibility produces a clear error.
- Existing apps and local dashboard remain available during internet outages where expected.

Prototype tests must specifically validate Railpack ARM64 compatibility, restricted BuildKit behaviour, resource consumption on the Pi, Docker network/firewall assumptions, and deployment port swapping.

## 20. Implementation roadmap

### Milestone 1 — Platform foundation

- Monorepo and Compose setup.
- Express API, React dashboard, PostgreSQL migrations, Redis/BullMQ.
- First-run administrator setup and session security.
- Health endpoints and basic test infrastructure.

### Milestone 2 — Docker deployment engine

- Docker resource ownership labels.
- Queue worker, job lifecycle, cancellation, reconciliation.
- Build Dockerfile-based images and launch one application container.
- Port allocation, resource limits, environment variables, and runtime logs.
- Test failure cleanup without harming a working app.

### Milestone 3 — End-to-end GitHub integration

- GitHub App configuration and installation flow, created from the dashboard with one click (App Manifest flow, section 5).
- Repository/branch selection and verified webhooks.
- Initial deployment review/confirmation.
- Automatic configured-branch deployments and latest-commit-wins policy.
- Manual deployment and redeployment.

### Milestone 4 — Reliable releases

- Health checks and candidate validation.
- Replacement/rollback flow and five-version retention.
- Start, Stop, Restart, crash-loop limits.
- Persistent volumes and safe deletion workflow.

### Milestone 5 — Operations and hardening

- Centralised historical logs and manual deletion.
- Disk/storage warnings and conservative cleanup.
- Live CPU/memory monitoring.
- Manual platform database backup/restore documentation.
- Manual upgrade and migration documentation.
- Security and ARM64/BuildKit/Railpack validation.

### Milestone 6 — Public access and distribution

In this order:

1. Password policy and strength guidance, progressive lockout, and the recent-logins list.
2. Recovery codes and the host-side password reset command.
3. Public address support: `SHIPDOK_PUBLIC` (`off`, `webhook`, `full`), `PUBLIC_URL`, trusted proxies, real client address, and documentation with Nginx, Nginx Proxy Manager, and Caddy examples.
4. The GitHub App Manifest flow ("Connect GitHub") using the public address, with the credentials stored encrypted.
5. First-run secret generation, so that `docker compose up` needs no hand-made environment file.
6. Prebuilt amd64 and ARM64 images published to GitHub's container registry by a GitHub Actions workflow, and a Compose file that pulls them.
7. A full run on the Raspberry Pi using the published images.
8. Optional, lower priority: an off-by-default Caddy compose profile for administrators without a proxy.

## 21. Open decisions and validation checklist

### Open decisions

- **Platform secret storage (Q50):** decided in section 4 (environment and files take precedence; generated on first run into a protected volume otherwise; GitHub App credentials encrypted in PostgreSQL). Revisit if the same-disk key placement proves unacceptable.
- Whether to add optional two-factor login after the MVP.
- Whether to let the administrator enter the public domain in the dashboard (which would require controlling a proxy), instead of the environment.
- Whether to include the optional Caddy profile at all.
- Exact session inactivity and maximum lifetime values.
- Exact CPU quota default after benchmarking.
- Monorepo/package manager choice.
- Final log file format and indexing strategy.
- Final job/runtime status enums and health-check failure thresholds.

### Validate in prototype

- Railpack compatibility and performance on the target ARM64 host.
- BuildKit isolation limits and threat model.
- Whether available Pi resources can support the platform, one build, and existing workloads safely.
- Port-swapping and rollback behaviour with direct host ports.
- Docker-published-port behaviour with host firewall rules.
- Disk usage and cleanup performance for centralised log files.

### API Documentation and Contract

- **Swagger Autogen:** Use `swagger-autogen` to generate the API specification by scanning the Express backend's routes and adding documentation metadata through code comments.
- **OpenAPI:** Generate an OpenAPI 3.x specification, rather than the legacy Swagger 2.0 format. Use OpenAPI 3.0 initially unless a specific feature requires a newer version.
- **Scalar:** Use `@scalar/express-api-reference` to provide interactive API documentation from the generated OpenAPI JSON document.
- **Documentation coverage:** Document endpoint descriptions, parameters, request bodies, response schemas, HTTP status codes, authentication requirements, and error responses.
- **Generation workflow:** Provide an npm script to generate the specification. Regenerate it when API routes or their documentation change, and validate the generated document as part of development or CI.
- **Development access:** Make the Scalar reference available during development for inspecting and manually testing endpoints.
- **Production security:** Keep documentation access restricted to the administrator or disabled by default in production. All API endpoints must enforce their own authentication and authorisation.
- **Automated testing:** Use Jest and Supertest to test API behaviour, including successful requests, validation failures, authentication, authorisation, and error handling. API documentation does not replace automated tests.

---

**Product principle:** Shipdok should prefer predictable, recoverable behaviour over hidden automation. It should preserve the last working application and persistent data wherever possible, make failures visible, and require explicit administrator action for destructive operations.
