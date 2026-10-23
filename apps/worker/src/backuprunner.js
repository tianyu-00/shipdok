// Answers requests for a backup and makes the scheduled ones. It runs beside the deployment queue, not in it: a backup must not wait behind a
// build that takes ten minutes, and it never holds a deployment up either (it only reads the database).
//
// Every few seconds: is a backup waiting (the dashboard asked, or the schedule asked a moment ago)? Once a minute: does the schedule say one is due?
// If so, record a request: the same path as a click on "Back up now". The database allows ONE waiting or running backup, so a double request is dropped.
import { isBackupDue, normalizeSchedule, backupRoot, decryptSecret, backupPassphraseProblem, BACKUP_PASSPHRASE_CONTEXT } from '@shipdok/shared';
import * as realEngine from './docker.js';
import * as store from './db.js';
import { makeBackup, removeBackupFiles } from './backup.js';
import { makeVolumeBackup } from './volumebackup.js';
import { controlApp } from './control.js';

export const PASSPHRASE_CONTEXT = BACKUP_PASSPHRASE_CONTEXT;

/** The passphrase the backups are encrypted with, or null when none is set. Throws when one is set and cannot be read: never a plain backup by surprise. */
export async function loadPassphrase({ db = store, secretsKey }) {
  const row = await db.getSettingRow('backup_passphrase');
  if (!row || row.value == null) return null;
  const phrase = decryptSecret(row.value, secretsKey, PASSPHRASE_CONTEXT);
  if (backupPassphraseProblem(phrase)) throw new Error('The stored backup passphrase is not usable');
  return phrase;
}

const STOPPABLE = ['running', 'unhealthy']; // an app in one of these has a container that runs

/**
 * The volumes of one app. With the app's "stop briefly" switch on and its container running, it is stopped for the copy and started again after
 * (whatever the copy's outcome), as a control job would do it; an app that is already stopped is copied as it is and left stopped. While it is
 * stopped, the monitor leaves it alone (`activity`). If a deployment or another job is working on the app right now, nothing is stopped: the backup fails and says so.
 */
async function volumesBackup(request, { db, eng, passphrase, dir, version, log, now, activity }) {
  const app = request.app_id ? await db.getVolumeBackupApp(request.app_id) : null;
  if (!app) throw new Error('The app no longer exists, so its volumes cannot be backed up');
  if (app.deleting_at) throw new Error('The app is being deleted');
  const volumes = await db.listMountedVolumes(app.id);
  const copy = (stopped) => makeVolumeBackup({ id: request.id, trigger: request.trigger, dir, app, volumes, passphrase, version, stopped, eng, now: now(), log });
  if (!app.volume_backup_stop || !STOPPABLE.includes(app.runtime_state)) return copy(false);

  if (activity?.isBusy(app.id)) throw new Error('A deployment or another job is working on this app right now, so it was not stopped for the copy. Try again in a few minutes');
  const run = (fn) => (activity ? activity.run(app.id, fn) : fn());
  return run(async () => {
    const stopped = await controlApp({ appId: app.id, action: 'stop' }, { eng, db, log });
    if (!stopped.ok) throw new Error(`The app could not be stopped for the copy: ${stopped.error}`);
    let result; let failure = null;
    try { result = await copy(true); } catch (err) { failure = err; }
    // Started again unless the administrator wanted it stopped (checked now, in case they changed it meanwhile)
    const wanted = await db.getDesiredState(app.id);
    const started = wanted === 'running' ? await controlApp({ appId: app.id, action: 'start' }, { eng, db, log }) : { ok: true };
    const restartNote = started.ok ? null : `The app could not be started again after the copy: ${started.error}`;
    if (failure) throw new Error(restartNote ? `${failure.message}. ${restartNote}` : failure.message);
    return restartNote ? { ...result, warning: restartNote } : result;
  });
}

/** Makes the backup that was asked for, records how it went, and removes the old ones. Never throws. */
export async function answerBackup(request, { db = store, eng = realEngine, secretsKey, dir = backupRoot(), secretsDir = process.env.SECRETS_DIR || '/run/shipdok-secrets', version = null, log = console.log, now = () => new Date(), activity = null } = {}) {
  try {
    const passphrase = await loadPassphrase({ db, secretsKey }).catch(() => { throw new Error('The backup passphrase could not be read, so no backup was made (set it again on the Storage page)'); });
    const result = request.kind === 'volumes'
      ? await volumesBackup(request, { db, eng, passphrase, dir, version, log, now, activity })
      : await makeBackup({
        id: request.id, trigger: request.trigger, dir, secretsDir, passphrase, version, eng, now: now(), log,
        lastMigration: async () => (await db.lastMigrationName?.()) ?? null,
      });
    await db.markBackupOk(request.id, result);
    log(`Backup ${request.id} finished`);
    await prune({ db, dir, log });
    return { ok: true, ...result };
  } catch (err) {
    log(`Backup ${request.id} failed: ${err.message}`);
    await db.markBackupFailed(request.id, err.message).catch(() => {});
    await prune({ db, dir, log }).catch(() => {});
    return { ok: false, error: err.message };
  }
}

/** Removes the backups beyond the number to keep (set on the Storage page), files first, then their rows. */
export async function prune({ db = store, dir = backupRoot(), log = console.log } = {}) {
  const { keep } = normalizeSchedule((await db.getSettingRow('backup_schedule'))?.value);
  const old = await db.backupsToPrune({ keep });
  if (old.length === 0) return 0;
  await removeBackupFiles(dir, old.map((b) => b.filename).filter(Boolean));
  await db.deleteBackupRows(old.map((b) => b.id));
  log(`Removed ${old.length} old backup${old.length === 1 ? '' : 's'}`);
  return old.length;
}

/** Asks for the scheduled backups of the apps' volumes that are due (the same schedule as Shipdok's own). Returns how many were asked for. */
export async function requestVolumeBackupsIfDue({ db = store, now = Date.now(), log = console.log } = {}) {
  const row = await db.getSettingRow('backup_schedule');
  const schedule = normalizeSchedule(row?.value);
  let asked = 0;
  for (const app of await db.appsForVolumeSchedule()) {
    const changed = [row?.updated_at, app.changed_at].filter(Boolean).map((t) => new Date(t).getTime());
    const changedAt = changed.length ? new Date(Math.max(...changed)) : null;
    if (!isBackupDue({ schedule, now, lastStartedAt: app.last_at, changedAt })) continue;
    if (await db.requestVolumeBackup(app.id, 'scheduled')) { asked += 1; log(`A scheduled backup of the volumes of app ${app.id} is due`); }
  }
  return asked;
}

/** Asks for a scheduled backup if one is due. Returns whether one was asked for. */
export async function requestIfDue({ db = store, now = Date.now(), log = console.log } = {}) {
  const row = await db.getSettingRow('backup_schedule');
  const schedule = normalizeSchedule(row?.value);
  if (!isBackupDue({ schedule, now, lastStartedAt: await db.lastBackupAt(), changedAt: row?.updated_at ?? null })) return false;
  const id = await db.requestBackup('scheduled');
  if (id) log('A scheduled backup is due');
  return id !== null;
}

/** At start: a backup that was running can never finish, the helper containers it left are removed, and an app it had stopped is started again. */
export async function recoverAfterStop({ db = store, eng = realEngine, log = console.log } = {}) {
  const interrupted = await db.interruptRunningBackups().catch((err) => { log(`backups: ${err.message}`); return []; });
  await eng.removeStaleHelpers?.().catch((err) => log(`backups: ${err.message}`));
  for (const { app_id: appId } of interrupted) {
    if (!appId) continue; // (only a volume backup has an app)
    const app = await db.getVolumeBackupApp(appId).catch(() => null);
    if (app?.volume_backup_stop && app.desired_state === 'running' && app.runtime_state === 'stopped') {
      log(`Starting ${app.slug} again: its backup was interrupted while it was stopped`);
      await controlApp({ appId, action: 'start' }, { eng, db, log }).catch((err) => log(`backups: ${err.message}`));
    }
  }
}

export function createBackupRunner({ db = store, eng = realEngine, secretsKey, dir, secretsDir, version, activity = null, intervalMs = 3000, scheduleEveryMs = 60_000, log = console.log } = {}) {
  let timer = null;
  let running = null;
  let stopping = false;
  let wake = null;
  let lastScheduleCheck = 0;
  const wait = (t) => new Promise((resolve) => { wake = resolve; timer = setTimeout(resolve, t); });
  const tick = async () => {
    if (Date.now() - lastScheduleCheck >= scheduleEveryMs) {
      lastScheduleCheck = Date.now();
      await requestIfDue({ db, log }).catch((err) => log(`backup schedule: ${err.message}`));
      await requestVolumeBackupsIfDue({ db, log }).catch((err) => log(`volume backup schedule: ${err.message}`));
    }
    const request = await db.claimQueuedBackup();
    if (!request) return false;
    await answerBackup(request, { db, eng, secretsKey, dir, secretsDir, version, log, activity });
    return true;
  };
  return {
    tick,
    start() {
      if (running) return;
      stopping = false;
      running = (async () => {
        await recoverAfterStop({ db, eng, log });
        while (!stopping) {
          try { await tick(); } catch (err) { log(`backups: ${err.message}`); }
          if (!stopping) await wait(intervalMs);
        }
      })();
    },
    async stop() {
      stopping = true;
      clearTimeout(timer);
      wake?.();
      await running;
      running = null;
    },
  };
}
