// What Shipdok does by itself, as entries of the activity log (the same table the API writes what the administrator does to). These are the entries
// the dashboard hides unless "Show automatic events" is on. They say what happened, never a secret: an error is the message the worker already shows.
import { change, fact } from '@shipdok/shared';

const WORKER = { actor: 'Shipdok', address: 'worker' };
const MODE_TEXT = {
  replace: 'Replace (the volumes were emptied first)', add: 'Add over (the files were added, existing ones kept unless the backup has the same file)', empty: 'Only into empty volumes',
};
const yes = (v) => (v ? 'yes' : 'no');

/** The entry for an exit or a change the monitor noticed (`event` is what supervisor.decide() decided: cause, exitCode, oomKilled, action). */
export function crashEntry(app, event) {
  const name = app.name;
  const exit = [
    ...(event.exitCode !== null && event.exitCode !== undefined ? [fact('Exit code', event.exitCode)] : []),
    ...(event.oomKilled ? [fact('Out of memory', 'yes: the app went over its memory limit')] : []),
  ];
  const base = { category: 'apps', source: 'system', appId: app.id, appName: name, ...WORKER };
  if (event.cause === 'crash' && event.action === 'restart_scheduled') {
    return { ...base, action: 'app_crashed', summary: `${name} crashed and will be restarted`, details: [fact('App', name), ...exit, fact('Effect', 'Shipdok restarts it after a short wait that grows with each crash')] };
  }
  if (event.cause === 'crash') {
    return { ...base, action: 'app_gave_up', summary: `${name} crashed too many times: Shipdok stopped restarting it`, details: [fact('App', name), ...exit, fact('Effect', 'it stays down until you start it')] };
  }
  if (event.cause === 'stopped_outside') {
    return { ...base, action: 'app_stopped_outside', summary: `${name} was stopped outside Shipdok`, details: [fact('App', name), ...exit, fact('Effect', 'left stopped, not restarted')] };
  }
  if (event.cause === 'removed_outside') {
    return { ...base, action: 'app_removed_outside', summary: `The container of ${name} was removed outside Shipdok`, details: [fact('App', name), fact('Effect', 'shown as missing; Shipdok does not recreate it')] };
  }
  if (event.cause === 'recovered') {
    return { ...base, action: 'app_recovered', summary: `${name} was started again after a host or Docker restart`, details: [fact('App', name), fact('Effect', 'started again without counting it as a crash')] };
  }
  return { ...base, action: 'app_event', summary: `${name}: ${event.cause}`, details: [fact('App', name), ...exit] };
}

/** The entry for a backup that finished or failed. `request` is the row the runner claimed (trigger, kind, app); `outcome` the result or the error. */
export function backupEntry(request, outcome) {
  const volumes = request.kind === 'volumes';
  const what = volumes ? `${request.app_name ?? 'an app'}'s data` : 'Shipdok';
  const scheduled = request.trigger === 'scheduled';
  const label = scheduled ? 'Scheduled backup' : 'Backup';
  const base = {
    category: 'backups', source: scheduled ? 'schedule' : 'system', appId: volumes ? request.app_id ?? null : null, appName: volumes ? request.app_name ?? null : null, ...WORKER,
  };
  const kind = fact('Backup', volumes ? `the files of the persistent volumes of ${request.app_name ?? 'an app'}` : 'Shipdok itself (database and secrets)');
  if (!outcome.ok) {
    return { ...base, action: 'backup_failed', summary: `${label} of ${what} failed`, details: [kind, fact('Why', outcome.error)] };
  }
  return {
    ...base, action: 'backup_finished', summary: `${label} of ${what} finished`,
    details: [kind, fact('Size', `${outcome.sizeBytes} bytes`), fact('Encrypted', yes(outcome.encrypted)), fact('Read back and checked', yes(outcome.verified)),
      ...(volumes && outcome.volumeCount != null ? [fact('Volumes', outcome.volumeCount)] : []), ...(outcome.warning ? [fact('Warning', outcome.warning)] : [])],
  };
}

/** The entry for a restore that finished or failed. `restore` is the row the runner claimed. */
export function restoreEntry(restore, outcome) {
  const name = restore.app_name ?? 'an app';
  const base = { category: 'backups', source: 'system', appId: restore.app_id ?? null, appName: restore.app_name ?? null, ...WORKER };
  const what = [fact('App', name), fact('Mode', MODE_TEXT[restore.mode] ?? restore.mode), fact('Backup of the current data first', yes(restore.safety_backup)),
    ...(restore.reclaim ? [fact('Reclaim', `from the backup of ${restore.backup_app_name ?? 'a deleted app'}`)] : [])];
  if (!outcome.ok) {
    return { ...base, action: 'restore_failed', summary: `Restore of ${name} failed`, details: [...what, fact('Why', outcome.error)] };
  }
  return {
    ...base, action: 'restore_finished', summary: `Restore of ${name} finished`,
    details: [...what, ...(outcome.volumeCount != null ? [fact('Volumes restored', outcome.volumeCount)] : []), ...(outcome.warning ? [fact('Note', outcome.warning)] : [])],
  };
}

export { change };
