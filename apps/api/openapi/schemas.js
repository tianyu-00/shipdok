// The shapes of what the API sends. Request bodies that the API validates with zod come from those validators (so they cannot drift);
// the rest is written here, from what the routes return.
import { z } from 'zod';
import { createSchema, updateSchema, retentionSchema, rollbackSchema, deploySchema } from '../src/routes/apps.js';
import { ref } from './helpers.js';

const fromZod = (schema) => z.toJSONSchema(schema, { target: 'openapi-3.0', io: 'input', unrepresentable: 'any' });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const nstr = (description, extra = {}) => ({ type: 'string', nullable: true, description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const nint = (description, extra = {}) => ({ type: 'integer', nullable: true, description, ...extra });
const bool = (description) => ({ type: 'boolean', description });
const time = (description) => ({ type: 'string', format: 'date-time', description });
const ntime = (description) => ({ type: 'string', format: 'date-time', nullable: true, description });
const uuid = (description) => ({ type: 'string', format: 'uuid', description });
const obj = (properties, required = Object.keys(properties), description) => ({ type: 'object', ...(description ? { description } : {}), properties, ...(required.length ? { required } : {}) });
const arr = (items) => ({ type: 'array', items });
const enumOf = (values, description) => ({ type: 'string', enum: values, description });

export const schemas = {
  Error: {
    type: 'object',
    required: ['error'],
    properties: {
      error: str('A sentence for a person.'),
      code: str('A short stable code for programs, where there is one (for example `wrong_password`, `locked`, `port_taken`).'),
      details: { type: 'array', items: { type: 'string' }, description: 'Each problem, when a request had several.' },
    },
  },
  Empty: { type: 'object', description: 'No content.' },

  // ---- apps
  AppCreate: { ...fromZod(createSchema), description: 'A new app. `host_port` left out: the lowest free port in the platform\'s port range is used.' },
  AppUpdate: { ...fromZod(updateSchema), description: 'Settings to change; send only the ones you want to change. The repository and the slug cannot be changed.' },
  Retention: { ...fromZod(retentionSchema), description: 'How many earlier versions\' images to keep, and whether to clean up automatically.' },
  RollbackRequest: { ...fromZod(rollbackSchema), description: '`deploymentId`: the version to go back to (default: the newest earlier version that still has an image). `start`: also start the app if it is stopped.' },
  DeployRequest: { ...fromZod(deploySchema), description: '`start`: start the app after deploying if it is stopped. `ignoreDiskWarning`: deploy although the disk is almost full. `noCache`: build this one deployment without Docker\'s build cache (every step runs again; slower).' },
  Runtime: obj({
    state: enumOf(['running', 'stopped', 'unhealthy', 'restarting', 'crashed', 'missing'], 'What the worker last saw. `missing`: the container was removed outside Shipdok.'),
    last_action: { ...nstr('The last thing the worker did.'), enum: ['deploy', 'start', 'stop', 'restart', 'auto_restart', 'recover', null] },
    last_error: nstr('Why the last action or the current state is a problem.'),
    last_exit_code: nint('The exit code of the last time the container stopped.'),
    oom_killed: bool('Whether that stop was an out-of-memory kill.'),
    health_failures: int('Health checks failed in a row.'),
    next_restart_at: ntime('When a scheduled automatic restart is due.'),
    updated_at: time('When this was last written.'),
  }, undefined, 'What the worker last reported about the running container. `null` (on the app) until it has reported.'),
  Stats: {
    type: 'object', nullable: true,
    description: 'The newest CPU and memory reading of the running container, or `null` when it is older than 90 seconds (the app is stopped or the worker is quiet).',
    properties: {
      cpuPercent: { type: 'number', nullable: true, description: 'A share of ONE processor, like `docker stats`; above 100 when more than one is busy. `null` when there is nothing to compare with yet.' },
      memoryBytes: int('Memory in use, without the file cache the kernel can take back.'),
      memoryLimitBytes: nint('The container\'s memory limit.'),
      sampledAt: time('When the reading was taken.'),
    },
  },
  Cleanup: {
    type: 'object', nullable: true, description: 'What the last image clean-up of the app did (`null` until one has run).',
    properties: {
      last_run_at: time('When it ran.'), trigger: str('`manual` or `auto`.'), images_removed: int('How many images were removed.'),
      freed_bytes: int('Disk space freed, measured as the drop in Docker\'s layer usage (0 if Docker cannot say).'),
      skipped: int('Images that were not removed because something still uses them.'), error: nstr('A failure, if there was one.'),
    },
  },
  DeploymentBrief: { type: 'object', nullable: true, description: 'The app\'s newest deployment.', properties: { id: uuid('Deployment id.'), status: ref('DeploymentStatus'), commit_sha: nstr('The commit.'), queued_at: time('When it was requested.'), finished_at: ntime('When it ended.') } },
  RunningSettings: { type: 'object', nullable: true, additionalProperties: true, description: 'The settings the running version was deployed with (the newest successful deployment\'s snapshot, without variable versions). `null` until one succeeded. Editing the app changes the NEXT deployment, not this.' },
  App: {
    type: 'object',
    description: 'An app.',
    properties: {
      id: uuid('The app\'s id.'), name: str('Display name (editable).'), slug: str('Normalised name; names the images and containers and never changes.'),
      repo: str('GitHub `owner/repo`.'), github_installation_id: { type: 'integer', nullable: true, description: 'The GitHub App installation remembered for this repository (`null` until found).' },
      github_app_id: { type: 'string', format: 'uuid', nullable: true, description: 'The connected GitHub App this project uses to list and clone its repository and whose webhooks deploy it (`null`: none, for a public repository deployed by hand).' },
      branch: str('The branch deployed on push.'), root_dir: str('Where the Dockerfile is, inside the repository.'),
      container_port: int('The port the app listens on inside its container.'), host_port: nint('The port it is published on, on this machine.'),
      health_path: nstr('A path that answers when the app is healthy (`null`: any answer counts).'),
      memory_mb: int('Memory limit in MB.'), cpus: { type: 'string', description: 'CPU limit, as a decimal string (for example `"1.00"`).' },
      max_restarts: int('Automatic restarts allowed within 10 minutes before the app is marked crashed.'),
      build_timeout_minutes: nint('Minutes the clone and the build may take before they are stopped (5 to 10080); `null` = no limit (the default). A build that hangs and has no limit blocks the queue until it is cancelled.'),
      desired_state: enumOf(['running', 'stopped'], 'What the administrator wants. What really happens is in `runtime`.'),
      keep_previous_images: int('Earlier versions\' images kept besides the running one.'), auto_prune: bool('Clean up images automatically after each successful deployment.'),
      deleting_at: ntime('Set while the app is being deleted.'), delete_error: nstr('Why a deletion failed (press delete again to retry).'),
      created_at: time('Created.'), updated_at: time('Last edited.'),
      latest_deployment: ref('DeploymentBrief'), runtime: { ...ref('Runtime'), nullable: true }, cleanup: ref('Cleanup'),
      running_settings: ref('RunningSettings'), stats: ref('Stats'),
      settings_pending: { type: 'array', nullable: true, items: { type: 'string' }, description: 'Only on the single-app answers: which edited settings the running version does not have yet, including `volumes` for persistent storage (`null`: nothing deployed yet).' },
      warning: str('Only when creating: for example that the GitHub App is not installed on the repository.'),
    },
  },
  DeploymentStatus: enumOf(['queued', 'building', 'starting', 'validating', 'successful', 'failed', 'cancelled', 'superseded', 'interrupted'], 'Where a deployment is. Separate from whether the app is running.'),
  Deployment: {
    type: 'object',
    properties: {
      id: uuid('Deployment id.'), app_id: uuid('The app.'), commit_sha: nstr('The commit built.'), trigger: enumOf(['manual', 'webhook', 'rollback'], 'What asked for it.'),
      status: ref('DeploymentStatus'), image_ref: nstr('The Docker image built or reused.'), image_bytes: { type: 'string', nullable: true, description: 'Image size in bytes, as a string.' },
      image_removed_at: ntime('When the image was cleaned up (the version can no longer be rolled back to).'),
      rollback_of: { ...uuid('For a rollback: the version it went back to.'), nullable: true },
      config_snapshot: { type: 'object', additionalProperties: true, description: 'The settings this deployment used (no secret values).' },
      error_summary: nstr('A short reason it failed; the build log has the detail.'), job_id: nstr('The queue job.'),
      queued_at: time('Requested.'), started_at: ntime('Started.'), finished_at: ntime('Ended.'),
      cancel_status: { type: 'string', nullable: true, enum: ['cancelled', 'superseded', null] }, superseded_by: { ...uuid('The newer deployment that replaced it.'), nullable: true },
      warning: str('Only when requesting: for example that the disk is getting full.'), disk: { type: 'object', additionalProperties: true, description: 'Only with `warning`: the disk figures.' },
    },
  },
  CrashEvent: obj({
    occurred_at: time('When.'), cause: enumOf(['crash', 'stopped_outside', 'recovered', 'removed_outside'], 'Why the app was not running when it should be.'),
    exit_code: nint('The exit code, where there was one.'), oom_killed: bool('Killed for running out of memory.'),
    action: enumOf(['restart_scheduled', 'gave_up', 'none', 'restarted'], 'What Shipdok did about it.'),
  }),
  StatsHistory: obj({
    latest: ref('Stats'),
    samples: arr(obj({ t: time('When.'), cpu: { type: 'number', nullable: true }, memory: int('Memory in bytes.') })),
  }),
  ImageVersion: obj({
    deploymentId: uuid('The deployment.'), commit: nstr('Commit.'), trigger: str('What asked for it.'), finishedAt: time('When it went live.'),
    image: str('The Docker image.'), bytes: nint('Image size.'),
    state: enumOf(['live', 'previous', 'prunable', 'removed'], 'live: runs now. previous: kept for rollback. prunable: a clean-up would remove it. removed: its image is gone.'),
    rollbackOf: { ...uuid('If this was a rollback.'), nullable: true }, canRollBackTo: bool('Whether Roll back can use it.'),
  }),
  Images: obj({
    keep_previous_images: int('Earlier versions kept.'), auto_prune: bool('Automatic clean-up.'), cleanup: ref('Cleanup'),
    prunableBytes: int('What a clean-up would free (an upper bound).'), versions: arr(ref('ImageVersion')),
  }),

  // ---- persistent storage
  Volume: obj({
    id: uuid('The volume\'s id.'), path: str('The container path it is mounted at.'),
    state: enumOf(['in_use', 'detached', 'orphaned'], 'in_use: listed for the app and mounted by its deployments. detached: the path was removed from the list; the data is KEPT but not mounted. orphaned: the app was deleted and its data kept.'),
    dockerName: str('The Docker volume name (`shipdok-vol-<id>`), for example for a manual backup.'),
    appId: { ...uuid('The app, or `null` once it is gone.'), nullable: true }, appName: str('The app\'s name (remembered after the app is deleted).'),
    createdAt: time('Created.'), stateChangedAt: time('When the state last changed.'),
    removeError: nstr('Why the last request to delete it did not work.'),
  }),
  VolumePaths: { type: 'object', required: ['paths'], properties: { paths: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 200 }, description: 'The container paths to keep (absolute; letters, digits, dot, dash, underscore, slash; not `/`, not under `/proc`, `/sys` or `/dev`; no duplicates and none inside another). The whole list: a path that is left out is detached, never deleted.' } } },
  VolumeList: obj({ volumes: arr(ref('Volume')) }),

  // ---- branches
  BranchList: obj({
    defaultBranch: nstr('The repository\'s default branch (`null` if GitHub did not say).'),
    branches: arr({ type: 'string' }),
    truncated: bool('There were more branches than the first 500 that were read.'),
  }, ['defaultBranch', 'branches', 'truncated'], 'The default branch first, the rest in alphabetical order.'),

  // ---- build cache
  BuildCache: obj({
    totalBytes: nint('Size of Docker\'s build cache when the worker last measured it (`null` until it has, or if this Docker cannot say).'),
    reclaimableBytes: nint('The part no build is using, which a clean-up can remove.'),
    sampledAt: { ...nstr('When it was measured.'), format: 'date-time' },
    cleaning: bool('A clean-up was asked for and has not reported back yet.'),
    last: { ...obj({ at: time('When the last clean-up finished.'), all: bool('It removed every unused entry (otherwise only those unused for a day).'), freedBytes: int('What Docker says it freed.'), error: nstr('Why it failed, if it did.') }), nullable: true, description: 'The most recent clean-up, or `null`.' },
  }),
  CleanCacheRequest: { type: 'object', properties: { all: { type: 'boolean', default: false, description: '`true`: remove every unused entry, so the next builds start from nothing. Default `false`: only cache no build has used for 24 hours.' } }, additionalProperties: false },

  // ---- variables
  EnvList: obj({
    variables: arr(obj({ key: str('The name.'), value: str('Always `********`: values are never returned here.'), scope: enumOf(['runtime', 'build', 'both'], 'Where it is available: the running container, `docker build` only, or both.'), build_as: enumOf(['arg', 'secret'], 'How a variable that reaches the build is given to `docker build`: a build argument (`arg`) or a BuildKit secret (`secret`). Means nothing for `runtime`.'), updated_at: time('Last changed.') })),
    pending: obj({
      deployed: bool('Whether the app has been deployed.'), pending: bool('Whether any change waits for the next deployment.'),
      added: arr(str('Name.')), changed: arr(str('Name.')), removed: arr(str('Name.')),
    }),
  }),

  // ---- logs and storage
  LogChunk: obj({
    text: str('The log text.'), offset: int('Byte offset of the start of `text`.'), nextOffset: int('Where to continue from.'), size: int('The file\'s size.'),
    complete: bool('The log has finished AND everything has been read.'), truncated: bool('The log hit its size cap.'),
    deploymentId: { ...uuid('Runtime logs only: the deployment whose container wrote it.'), nullable: true },
  }, ['text', 'offset', 'nextOffset', 'size', 'complete', 'truncated']),
  Disk: { type: 'object', nullable: true, description: 'The disk the logs (and normally Docker) live on, or `null` if it cannot be measured.', properties: { totalBytes: int('Size.'), freeBytes: int('Free.'), freePercent: { type: 'number' }, level: enumOf(['ok', 'low', 'critical'], 'low: under 20% free. critical: under 10% free.') } },
  Storage: obj({
    logs: obj({ totalBytes: int('All logs.'), apps: arr(obj({ appId: uuid('App.'), slug: str('Slug.'), bytes: int('Log bytes.'), files: int('Log files.') })) }),
    images: obj({ totalBytes: int('All images (an upper bound).'), apps: arr(obj({ appId: uuid('App.'), slug: str('Slug.'), images: int('Images.'), bytes: int('Bytes.') })) }),
    disk: ref('Disk'),
  }),

  // ---- accounts
  Credentials: obj({ username: str('3 to 64 characters: letters, numbers, dot, dash, underscore.', { minLength: 3, maxLength: 64, pattern: '^[A-Za-z0-9_.-]+$' }), password: str('12 to 256 characters; refused: a repeated short pattern, a plain run of characters, or one containing the username.', { minLength: 12, maxLength: 256 }) }),
  AuthStatus: obj({ needsSetup: bool('No administrator exists yet.'), authenticated: bool('This browser has a valid session.'), setupTokenRequired: bool('The setup screen must ask for the setup token (the token is printed in the API log).') }),
  Username: obj({ username: str('The signed-in name.') }),
  SetupResult: obj({ username: str('The administrator.'), recoveryCodes: arr(str('A code, `XXXX-XXXX-XXXX-XXXX`.')) }, undefined, 'The only time the recovery codes are ever returned.'),
  LoginAttempt: obj({ at: time('When.'), kind: enumOf(['login', 'setup', 'recovery', 'reset', 'settings', 'github'], 'What was attempted or changed.'), username: str('The name typed (any name, real or not).'), address: str('The client address (`host` for a reset on the machine).'), success: bool('Whether it worked.') }),
  RecoveryStatus: obj({ remaining: int('Unused codes left (of 10).'), createdAt: ntime('When the current set was made.') }),
  Locked: obj({ error: str('A sentence.'), code: enumOf(['locked'], 'Always `locked`.'), retryAfterSeconds: int('Seconds to wait.') }),

  // ---- public access
  PublicSettings: obj({
    mode: enumOf(['local', 'webhook', 'full'], 'Who may reach Shipdok from outside.'), publicUrl: nstr('The public address (an origin, no path), or `null`.'),
    modeLocked: bool('The environment (`SHIPDOK_PUBLIC`) fixes the mode.'), urlLocked: bool('The environment (`PUBLIC_URL`) fixes the address.'),
    visitor: enumOf(['local', 'outside'], 'How THIS request was classified.'),
    githubWebhook: obj({ updated: bool('Whether every connected GitHub app now has the new webhook address.'), failed: { type: 'array', items: { type: 'string' }, description: 'The names of the GitHub apps that did not take it.' }, error: str('Why not.') }, ['updated'], 'Only after a change of the public address while a GitHub app is connected.'),
  }, ['mode', 'publicUrl', 'modeLocked', 'urlLocked', 'visitor']),

  // ---- GitHub
  GithubApp: obj({
    id: uuid('Shipdok\'s id for this GitHub App (what a project\'s `github_app_id` refers to).'), appId: str('The GitHub App id.'), slug: nstr('The app\'s URL name.'), name: nstr('Its name.'), ownerLogin: nstr('The account that owns it.'), htmlUrl: nstr('Its page on github.com.'),
    clientId: nstr('Its client id.'), source: enumOf(['manifest', 'manual'], 'How it was connected.'), connectedAt: time('When.'), updatedAt: time('Last changed.'),
  }, undefined, 'A connected GitHub App. Never contains a secret.'),
  GithubAppListed: {
    allOf: [ref('GithubApp'), obj({
      problem: { type: 'string', nullable: true, enum: ['cannot_decrypt', null], description: '`cannot_decrypt`: the stored credentials do not fit the platform key.' },
      projects: { type: 'array', description: 'The projects assigned to this GitHub App.', items: obj({ id: uuid('The project\'s id.'), name: str('Its name.'), slug: str('Its slug.') }) },
    })],
  },
  GithubStatus: obj({ apps: { type: 'array', items: ref('GithubAppListed'), description: 'Every connected GitHub App, oldest first.' } }),
  GithubAppAdded: obj({ created: bool('`true` for a new GitHub App, `false` when an app that was already connected had its credentials replaced.'), app: ref('GithubApp') }),
  GithubManual: obj({
    password: str('The administrator\'s current password.'), appId: { oneOf: [{ type: 'string' }, { type: 'integer' }], description: 'The App ID (a number; not the Client ID).' },
    privateKey: str('The private key (the `.pem` file\'s text).'), webhookSecret: str('The app\'s webhook secret, 16 to 256 characters.', { minLength: 16, maxLength: 256 }),
  }),
  PasswordOnly: obj({ password: str('The administrator\'s current password.') }),
  GithubRepo: obj({ fullName: str('`owner/repo`.'), private: bool('Private repository.'), defaultBranch: nstr('Its default branch.'), installationId: int('The installation that covers it.') }),
  GithubInstallation: obj({ id: int('Installation id.'), account: nstr('The account it is installed on.') }),
  GithubWebhook: obj({ expected: nstr('The address Shipdok expects (public address + `/api/webhooks/github`).'), actual: nstr('The address GitHub has.'), matches: { type: 'boolean', nullable: true, description: '`null` when either is unknown.' } }),
  ConnectStart: obj({ owner: str('An organisation to create the app under (default: the personal account).'), name: str('The app name, 1 to 34 characters (default `Shipdok-xxxx`).') }, []),
  ConnectManifest: obj({ postUrl: str('Where the browser posts `manifest` (always on github.com).'), manifest: { type: 'object', additionalProperties: true, description: 'The prepared GitHub App definition.' } }),

  // ---- webhooks
  WebhookResult: {
    type: 'object',
    properties: {
      status: enumOf(['deployed', 'ignored', 'duplicate', 'error'], 'What was done.'), reason: str('Why it was ignored.'),
      deployments: arr(uuid('A deployment that was requested.')),
    },
    required: ['status'],
  },
  WebhookDelivery: obj({
    delivery_id: str('GitHub\'s delivery id.'), event: str('The GitHub event.'), repo: nstr('Repository.'), ref: nstr('Branch.'), commit_sha: nstr('Commit.'),
    outcome: enumOf(['processing', 'deployed', 'ignored', 'error'], 'The result.'), reason: nstr('Why, in a sentence.'),
    details: { type: 'array', nullable: true, description: 'Per app: what happened.', items: { type: 'object', additionalProperties: true } },
    received_at: time('Received.'), processed_at: ntime('Finished.'),
  }),
};
