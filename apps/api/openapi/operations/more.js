import { op, route, ok, ref, APP_ID, DEPLOYMENT_ID, query, idParam } from '../helpers.js';

const ENV = 'Variables';
const VOL = 'Persistent storage';
const GH = 'GitHub';
const SET = 'Settings';
const LOG = 'Logs and storage';
const HOOK = 'Webhooks';
const SYS = 'System';
const nothing = (description) => ({ description });
const KEY = { name: 'key', in: 'path', required: true, description: 'The variable\'s name: letters, digits and underscore, not starting with a digit, at most 128 characters; some names are reserved.', schema: { type: 'string' } };
const GH_APP_ID = idParam('id', 'The id of a connected GitHub App (from `GET /api/github`).');
const ghApp404 = { 404: 'No such GitHub app (`code: github_app_not_found`).', 409: 'That GitHub app\'s stored credentials cannot be read (`code: cannot_decrypt`).' };

export default Object.fromEntries([
  // ---------------------------------------------------------------- variables
  route('GET', '/api/apps/{id}/env', op({
    tag: ENV, summary: 'List an app\'s variables', parameters: [APP_ID],
    description: 'The names, where each is available (`scope`) and how it reaches the build (`build_as`), **never the values** (they are always `********`), and which changes wait for the next deployment.',
    responses: { 200: ok('The variables.', ref('EnvList')) }, errors: [404],
  })),
  route('POST', '/api/apps/{id}/env/import', op({
    tag: ENV, summary: 'Import variables from `.env` text', parameters: [APP_ID],
    description: 'All or nothing: if any line has a problem nothing is saved and `problems` lists them (up to 50) with their line numbers. Existing names are updated, new ones created, within the limit per app.',
    body: { type: 'object', required: ['content'], properties: { content: { type: 'string', description: 'The text of a `.env` file.' } } },
    responses: { 200: ok('Imported.', { type: 'object', properties: { created: { type: 'integer' }, updated: { type: 'integer' }, keys: { type: 'array', items: { type: 'string' } }, duplicates: { type: 'array', items: { type: 'string' } } } }) },
    errors: { 400: 'A problem in the file (`problems`, `total_problems`), no variables in it, or too many in total. Nothing was saved.', 404: 'No such app.' },
  })),
  route('PUT', '/api/apps/{id}/env/{key}', op({
    tag: ENV, summary: 'Create or change a variable', parameters: [APP_ID, KEY],
    description: 'Stores the value encrypted (AES-256-GCM, bound to the app and the name). The running app keeps its old value until the next deployment. `scope` says where the variable is available: `runtime` (the container; the default for a new variable), `build` (only `docker build --build-arg`; the container never sees it) or `both`. `buildAs` says how a variable that reaches the build is given to `docker build`: `arg` (a build argument, the default; the Dockerfile declares it with `ARG NAME`, and if it uses it the value is stored in the image) or `secret` (a BuildKit secret, `--secret id=NAME,env=NAME`; the Dockerfile asks for it with `RUN --mount=type=secret,id=NAME,env=NAME ...`; the value is mounted for that step only and never stored in the image, and a changed secret does not re-run a cached step). Send a `value`, a `scope`, a `buildAs`, a `newKey`, or any of them together: a value alone keeps the scope and `buildAs`; a scope or `buildAs` alone changes an existing variable and keeps its value (404 if there is no such variable). `newKey` renames an existing variable (the value is encrypted for its name, so the server decrypts and encrypts it again, in the same transaction as the rest of the request; the value never leaves the server). The new name follows the same rules as any name, 409 `name_taken` if another variable has it, and the answer says `previous_key`. Until the next deployment the old name counts as removed and the new one as added. A build variable is baked into the image if the Dockerfile uses it (`ARG NAME`), so use it for public configuration, not secrets; some names (`PATH`, `HOME`, `DOCKER_*`, `BUILDKIT_*`, `LD_*`...) cannot be used at build time.',
    body: { type: 'object', properties: { value: { type: 'string', description: 'The value; at most 64 KB, no null characters. Leave it out to change only the scope or `buildAs`.' }, scope: { type: 'string', enum: ['runtime', 'build', 'both'], description: 'Where the variable is available. Default for a new variable: `runtime`; an existing variable keeps its scope when this is left out.' }, buildAs: { type: 'string', enum: ['arg', 'secret'], description: 'How a variable that reaches the build is given to `docker build`. Default for a new variable: `arg`; an existing variable keeps what it has when this is left out.' }, newKey: { type: 'string', description: 'Rename the variable to this name (it must already exist, and the new name must be free).' } }, additionalProperties: false },
    responses: { 200: ok('Changed.', { type: 'object', properties: { key: { type: 'string' }, created: { type: 'boolean' }, scope: { type: 'string', enum: ['runtime', 'build', 'both'] }, build_as: { type: 'string', enum: ['arg', 'secret'] }, previous_key: { type: 'string', description: 'Only after a rename: the name it had.' }, updated_at: { type: 'string', format: 'date-time' } } }), 201: ok('Created.', { type: 'object', properties: { key: { type: 'string' }, created: { type: 'boolean' }, scope: { type: 'string', enum: ['runtime', 'build', 'both'] }, build_as: { type: 'string', enum: ['arg', 'secret'] }, updated_at: { type: 'string', format: 'date-time' } } }) },
    errors: { 400: 'A bad name, value, scope or `buildAs`, a reserved name, a name that cannot be used at build time, nothing to set, or too many variables.', 404: 'No such app, or (with a scope only, or a rename) no such variable.', 409: 'A rename to a name another variable already has (`code: name_taken`).', 500: 'A rename of a stored value that cannot be decrypted (has `APP_SECRETS_KEY` changed?); send a new value with it.' },
  })),
  route('DELETE', '/api/apps/{id}/env/{key}', op({
    tag: ENV, summary: 'Delete a variable', parameters: [APP_ID, KEY],
    description: 'Removes it. The running app keeps its copy until the next deployment.',
    responses: { 204: nothing('Deleted.') }, errors: { 404: 'No such app or variable.' },
  })),
  route('POST', '/api/apps/{id}/env/{key}/reveal', op({
    tag: ENV, summary: 'Show a variable\'s value', parameters: [APP_ID, KEY],
    description: 'The **only** place a value leaves the server. It is a POST so it is never prefetched or cached, and the answer says `Cache-Control: no-store`.',
    responses: { 200: ok('The value.', { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } } }) },
    errors: { 404: 'No such app or variable.', 500: 'The stored value could not be decrypted (has `APP_SECRETS_KEY` changed?).' },
  })),

  // ---------------------------------------------------------------- persistent storage
  route('GET', '/api/apps/{id}/volumes', op({
    tag: VOL, summary: 'An app\'s persistent storage', parameters: [APP_ID],
    description: 'The app\'s volumes: those mounted (`in_use`) and those whose path was removed but whose data is kept (`detached`).',
    responses: { 200: ok('The volumes.', ref('VolumeList')) }, errors: [404],
  })),
  route('PUT', '/api/apps/{id}/volumes', op({
    tag: VOL, summary: 'Set the container paths to keep', parameters: [APP_ID],
    description: 'Replaces the whole list. Each path becomes a Docker named volume that every deployment mounts, so files written there survive redeploys, rollbacks and restarts. A path that is new gets a new volume; a path that was removed earlier gets ITS volume back; a path that is left out is **detached, never deleted**. Takes effect with the next deployment (it is listed in `settings_pending`). The Docker volumes are created by the worker at deployment time, and a new version is first checked with throwaway volumes so the old version\'s data is not touched while both run.',
    body: ref('VolumePaths'), responses: { 200: ok('The volumes after the change.', ref('VolumeList')) },
    errors: { 400: 'A bad path, a duplicate, one path inside another, or more than 10.', 404: 'No such app.', 409: 'The app is being deleted (`code: deleting`).' },
  })),
  route('GET', '/api/volumes', op({
    tag: VOL, summary: 'Volumes that are kept without being mounted',
    description: 'Detached volumes (a path was removed from an app) and orphaned ones (their app was deleted and its data kept). Volumes that an app mounts are not listed here.',
    responses: { 200: ok('The volumes.', ref('VolumeList')) },
  })),
  route('GET', '/api/volumes/sizes', op({
    tag: VOL, summary: 'How the measuring of volume sizes stands',
    description: 'Whether a measurement is waiting or running, when the last one finished and how it went, the total of the last measured sizes and how many volumes have one. The sizes themselves are on each volume (`sizeBytes`, `measuredAt`).',
    responses: { 200: ok('The state.', ref('VolumeSizing')) },
  })),
  route('POST', '/api/volumes/sizes', op({
    tag: VOL, summary: 'Measure the sizes of the persistent volumes',
    description: 'Asks the worker to add up every volume. Docker walks every file to do that, which takes seconds (longer for big volumes or a slow disk), so sizes are never measured by themselves. The API only records the request; the worker answers it beside the deployment queue, so it never holds a deployment up. Poll `GET /api/volumes/sizes` until `measuring` is false.',
    responses: { 202: ok('Asked.', { type: 'object', properties: { queued: { type: 'boolean' } } }) },
    errors: { 409: 'One is already waiting or running (`code: already_measuring`).' },
  })),
  route('DELETE', '/api/volumes/{id}', op({
    tag: VOL, summary: 'Delete a volume and its data, for good', parameters: [idParam('id', 'The volume\'s id.')],
    description: '**Permanent.** Only a volume that is not mounted by an app. The API only queues it; the worker removes the Docker volume (and refuses one that is not Shipdok\'s or that a container still uses; the reason then shows as `removeError` on the volume).',
    responses: { 202: ok('Queued.', { type: 'object', properties: { queued: { type: 'boolean' } } }) },
    errors: { 404: 'No such volume.', 409: 'The volume is mounted by an app (`code: volume_in_use`).', 503: 'The job queue is not available.' },
  })),

  // ---------------------------------------------------------------- build cache
  route('GET', '/api/build-cache', op({
    tag: LOG, summary: 'Size of Docker\'s build cache',
    description: 'Every build leaves layers in a cache that all apps share, so it belongs to no app and image clean-up does not touch it. The worker measures it every few minutes (the API never asks Docker), so `sampledAt` says how old the figure is. `last` is the most recent clean-up.',
    responses: { 200: ok('The figures.', ref('BuildCache')) },
  })),
  route('POST', '/api/build-cache/clean', op({
    tag: LOG, summary: 'Clean the build cache', body: ref('CleanCacheRequest'), bodyRequired: false,
    description: 'Queues the clean-up on the same queue as deployments, so it never runs during a build. It removes build cache only: no images, containers, volumes or logs. By default it keeps what a build used in the last 24 hours; `all: true` removes every unused entry and the next builds start from nothing (slow). Only one clean-up at a time.',
    responses: { 202: ok('Queued.', { type: 'object', properties: { queued: { type: 'boolean' } } }) },
    errors: { 400: 'Invalid body.', 409: 'One is already waiting or running (`code: already_queued`).', 503: 'The job queue is not available.' },
  })),

  // ---------------------------------------------------------------- old images, all apps
  route('GET', '/api/images', op({
    tag: LOG, summary: 'Old images of all apps',
    description: 'How much the old versions that are no longer kept could free, in total and per app (an upper bound: versions of one app share files). Each app keeps its live version and `keep_previous_images` earlier ones. `thresholdBytes` is the size at which the dashboard says so (`null`, the default, means never); `exceeded` says whether it has been reached.',
    responses: { 200: ok('The figures.', ref('ImagesOverview')) },
  })),
  route('POST', '/api/images/prune', op({
    tag: LOG, summary: 'Clean up the old images of every app',
    description: 'Queues the same clean-up as an app\'s own button, once per app, on the same queue as deployments, so it never runs during a build. Each app keeps its live version and its chosen number of earlier ones; a version whose image is removed can no longer be rolled back to. Logs, volumes and containers are never touched. The figures change as each clean-up finishes.',
    responses: { 202: ok('Queued.', { type: 'object', properties: { queued: { type: 'integer', description: 'Clean-ups queued.' }, apps: { type: 'integer', description: 'Apps there are.' } } }) },
    errors: { 503: 'The job queue is not available.' },
  })),
  route('POST', '/api/images/auto-cleanup', op({
    tag: LOG, summary: 'Automatic clean-up for every app', body: ref('AutoCleanupRequest'),
    description: 'Switches the automatic clean-up (after each successful deployment) on or off for every app that exists now. A new app starts with it on. An app\'s own setting is on its Images tab.',
    responses: { 200: ok('Done.', { type: 'object', properties: { enabled: { type: 'boolean' }, changed: { type: 'integer', description: 'Apps that were not set this way before.' } } }) },
    errors: { 400: 'Invalid body.' },
  })),
  route('PUT', '/api/images/notice', op({
    tag: LOG, summary: 'Set the size of old images at which to say so', body: ref('ImagesNoticeRequest'),
    description: 'The dashboard shows a notice (on the apps list and the Storage page) once the old images that a clean-up could free reach this size. `null` turns it off, which is the default. Answers with the new figures.',
    responses: { 200: ok('Saved.', ref('ImagesOverview')) },
    errors: { 400: 'Not null and not a whole number from 100 MB to 10 TB.' },
  })),

  // ---------------------------------------------------------------- backups of Shipdok itself
  route('GET', '/api/backups', op({
    tag: LOG, summary: 'Backups of Shipdok itself',
    description: 'The backups that exist (newest first, at most 200) with how each went, their total size, the schedule and when the next scheduled backup is due (`nextRunAt`, `null` when the schedule is off), and whether they are encrypted (`encryption.enabled`: a passphrase is set). A backup of Shipdok is ONE file holding the database and the platform secrets (the key without which the database\'s encrypted data cannot be read); a backup of an app\'s volumes (`kind: volumes`, with `appName`) is one file with every mounted volume of that app. `apps` lists the apps that have mounted volumes with how their backups are set. `persistent: false` means the backups folder is not a volume of its own, so the backups would be lost when the container is replaced.',
    responses: { 200: ok('The backups and the settings.', ref('BackupsOverview')) },
  })),
  route('POST', '/api/backups', op({
    tag: LOG, summary: 'Make a backup now',
    description: 'Records a request; the worker notices within a few seconds and makes the backup beside the deployment queue (it does not wait behind a build). Poll `GET /api/backups` for the result. Only one backup may wait or run at a time.',
    responses: { 202: ok('Asked for.', { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } }) },
    errors: { 409: 'A backup is already waiting or running (`code: already_running`).', 429: 'Too many requests.' },
  })),
  route('POST', '/api/backups/volumes/{appId}', op({
    tag: LOG, summary: 'Back up the persistent volumes of an app now', parameters: [idParam('appId', 'The app.')],
    description: 'Records a request; the worker makes ONE file with every mounted volume of the app (read-only; the app keeps running unless its "stop while copying" switch is on, see `PUT /api/backups/volumes/{appId}/settings`) beside the deployment queue. Refused by the worker, with the reason in the backup\'s `error`, when the disk would be left nearly full. Poll `GET /api/backups`. One backup may wait or run per app.',
    responses: { 202: ok('Asked for.', { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } }) },
    errors: { 400: 'The app has no persistent volumes (`code: no_volumes`).', 404: 'No such app.', 409: 'A backup of this app is already waiting or running (`code: already_running`), or a restore of it is (`code: restore_running`).', 429: 'Too many requests.' },
  })),
  route('PUT', '/api/backups/volumes/{appId}/settings', op({
    tag: LOG, summary: 'Set how the volumes of an app are backed up', parameters: [idParam('appId', 'The app.')], body: ref('VolumeBackupSettings'),
    description: '`enabled`: include the app in the scheduled backups (the schedule is the one of `PUT /api/backups/settings`; off by default; switching it on does not back up at once for a time that already passed today). `stop`: stop the app while its volumes are copied and start it again afterwards, so a database in a volume is copied consistently (default off: the copy is made while the app runs). `keep`: how many of this app\'s newest volume backups to keep (1 to 60, default 3). Answers with the new overview.',
    responses: { 200: ok('Saved.', ref('BackupsOverview')) },
    errors: { 404: 'No such app.' },
  })),
  route('PUT', '/api/backups/settings', op({
    tag: LOG, summary: 'Set the backup schedule', body: ref('BackupSchedule'),
    description: 'How often a backup is made by itself (`off`, `daily` or `weekly`), at which hour (**UTC**, 0 to 23), on which weekday for weekly (0 = Sunday), and how many of the newest backups to keep (1 to 60; older ones are deleted after each backup). The default, until this is set, is daily at 03:00 UTC keeping 7. Changing the schedule does not make a backup at once for a time that has already passed today. Answers with the new overview.',
    responses: { 200: ok('Saved.', ref('BackupsOverview')) },
    errors: { 400: 'A field is missing or out of range.', 429: 'Too many requests.' },
  })),
  route('PUT', '/api/backups/passphrase', op({
    tag: LOG, summary: 'Set or remove the backup passphrase', body: ref('BackupPassphraseRequest'),
    description: 'With a passphrase (12 to 256 characters) every NEW backup is encrypted with it (AES-256-GCM); `null` turns encryption off for new backups. Backups already made keep the passphrase they were made with. The passphrase is stored encrypted with the platform key so that scheduled backups can use it, but **it is also what opens a backup on a new machine, where the platform key is not there: remember it**. Needs the current password and is recorded in the sign-ins list (`backup`).',
    responses: { 200: ok('Saved.', ref('BackupsOverview')) },
    errors: { 400: 'No password, or the passphrase is too short, too long or starts or ends with a space.', 403: 'Wrong password (`code: wrong_password`).', 429: 'Too many tries.' },
  })),
  route('POST', '/api/backups/{id}/download', op({
    tag: LOG, summary: 'Download a backup', parameters: [idParam('id', 'The backup.')], body: ref('BackupDownloadRequest'),
    description: 'The backup file (`application/octet-stream`). It holds every secret, so it needs the current password (a POST, so that the password is not in an address) and is recorded in the sign-ins list (`download`). A file that is encrypted is sent as it is, still encrypted.',
    responses: { 200: { description: 'The file.', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } },
    errors: { 400: 'No password.', 403: 'Wrong password (`code: wrong_password`).', 404: 'No such backup.', 409: 'That backup has no file (it failed, or is still being made; `code: no_file`).', 410: 'The file is gone from the backups folder (`code: file_missing`).', 429: 'Too many tries.' },
  })),
  route('POST', '/api/backups/{id}/restore', op({
    tag: LOG, summary: 'Restore the volumes of an app from a backup', parameters: [idParam('id', 'A finished backup of an app\'s volumes.')], body: ref('RestoreRequest'),
    description: 'Puts the files of the backup back into the app\'s persistent volumes. **It overwrites live data**, so it needs the current password and is recorded in the sign-ins list (`restore`). Each volume of the backup goes to the app\'s mounted volume at the same path; if one has no volume any more nothing is changed and the restore fails saying which. `mode`: `replace` (the volume ends up exactly as the backup was), `add` (written over the current files) or `empty` (refused when the volume holds anything). `safetyBackup`: a normal volume backup of the current data is made first (listed with trigger `before_restore`); if it fails nothing is restored. The worker stops the app (an app that is already stopped stays stopped), restores, reads the volumes back to check them, and starts the app again; if a deployment or another job is working on the app it fails instead of stopping it. Volumes the backup does not have are left alone. A restore of Shipdok itself (the database) is not available here: see the Operations guide. Answers 202; poll `GET /api/backups` (`restores`).',
    responses: { 202: ok('Asked for.', { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } }) },
    errors: { 400: 'Invalid body, not a backup of volumes (`code: not_volumes`), or the app has no persistent storage (`code: no_volumes`).', 403: 'Wrong password (`code: wrong_password`).', 404: 'No such backup.', 409: 'No file (`no_file`), the app is gone (`app_gone`), a backup of the app is being made (`backup_running`) or a restore is already waiting or running (`already_running`).', 410: 'The file is gone from the backups folder (`code: file_missing`).', 429: 'Too many tries.' },
  })),
  route('DELETE', '/api/backups/{id}', op({
    tag: LOG, summary: 'Delete a backup', parameters: [idParam('id', 'The backup.')],
    description: 'Removes the file and the record. Refused while it is being made.',
    responses: { 204: nothing('Deleted.') },
    errors: { 404: 'No such backup.', 409: 'It is still being made (`code: in_progress`).' },
  })),

  // ---------------------------------------------------------------- version
  route('GET', '/api/version', op({
    tag: SYS, summary: 'The running version and the newest published one', parameters: [query('fresh', 'Send `1` to look again now instead of using the answer kept for an hour (allowed at most twice a minute; otherwise the kept answer is returned).')],
    description: 'The release number this Shipdok runs (the `VERSION` file in its image; `null` if it cannot be read) and the highest plain version (`1.2.3`) among the tags of the published image on ghcr.io, which needs no login. It is looked up only when this is asked, and the answer is kept for an hour (five minutes after a failure). Shipdok never updates itself: `updateAvailable` only says a newer image exists.',
    responses: { 200: ok('The versions.', ref('VersionStatus')) },
  })),

  // ---------------------------------------------------------------- github
  route('GET', '/api/github', op({
    tag: GH, summary: 'The connected GitHub Apps',
    description: 'Every connected GitHub App, oldest first, never a secret, each with the projects assigned to it (`projects`, what the Disconnect warning lists). It also says what the webhook receiver refused lately for a wrong signature, from memory and with nothing but a number, a time and a count: `refusedPush` on the app whose secret did not match, and `unknownSenders` for pushes from an app that is not connected here. `problem: cannot_decrypt` on an app means its stored credentials do not fit the platform key; the others are not affected.',
    responses: { 200: ok('The apps.', ref('GithubStatus')) },
  })),
  route('POST', '/api/github/apps', op({
    tag: GH, summary: 'Enter an existing GitHub App by hand',
    description: 'Adds a GitHub App (there is no limit on how many). The key and id are proven with GitHub (`GET /app`) BEFORE anything is stored, so a typo never adds or replaces anything. Entering a GitHub App that is already connected replaces its credentials (same `id`, answer 200, `created: false`; its projects and their installations are kept, because the installations belong to the same GitHub App). Needs the current password. Recorded in the sign-ins list as a GitHub change.',
    body: ref('GithubManual'),
    responses: { 201: ok('Added.', ref('GithubAppAdded')), 200: ok('The same GitHub App was already connected: its credentials were replaced.', ref('GithubAppAdded')) },
    errors: { 400: 'A missing or malformed field, or GitHub did not accept the id and key (`code: github_rejected`), or the key belongs to another app (`code: app_id_mismatch`).', 403: 'Wrong password, or the Origin is not allowed.', 429: 'Too many tries.', 502: 'GitHub could not be reached (`code: github_unreachable`) or could not check the app.' },
  })),
  route('DELETE', '/api/github/apps/{id}', op({
    tag: GH, summary: 'Disconnect one GitHub App', parameters: [GH_APP_ID],
    description: 'Forgets that app. The projects assigned to it keep running and are left with **no GitHub app and no remembered installation**: private repositories cannot be built, and pushes do not deploy them, until they are given another GitHub app in their settings. The dashboard lists those projects (`projects` in `GET /api/github`) before asking. Shipdok cannot delete the app on github.com. Needs the current password.',
    body: ref('PasswordOnly'), responses: { 204: nothing('Disconnected.') },
    errors: { 400: 'No password given.', 403: 'Wrong password, or the Origin is not allowed.', 404: 'No such GitHub app (`code: github_app_not_found`).', 429: 'Too many tries.' },
  })),
  route('DELETE', '/api/github/refusals/{sender}', op({
    tag: GH, summary: 'Dismiss the notice about a refused push',
    parameters: [{ name: 'sender', in: 'path', required: true, description: 'GitHub\'s number for the app that sent the push (digits, as `appNumber` in `unknownSenders` and the App ID of a connected app), or `none` for a push that did not say which app sent it.', schema: { type: 'string' } }],
    description: 'Forgets what was recorded (in memory) about refused pushes from that sender, so the warning on the GitHub page goes away. Nothing is deployed or changed; the next refused push from the same sender brings the warning back. Answers 204 whether or not there was anything recorded.',
    responses: { 204: nothing('Dismissed.') },
    errors: { 404: 'Not a number and not `none`.' },
  })),
  route('POST', '/api/github/connect/start', op({
    tag: GH, summary: 'Start the "Connect GitHub" flow',
    description: 'Returns a prepared GitHub App definition (`manifest`) and the address (`postUrl`, always on github.com) the browser posts it to. Each run adds one more GitHub App, whether or not others are connected. Keeps a one-time `state` in the session for 10 minutes. The manifest asks only for read access to contents and metadata and the push event, and the app is created private. Needs an Origin that is one of the dashboard\'s own addresses, because GitHub sends the browser back there.',
    body: ref('ConnectStart'), bodyRequired: false, responses: { 200: ok('The manifest.', ref('ConnectManifest')) },
    errors: { 400: 'A bad name or organisation, or the dashboard was not opened at its own address.', 429: 'Too many tries.' },
  })),
  route('GET', '/api/github/connect/callback', op({
    tag: GH, auth: 'none', summary: 'Where GitHub sends the browser back',
    description: 'A page navigation, not an API call: GitHub redirects the browser here with a one-time `code` and the `state` from the start. Every outcome is a **302 redirect** to `/github?connected=<the new app\'s id>` or `/github?error=<login|state|exchange_failed|github_unreachable>`; the API trades the code for the app\'s credentials and stores them encrypted as one more GitHub App. The state is compared in constant time and used once whatever happens. No secret is ever put in a redirect.',
    parameters: [query('code', 'The one-time code from GitHub.'), query('state', 'The state returned by the start call.')],
    responses: { 302: nothing('Redirect to the GitHub page of the dashboard, with a short result code.') },
  })),
  route('GET', '/api/github/apps/{id}/repos', op({
    tag: GH, summary: 'Repositories one GitHub App can see', parameters: [GH_APP_ID],
    description: 'Across all installations of that GitHub App. This is the list behind the repository picker once a GitHub app is chosen.',
    responses: { 200: ok('The repositories.', { type: 'object', properties: { repos: { type: 'array', items: ref('GithubRepo') } } }) },
    errors: { ...ghApp404, 502: 'GitHub could not be asked.' },
  })),
  route('GET', '/api/github/apps/{id}/installations', op({
    tag: GH, summary: 'Where one GitHub App is installed', parameters: [GH_APP_ID],
    description: 'Asked from GitHub when you press "Check again" after installing the app.',
    responses: { 200: ok('The installations.', { type: 'object', properties: { installations: { type: 'array', items: ref('GithubInstallation') } } }) },
    errors: { ...ghApp404, 502: 'GitHub could not be asked.' },
  })),
  route('GET', '/api/github/repo-check', op({
    tag: GH, summary: 'Can Shipdok see this repository?',
    description: 'The first step of creating an app. One request to GitHub, through the given GitHub App\'s installation when it is installed on the repository, otherwise anonymously, which works for a public repository. Nothing about what is inside the repository is read. Always answers 200: `accessible: false` with a `reason` is an ordinary outcome (a private repository and one that does not exist look the same to GitHub). A good answer is kept for 60 seconds; `fresh=1` skips that. Failures are never kept.',
    parameters: [
      { name: 'repo', in: 'query', required: true, description: 'The repository, `owner/name`.', schema: { type: 'string' } },
      { name: 'app', in: 'query', required: false, description: 'The id of a connected GitHub App; left out: anonymous.', schema: { type: 'string', format: 'uuid' } },
      { name: 'fresh', in: 'query', required: false, description: '`1`: do not use a kept answer.', schema: { type: 'string', enum: ['1'] } },
    ],
    responses: { 200: ok('Whether it can be seen.', ref('RepoCheck')) },
    errors: { 400: 'Not a repository like owner/name (`code: bad_repo`).', ...ghApp404 },
  })),
  route('GET', '/api/github/branches', op({
    tag: GH, summary: 'The branches of a repository',
    parameters: [{ ...query('repo', 'The repository, as `owner/name`.'), required: true }, query('app', 'The id of the GitHub App to ask through. Left out: anonymously.')],
    description: 'For the branch pickers in the dashboard. With `app`, and when that GitHub App is installed on the repository, the branches are read with a token for that one repository (read-only); otherwise (no `app`, or it is not installed there) anonymously, which works for **public** repositories, and also when no GitHub App is connected at all. The default branch comes first, the rest alphabetical; at most the first 500 branches are read (`truncated`). Good answers are kept for a minute, separately for each GitHub app (what an app can see differs). A repository that is private and not covered by the app is a 404 `repo_not_found`; a GitHub rate limit is a 502 `rate_limited`.',
    responses: { 200: ok('The branches.', ref('BranchList')) },
    errors: { 400: 'Not a repository name (`code: bad_repo`).', 404: 'No such public repository, and the app is not installed on it (`code: repo_not_found`); or the `app` is not a connected GitHub App (`code: github_app_not_found`).', 409: 'That GitHub app\'s credentials cannot be read (`code: cannot_decrypt`).', 502: 'GitHub could not be reached (`github_unreachable`) or is limiting requests (`rate_limited`).' },
  })),
  route('GET', '/api/github/apps/{id}/webhook', op({
    tag: GH, summary: 'Does GitHub send this app\'s webhooks to the right address?', parameters: [GH_APP_ID],
    description: 'Compares the address GitHub has (read from that app) with the one Shipdok expects (the public address + `/api/webhooks/github`). Every GitHub app sends to the same Shipdok address; each has its own secret.',
    responses: { 200: ok('The comparison.', ref('GithubWebhook')) }, errors: { ...ghApp404, 502: 'GitHub could not be asked.' },
  })),
  route('POST', '/api/github/apps/{id}/webhook/sync', op({
    tag: GH, summary: 'Point one GitHub App at the right webhook address', parameters: [GH_APP_ID],
    description: 'Updates only the address on GitHub (never the secret), for that app. The retry for the automatic update, which follows a change of the public address and tells every connected app.',
    responses: { 200: ok('Updated.', ref('GithubWebhook')) },
    errors: { 400: 'No public address is set yet (`code: no_public_address`).', ...ghApp404, 429: 'Too many tries.', 502: 'GitHub could not be reached or did not accept it.' },
  })),

  // ---------------------------------------------------------------- settings
  route('GET', '/api/settings/public', op({
    tag: SET, summary: 'Who may reach Shipdok from outside', description: 'The mode (`local`, `webhook` or `full`), the public address, whether the environment fixes either, and how THIS request was classified (`visitor`).',
    responses: { 200: ok('The settings.', ref('PublicSettings')) },
  })),
  route('PUT', '/api/settings/public', op({
    tag: SET, summary: 'Change who may reach Shipdok from outside',
    description: 'Needs the current password; takes effect at once; recorded in the sign-ins list. A value fixed by the environment (`SHIPDOK_PUBLIC`, `PUBLIC_URL`) cannot be changed here. The address is tidied to an origin (`https://host[:port]`, no path, no credentials). A new address is also sent to every connected GitHub app; the answer says how that went in `githubWebhook` (`failed` names the apps that did not take it; the setting is saved either way).',
    body: { type: 'object', required: ['password'], properties: { password: { type: 'string' }, mode: { type: 'string', enum: ['local', 'webhook', 'full'] }, publicUrl: { type: 'string', nullable: true } }, description: 'Send `mode`, `publicUrl` or both.' },
    responses: { 200: ok('The settings after the change.', ref('PublicSettings')) },
    errors: { 400: 'No password, nothing to change, a bad mode or a bad address.', 403: 'Wrong password, or the Origin is not allowed.', 409: 'The environment fixes that setting (`code: locked_by_environment`).', 429: 'Too many tries.' },
  })),

  // ---------------------------------------------------------------- logs and storage
  route('GET', '/api/apps/{id}/logs', op({
    tag: LOG, summary: 'An app\'s own output', parameters: [APP_ID,
      query('kind', '`runtime` (default): since the container last started. `previous`: the run before that.', { type: 'string', enum: ['runtime', 'previous'], default: 'runtime' }),
      query('tail', 'The last N lines (1 to 5000). Cannot be combined with `offset` or `limit`.', { type: 'integer', minimum: 1, maximum: 5000 }),
      query('offset', 'Byte offset to start at (default 0).', { type: 'integer', minimum: 0 }),
      query('limit', 'How many bytes at most (1 to 1048576; default 65536).', { type: 'integer', minimum: 1, maximum: 1048576 }),
    ],
    description: 'There is one log per app plus the run before it, reset on every restart or deployment. Page through it with `nextOffset`; `complete` is true when the log has finished and everything has been read. Secrets are masked with `***`.',
    responses: { 200: ok('A piece of the log.', ref('LogChunk')) },
    errors: { 400: 'A bad `kind`, `offset`, `limit` or `tail`.', 404: 'No such app, or no output has been collected yet.' },
  })),
  route('DELETE', '/api/apps/{id}/logs', op({
    tag: LOG, summary: 'Delete an app\'s output logs', parameters: [APP_ID],
    description: 'Deletes both the current and the previous run\'s log. Refused while the app\'s output is still being collected (stop the app first).',
    responses: { 200: ok('Deleted.', { type: 'object', properties: { freedBytes: { type: 'integer' } } }) },
    errors: { 404: 'No such app, or no runtime logs.', 409: 'The app is running and its output is still being collected.', 500: 'The files could not be deleted.' },
  })),
  route('GET', '/api/deployments/{id}/logs', op({
    tag: LOG, summary: 'A deployment\'s build log', parameters: [DEPLOYMENT_ID,
      query('kind', 'Only `build`.', { type: 'string', enum: ['build'], default: 'build' }),
      query('tail', 'The last N lines (1 to 5000).', { type: 'integer', minimum: 1, maximum: 5000 }),
      query('offset', 'Byte offset to start at.', { type: 'integer', minimum: 0 }),
      query('limit', 'How many bytes at most (1 to 1048576; default 65536).', { type: 'integer', minimum: 1, maximum: 1048576 }),
    ],
    description: 'The clone and build output plus Shipdok\'s progress lines and the outcome. Kept until the deployment is deleted. Each line is `<ISO time> <stdout|stderr|shipdok> <message>`; the app\'s variable values and the GitHub token are masked with `***`.',
    responses: { 200: ok('A piece of the log.', ref('LogChunk')) },
    errors: { 400: 'A bad `kind`, `offset`, `limit` or `tail`.', 404: 'No such deployment, or no log.' },
  })),
  route('DELETE', '/api/deployments/{id}/logs', op({
    tag: LOG, summary: 'Delete a finished deployment\'s build log', parameters: [DEPLOYMENT_ID],
    description: 'The deployment, its status and its error summary stay.',
    responses: { 200: ok('Deleted.', { type: 'object', properties: { freedBytes: { type: 'integer' } } }) },
    errors: { 404: 'No such deployment, or no logs.', 409: 'The deployment is still running.', 500: 'The files could not be deleted.' },
  })),
  route('GET', '/api/storage', op({
    tag: LOG, summary: 'Disk, log and image usage', description: 'Log bytes and image bytes per app (image sizes are upper bounds: versions of an app share layers), the persistent volumes as last measured (`volumes`; `0` and `measuredAt: null` until a measurement was asked for) and the disk\'s free space with a level: `ok`, `low` (under 20% free) or `critical` (under 10%).',
    responses: { 200: ok('The usage.', ref('Storage')) },
  })),

  // ---------------------------------------------------------------- webhooks
  route('POST', '/api/webhooks/github', op({
    tag: HOOK, auth: 'signature', summary: 'GitHub\'s push webhook',
    description: 'Called by GitHub, not by people. **Public and protected only by the HMAC signature** (`X-Hub-Signature-256`, SHA-256 over the exact bytes, compared in constant time). Order: size limit, signature, shape, then the database. A push to a branch that an app tracks deploys that app (every app tracking the repository and branch); other events and branches are recorded and ignored. Deliveries are deduplicated by `X-GitHub-Delivery`. Pushes are not built while the disk is critically full. Rate limited to 120 requests a minute per client. Answers 503 until a GitHub App is connected. Which visitors can reach it from outside depends on the public access mode.',
    parameters: [
      { name: 'X-Hub-Signature-256', in: 'header', required: true, description: '`sha256=` and the hex HMAC of the body, with the webhook secret.', schema: { type: 'string' } },
      { name: 'X-GitHub-Event', in: 'header', required: true, description: 'The event name (`push`, `ping`, ...).', schema: { type: 'string' } },
      { name: 'X-GitHub-Delivery', in: 'header', required: true, description: 'GitHub\'s unique delivery id.', schema: { type: 'string' } },
    ],
    rawBody: { required: true, description: 'GitHub\'s JSON payload (set the webhook content type to `application/json`).', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
    responses: {
      200: ok('Handled without deploying: `ignored` (with `reason`) or `duplicate`.', ref('WebhookResult')),
      202: ok('Deployments were requested.', ref('WebhookResult')),
    },
    errors: { 400: 'A missing or invalid header, or the payload is not a JSON object.', 401: 'The signature is missing or wrong.', 429: 'Too many requests.', 503: 'No GitHub App is connected (`Webhooks are not configured`), or the queue is unavailable.' },
  })),
  route('GET', '/api/webhooks/deliveries', op({
    tag: HOOK, summary: 'Recent webhook deliveries', description: 'The last 50 deliveries: "why didn\'t my push deploy?". `details` says, per app, what happened.',
    responses: { 200: ok('The deliveries.', { type: 'array', items: ref('WebhookDelivery') }) },
  })),

  // ---------------------------------------------------------------- system
  route('GET', '/health', op({
    tag: SYS, auth: 'none', summary: 'Is the API up?', description: 'Answers as long as the process runs (used by the container health check).',
    responses: { 200: ok('Up.', { type: 'object', properties: { status: { type: 'string', example: 'ok' } } }) },
  })),
  route('GET', '/health/ready', op({
    tag: SYS, auth: 'none', summary: 'Is the API ready?', description: 'Like `/health`, and also checks that the database answers. Answers 503 while it does not.',
    responses: { 200: ok('Ready.', { type: 'object', properties: { status: { type: 'string', example: 'ready' } } }), 503: ok('The database is unavailable.', { type: 'object', properties: { status: { type: 'string' } } }) },
  })),
  route('GET', '/api/docs', op({
    tag: SYS, summary: 'This API reference (page)',
    description: 'The interactive reference built from this document (Scalar). A web page for the signed-in administrator, with everything served from Shipdok itself (no internet needed). Can be switched off with `API_DOCS=false`, in which case it answers 404.',
    responses: { 200: { description: 'The page (HTML).', content: { 'text/html': { schema: { type: 'string' } } } } },
  })),
  route('GET', '/api/docs/openapi.json', op({
    tag: SYS, summary: 'This document (OpenAPI 3)',
    description: 'The OpenAPI 3.0 description of the API, as JSON. Generated from the code\'s route list and descriptions with `npm run openapi`.',
    responses: { 200: ok('The document.', { type: 'object', additionalProperties: true }) },
  })),
  route('GET', '/api/docs/scalar.js', op({
    tag: SYS, summary: 'The API reference\'s script',
    description: 'Scalar\'s browser bundle, served from Shipdok so the reference works without the internet. Used by the reference page.',
    responses: { 200: { description: 'JavaScript.', content: { 'application/javascript': { schema: { type: 'string' } } } } },
  })),
  route('GET', '/api/_visitor', op({
    tag: SYS, auth: 'none', summary: 'May this visitor see the dashboard?',
    description: 'Used by the dashboard\'s web server before it serves a page: **204** for a local visitor or when the mode is `full`, otherwise **403**. Not for general use.',
    responses: { 204: nothing('The visitor may see the dashboard.'), 403: nothing('The visitor may not (the web server turns this into a 404).') },
  })),
]);
