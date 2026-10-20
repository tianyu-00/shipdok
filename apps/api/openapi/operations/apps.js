import { op, route, ok, ref, APP_ID, DEPLOYMENT_ID, query } from '../helpers.js';

const TAG = 'Apps';
const DEP = 'Deployments';
const MAINT = 'Images and clean-up';
const nothing = (description) => ({ description });
const DELETING = 'The app is being deleted (`code: deleting`): it accepts nothing but another delete.';
const queued = (what) => ({ type: 'object', properties: { queued: { type: 'boolean' } }, description: what });

export default Object.fromEntries([
  route('GET', '/api/apps', op({
    tag: TAG, summary: 'List apps',
    description: 'Every app, newest first, each with its newest deployment, what the worker last reported (`runtime`), the last image clean-up, the settings the running version was deployed with (`running_settings`) and the latest CPU and memory reading (`stats`, `null` when stale).',
    responses: { 200: ok('The apps.', { type: 'array', items: ref('App') }) },
  })),
  route('POST', '/api/apps', op({
    tag: TAG, summary: 'Create an app',
    description: 'Registers an app; nothing is built until you deploy. Leave `host_port` out and the lowest free port in the platform\'s port range (default 20000-20999) is used. If a GitHub App is connected, the API looks up its installation for the repository; a missing installation never blocks creation and only adds a `warning` (public repositories still deploy).',
    body: ref('AppCreate'),
    responses: { 201: ok('Created.', ref('App')) },
    errors: { 400: 'Invalid settings (`details` lists each problem).', 409: 'The name or host port is taken (the message says which), or every port in the range is used (`code: no_free_port`).' },
  })),
  route('GET', '/api/apps/{id}', op({
    tag: TAG, summary: 'Get one app', parameters: [APP_ID],
    description: 'The app as the dashboard shows it, plus `settings_pending`: which edited settings the running version does not have yet.',
    responses: { 200: ok('The app.', ref('App')) }, errors: [404],
  })),
  route('PUT', '/api/apps/{id}', op({
    tag: TAG, summary: 'Edit an app\'s settings', parameters: [APP_ID],
    description: 'Changes the settings you send. **Nothing running is touched:** the next deployment uses the new values (see `settings_pending`); the name and the restart limit apply at once. The repository and the slug cannot be changed (delete the app and create a new one).',
    body: ref('AppUpdate'),
    responses: { 200: ok('The app after the change.', ref('App')) },
    errors: { 400: 'Invalid settings (`details`).', 404: 'No such app.', 409: 'The name or host port belongs to another app (`code: name_taken` or `port_taken`, and `app` names it), or the app is being deleted.' },
  })),
  route('DELETE', '/api/apps/{id}', op({
    tag: TAG, summary: 'Delete an app', parameters: [APP_ID],
    description: 'Deletes the app: its containers, images, logs, variables and every deployment record. The API only marks the app and queues the work; the worker does it (so the answer is 202, and the app disappears when the worker has finished; a failure shows as `delete_error`, and sending the delete again retries). **The exact name must be sent as `confirm`.** Refused while a deployment is queued or running.',
    body: { type: 'object', required: ['confirm'], properties: { confirm: { type: 'string', description: 'The app\'s exact name.' } } },
    responses: { 202: ok('Deletion queued.', { type: 'object', properties: { deleting: { type: 'boolean' } } }) },
    errors: { 400: 'The confirmation does not match (`code: confirm_mismatch`).', 404: 'No such app.', 409: 'A deployment is still running; cancel it first (`code: deployment_active`).', 503: 'The job queue is not available.' },
  })),
  route('GET', '/api/apps/{id}/stats', op({
    tag: TAG, summary: 'CPU and memory history', parameters: [APP_ID, query('minutes', 'How far back, 1 to 60 (default 60).', { type: 'integer', minimum: 1, maximum: 60, default: 60 })],
    description: 'Readings taken by the worker every 15 seconds, oldest first, for a chart, and `latest` (`null` when the app is not running or the worker is quiet).',
    responses: { 200: ok('The readings.', ref('StatsHistory')) }, errors: [400, 404],
  })),
  route('GET', '/api/apps/{id}/crashes', op({
    tag: TAG, summary: 'Why the app was not running', parameters: [APP_ID],
    description: 'The last 20 times the app was not running when it should have been, newest first, with what Shipdok did about each: crash, stopped outside Shipdok, recovered after a host restart, or container removed outside Shipdok.',
    responses: { 200: ok('The events.', { type: 'array', items: ref('CrashEvent') }) }, errors: [404],
  })),
  route('POST', '/api/apps/{id}/start', op({
    tag: TAG, summary: 'Start the app', parameters: [APP_ID],
    description: 'Records that the app should run, then queues the work for the worker (the only part that talks to Docker), so the answer is 202 and the result appears in `runtime`. A manual start also forgives earlier crashes.',
    responses: { 202: ok('Queued.', { type: 'object', properties: { action: { type: 'string' }, desired_state: { type: 'string' } } }) },
    errors: { 404: 'No such app.', 409: DELETING, 503: 'The job queue is not available.' },
  })),
  route('POST', '/api/apps/{id}/stop', op({
    tag: TAG, summary: 'Stop the app', parameters: [APP_ID],
    description: 'Records that the app should be stopped (webhooks skip a stopped app at once), then queues the work. The container, image and configuration are kept. A stopped app stays stopped when deployed unless the deployment asks to start it.',
    responses: { 202: ok('Queued.', { type: 'object', properties: { action: { type: 'string' }, desired_state: { type: 'string' } } }) },
    errors: { 404: 'No such app.', 409: DELETING, 503: 'The job queue is not available.' },
  })),
  route('POST', '/api/apps/{id}/restart', op({
    tag: TAG, summary: 'Restart the app', parameters: [APP_ID],
    description: 'Restarts the running container without rebuilding. Then the worker waits for the health check; a failure is shown as `unhealthy` and the app is left running.',
    responses: { 202: ok('Queued.', { type: 'object', properties: { action: { type: 'string' }, desired_state: { type: 'string' } } }) },
    errors: { 404: 'No such app.', 409: DELETING, 503: 'The job queue is not available.' },
  })),

  // ---- deployments
  route('GET', '/api/apps/{id}/deployments', op({
    tag: DEP, summary: 'Deployment history', parameters: [APP_ID],
    description: 'The app\'s last 50 deployments, newest first.',
    responses: { 200: ok('The deployments.', { type: 'array', items: ref('Deployment') }) }, errors: [404],
  })),
  route('POST', '/api/apps/{id}/deployments', op({
    tag: DEP, summary: 'Deploy now', parameters: [APP_ID],
    description: 'Queues a build and deployment of the branch\'s latest commit. Older queued or running deployments of the app are superseded (the newest wins). Answers 202 at once; follow the deployment with `GET /api/deployments/{id}`. Under 10% free disk the request is refused (409 `disk_critical`) unless the body says `ignoreDiskWarning: true`; under 20% it goes ahead and the answer carries a `warning`.',
    body: ref('DeployRequest'), bodyRequired: false,
    responses: { 202: ok('Queued.', ref('Deployment')) },
    errors: { 400: 'Invalid body.', 404: 'No such app.', 409: 'The app is being deleted, or the disk is almost full (`code: disk_critical`).', 503: 'The job queue is not available.' },
  })),
  route('POST', '/api/apps/{id}/rollback', op({
    tag: DEP, summary: 'Roll back to an earlier version', parameters: [APP_ID],
    description: 'Runs an earlier version\'s existing image again: nothing is cloned or built, so it works offline and needs no disk space. The new deployment (trigger `rollback`) uses the app\'s CURRENT settings and variables; only the image is old. Without `deploymentId` the newest earlier version that still has an image is used.',
    body: ref('RollbackRequest'), bodyRequired: false,
    responses: { 202: ok('Queued.', ref('Deployment')) },
    errors: { 400: 'Invalid body.', 404: 'No such app, or that is not a successful deployment of this app.', 409: 'Nothing deployed yet, no earlier version with an image, the image was removed, that version already runs, or the app is being deleted.', 503: 'The job queue is not available.' },
  })),
  route('GET', '/api/deployments/{id}', op({
    tag: DEP, summary: 'Get one deployment', parameters: [DEPLOYMENT_ID],
    description: 'The deployment and its status. Status is separate from whether the app is running.',
    responses: { 200: ok('The deployment.', ref('Deployment')) }, errors: [404],
  })),
  route('POST', '/api/deployments/{id}/cancel', op({
    tag: DEP, summary: 'Cancel a deployment', parameters: [DEPLOYMENT_ID],
    description: 'A queued deployment ends at once (200). A running one is only asked to stop (202); the worker stops it and the final status appears after clean-up. A deployment already past the swap point finishes.',
    responses: { 200: ok('Cancelled.', ref('Deployment')), 202: ok('Asked to stop.', ref('Deployment')) },
    errors: { 404: 'No such deployment.', 409: 'It has already finished.' },
  })),
  route('DELETE', '/api/deployments/{id}', op({
    tag: DEP, summary: 'Delete a deployment', parameters: [DEPLOYMENT_ID],
    description: 'Deletes the record, its build log and, through the worker, its image if nothing needs it. Permanent. Refused while it runs, while a queued rollback will use it, for the running version, and for a version kept for rollback that nothing else holds.',
    responses: { 200: ok('Deleted.', { type: 'object', properties: { deleted: { type: 'boolean' }, freedLogBytes: { type: 'integer' }, image: { type: 'string', description: '`none`, `queued`, `failed` or `kept (another deployment uses it)`.' } } }) },
    errors: { 404: 'No such deployment.', 409: 'It is running, a rollback is waiting for it, or it is a version that must be kept.', 500: 'The log files could not be deleted; nothing was deleted.' },
  })),

  // ---- images
  route('GET', '/api/apps/{id}/images', op({
    tag: MAINT, summary: 'Versions that have an image', parameters: [APP_ID],
    description: 'Each successful version with its state (live, previous, prunable, removed), the retention settings, the last clean-up, and what a clean-up would free now.',
    responses: { 200: ok('The versions.', ref('Images')) }, errors: [404],
  })),
  route('POST', '/api/apps/{id}/prune', op({
    tag: MAINT, summary: 'Clean up old images now', parameters: [APP_ID],
    description: 'Queues a clean-up: the worker removes this app\'s images that are not the live one, not the retained earlier ones and not in use. Deployment records and logs are never touched.',
    responses: { 202: ok('Queued.', queued('Whether it was queued.')) },
    errors: { 404: 'No such app.', 409: DELETING, 503: 'The job queue is not available.' },
  })),
  route('PUT', '/api/apps/{id}/retention', op({
    tag: MAINT, summary: 'Set how many versions to keep', parameters: [APP_ID],
    description: 'How many earlier versions\' images to keep besides the live one (0 to 10), and whether to clean up automatically after each successful deployment. Send either or both.',
    body: ref('Retention'),
    responses: { 200: ok('The new settings.', { type: 'object', properties: { keep_previous_images: { type: 'integer' }, auto_prune: { type: 'boolean' } } }) },
    errors: { 400: 'Invalid settings.', 404: 'No such app.', 409: DELETING },
  })),
]);
