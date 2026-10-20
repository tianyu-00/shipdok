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
const github501 = { 501: 'GitHub is not connected yet (connect it on the GitHub page).' };

export default Object.fromEntries([
  // ---------------------------------------------------------------- variables
  route('GET', '/api/apps/{id}/env', op({
    tag: ENV, summary: 'List an app\'s variables', parameters: [APP_ID],
    description: 'The names, where each is available (`scope`), **never the values** (they are always `********`), and which changes wait for the next deployment.',
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
    description: 'Stores the value encrypted (AES-256-GCM, bound to the app and the name). The running app keeps its old value until the next deployment. `scope` says where the variable is available: `runtime` (the container; the default for a new variable), `build` (only `docker build --build-arg`; the container never sees it) or `both`. Send a `value`, a `scope`, a `newKey`, or any of them together: a value alone keeps the scope; a scope alone changes where an existing variable is available and keeps its value (404 if there is no such variable). `newKey` renames an existing variable (the value is encrypted for its name, so the server decrypts and encrypts it again, in the same transaction as the rest of the request; the value never leaves the server). The new name follows the same rules as any name, 409 `name_taken` if another variable has it, and the answer says `previous_key`. Until the next deployment the old name counts as removed and the new one as added. A build variable is baked into the image if the Dockerfile uses it (`ARG NAME`), so use it for public configuration, not secrets; some names (`PATH`, `HOME`, `DOCKER_*`, `BUILDKIT_*`, `LD_*`...) cannot be used at build time.',
    body: { type: 'object', properties: { value: { type: 'string', description: 'The value; at most 64 KB, no null characters. Leave it out to change only the scope.' }, scope: { type: 'string', enum: ['runtime', 'build', 'both'], description: 'Where the variable is available. Default for a new variable: `runtime`; an existing variable keeps its scope when this is left out.' }, newKey: { type: 'string', description: 'Rename the variable to this name (it must already exist, and the new name must be free).' } }, additionalProperties: false },
    responses: { 200: ok('Changed.', { type: 'object', properties: { key: { type: 'string' }, created: { type: 'boolean' }, scope: { type: 'string', enum: ['runtime', 'build', 'both'] }, previous_key: { type: 'string', description: 'Only after a rename: the name it had.' }, updated_at: { type: 'string', format: 'date-time' } } }), 201: ok('Created.', { type: 'object', properties: { key: { type: 'string' }, created: { type: 'boolean' }, scope: { type: 'string', enum: ['runtime', 'build', 'both'] }, updated_at: { type: 'string', format: 'date-time' } } }) },
    errors: { 400: 'A bad name, value or scope, a reserved name, a name that cannot be used at build time, nothing to set, or too many variables.', 404: 'No such app, or (with a scope only, or a rename) no such variable.', 409: 'A rename to a name another variable already has (`code: name_taken`).', 500: 'A rename of a stored value that cannot be decrypted (has `APP_SECRETS_KEY` changed?); send a new value with it.' },
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

  // ---------------------------------------------------------------- github
  route('GET', '/api/github', op({
    tag: GH, summary: 'Is GitHub connected?', description: 'The connected GitHub App\'s details, never a secret. `problem: cannot_decrypt` means the stored credentials do not fit the platform key.',
    responses: { 200: ok('The status.', ref('GithubStatus')) },
  })),
  route('POST', '/api/github/manual', op({
    tag: GH, summary: 'Enter an existing GitHub App by hand',
    description: 'The key and id are proven with GitHub (`GET /app`) BEFORE anything is stored, so a typo never replaces a working connection. Needs the current password. Remembered installations are forgotten, because installation ids belong to one app. Recorded in the sign-ins list as a GitHub change.',
    body: ref('GithubManual'),
    responses: { 200: ok('Connected.', { type: 'object', properties: { connected: { type: 'boolean' }, app: ref('GithubApp') } }) },
    errors: { 400: 'A missing or malformed field, or GitHub did not accept the id and key (`code: github_rejected`), or the key belongs to another app (`code: app_id_mismatch`).', 403: 'Wrong password, or the Origin is not allowed.', 429: 'Too many tries.', 502: 'GitHub could not be reached (`code: github_unreachable`) or could not check the app.' },
  })),
  route('DELETE', '/api/github', op({
    tag: GH, summary: 'Disconnect GitHub',
    description: 'Forgets the app. Deployed apps keep running; private repositories cannot be built until GitHub is connected again. Shipdok cannot delete the app on github.com. Needs the current password.',
    body: ref('PasswordOnly'), responses: { 204: nothing('Disconnected.') },
    errors: { 400: 'No password given.', 403: 'Wrong password, or the Origin is not allowed.', 429: 'Too many tries.' },
  })),
  route('POST', '/api/github/connect/start', op({
    tag: GH, summary: 'Start the "Connect GitHub" flow',
    description: 'Returns a prepared GitHub App definition (`manifest`) and the address (`postUrl`, always on github.com) the browser posts it to. Keeps a one-time `state` in the session for 10 minutes. The manifest asks only for read access to contents and metadata and the push event, and the app is created private. Needs an Origin that is one of the dashboard\'s own addresses, because GitHub sends the browser back there.',
    body: ref('ConnectStart'), bodyRequired: false, responses: { 200: ok('The manifest.', ref('ConnectManifest')) },
    errors: { 400: 'A bad name or organisation, or the dashboard was not opened at its own address.', 409: 'GitHub is already connected (`code: already_connected`).', 429: 'Too many tries.' },
  })),
  route('GET', '/api/github/connect/callback', op({
    tag: GH, auth: 'none', summary: 'Where GitHub sends the browser back',
    description: 'A page navigation, not an API call: GitHub redirects the browser here with a one-time `code` and the `state` from the start. Every outcome is a **302 redirect** to `/github?connected=1` or `/github?error=<login|state|exchange_failed|github_unreachable|already_connected>`; the API trades the code for the app\'s credentials and stores them encrypted. The state is compared in constant time and used once whatever happens. No secret is ever put in a redirect.',
    parameters: [query('code', 'The one-time code from GitHub.'), query('state', 'The state returned by the start call.')],
    responses: { 302: nothing('Redirect to the GitHub page of the dashboard, with a short result code.') },
  })),
  route('GET', '/api/github/repos', op({
    tag: GH, summary: 'Repositories the app can see', description: 'Across all installations of the connected GitHub App.',
    responses: { 200: ok('The repositories.', { type: 'object', properties: { repos: { type: 'array', items: ref('GithubRepo') } } }) },
    errors: { ...github501, 502: 'GitHub could not be asked.' },
  })),
  route('GET', '/api/github/installations', op({
    tag: GH, summary: 'Where the app is installed', description: 'Asked from GitHub when you press "Check again" after installing the app.',
    responses: { 200: ok('The installations.', { type: 'object', properties: { installations: { type: 'array', items: ref('GithubInstallation') } } }) },
    errors: { ...github501, 502: 'GitHub could not be asked.' },
  })),
  route('GET', '/api/github/webhook', op({
    tag: GH, summary: 'Does GitHub send webhooks to the right address?',
    description: 'Compares the address GitHub has (read from the app) with the one Shipdok expects (the public address + `/api/webhooks/github`).',
    responses: { 200: ok('The comparison.', ref('GithubWebhook')) }, errors: { ...github501, 502: 'GitHub could not be asked.' },
  })),
  route('POST', '/api/github/webhook/sync', op({
    tag: GH, summary: 'Point GitHub at the right webhook address',
    description: 'Updates only the address on GitHub (never the secret). The retry for the automatic update that follows a change of the public address.',
    responses: { 200: ok('Updated.', ref('GithubWebhook')) },
    errors: { 400: 'No public address is set yet (`code: no_public_address`).', ...github501, 429: 'Too many tries.', 502: 'GitHub could not be reached or did not accept it.' },
  })),

  // ---------------------------------------------------------------- settings
  route('GET', '/api/settings/public', op({
    tag: SET, summary: 'Who may reach Shipdok from outside', description: 'The mode (`local`, `webhook` or `full`), the public address, whether the environment fixes either, and how THIS request was classified (`visitor`).',
    responses: { 200: ok('The settings.', ref('PublicSettings')) },
  })),
  route('PUT', '/api/settings/public', op({
    tag: SET, summary: 'Change who may reach Shipdok from outside',
    description: 'Needs the current password; takes effect at once; recorded in the sign-ins list. A value fixed by the environment (`SHIPDOK_PUBLIC`, `PUBLIC_URL`) cannot be changed here. The address is tidied to an origin (`https://host[:port]`, no path, no credentials). A new address is also sent to GitHub when an app is connected; the answer says how that went in `githubWebhook` (the setting is saved either way).',
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
    tag: LOG, summary: 'Disk, log and image usage', description: 'Log bytes and image bytes per app (image sizes are upper bounds: versions of an app share layers) and the disk\'s free space with a level: `ok`, `low` (under 20% free) or `critical` (under 10%).',
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
