// Answers requests for a backup and makes the scheduled ones. It runs beside the deployment queue, not in it: a backup must not wait behind a
// build that takes ten minutes, and it never holds a deployment up either (it only reads the database).
//
// Every few seconds: is a backup waiting (the dashboard asked, or the schedule asked a moment ago)? Once a minute: does the schedule say one is due?
// If so, record a request: the same path as a click on "Back up now". The database allows ONE waiting or running backup, so a double request is dropped.
import { isBackupDue, normalizeSchedule, backupRoot, backupFilePath, decryptSecret, LABEL, restorePassphraseContext, backupPassphraseProblem, BACKUP_PASSPHRASE_CONTEXT } from '@shipdok/shared';
import * as realEngine from './docker.js';
import * as store from './db.js';
import { makeBackup, removeBackupFiles } from './backup.js';
import { makeVolumeBackup } from './volumebackup.js';
import { backupFileExists, makeRestore } from './volumerestore.js';
import { controlApp } from './control.js';
import { backupEntry, restoreEntry } from './audit.js';

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
  return withAppStopped(app, { db, eng, activity, log, forWhat: 'the copy' }, copy);
}

/**
 * Stops the app and says when to start it again: `release()` starts it (unless the administrator wanted it stopped, checked then) and returns a note
 * when that failed. Nothing is stopped while a deployment or another job is working on the app; the monitor leaves the app alone until `release`.
 */
async function stopApp(app, { db, eng, activity, log, forWhat }) {
  if (activity?.isBusy(app.id)) throw new Error(`A deployment or another job is working on this app right now, so it was not stopped for ${forWhat}. Try again in a few minutes`);
  const end = activity?.begin(app.id) ?? (() => {});
  try {
    const stopped = await controlApp({ appId: app.id, action: 'stop' }, { eng, db, log });
    if (!stopped.ok) throw new Error(`The app could not be stopped for ${forWhat}: ${stopped.error}`);
  } catch (err) { end(); throw err; }
  return {
    async release() {
      try {
        const wanted = await db.getDesiredState(app.id);
        const started = wanted === 'running' ? await controlApp({ appId: app.id, action: 'start' }, { eng, db, log }) : { ok: true };
        return started.ok ? null : `The app could not be started again after ${forWhat}: ${started.error}`;
      } finally { end(); }
    },
  };
}

/** Stops the app, runs `fn(true)`, starts it again whatever the outcome. A start that fails is a warning on the result, or added to the error. */
async function withAppStopped(app, ctx, fn) {
  const held = await stopApp(app, ctx);
  let result; let failure = null;
  try { result = await fn(true); } catch (err) { failure = err; }
  const restartNote = await held.release();
  if (failure) { if (restartNote) failure.message = `${failure.message}. ${restartNote}`; throw failure; }
  return restartNote ? { ...result, warning: restartNote } : result;
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
    await db.recordAutomatic?.(backupEntry(request, { ok: true, ...result }));
    log(`Backup ${request.id} finished`);
    await prune({ db, dir, log });
    return { ok: true, ...result };
  } catch (err) {
    log(`Backup ${request.id} failed: ${err.message}`);
    await db.markBackupFailed(request.id, err.message).catch(() => {});
    await db.recordAutomatic?.(backupEntry(request, { ok: false, error: err.message }));
    await prune({ db, dir, log }).catch(() => {});
    return { ok: false, error: err.message };
  }
}

/** The restore that was asked for: checks, the optional safety backup, the files. Records how it went and never throws. */
export async function answerRestore(restore, { db = store, eng = realEngine, secretsKey, dir = backupRoot(), version = null, log = console.log, now = () => new Date(), activity = null } = {}) {
  let safetyId = null;
  try {
    const backup = restore.backup_id ? await db.getBackupForRestore(restore.backup_id) : null;
    if (!backup) throw new Error('That backup no longer exists');
    const file = backup.status === 'ok' && backup.kind === 'volumes' ? backupFilePath(dir, backup.filename) : null;
    if (!file || !(await backupFileExists(file))) throw new Error('The file of that backup is gone from the backups folder');
    const app = restore.app_id ? await db.getVolumeBackupApp(restore.app_id) : null;
    if (!app) throw new Error('The app no longer exists');
    if (app.deleting_at) throw new Error('The app is being deleted');

    // The passphrase that opens THIS file: the one given with the request, else the current one (a plain backup needs none)
    let openWith = null;
    if (backup.encrypted) {
      openWith = restore.passphrase_enc
        ? (() => { try { return decryptSecret(restore.passphrase_enc, secretsKey, restorePassphraseContext(restore.id)); } catch { throw new Error('The passphrase given with the request could not be read'); } })()
        : await loadPassphrase({ db, secretsKey }).catch(() => { throw new Error('The backup passphrase could not be read: give the passphrase of that backup'); });
      if (!openWith) throw new Error('That backup is encrypted, but no passphrase is set: give the passphrase of that backup');
    }
    const volumes = await db.listMountedVolumes(app.id);
    if (volumes.length === 0 && !restore.reclaim) throw new Error('The app has no persistent storage any more');
    // A reclaim may add storage paths to the app: new volumes in the database and in Docker (labelled as Shipdok's own, owned by this app)
    const provision = restore.reclaim ? async (planned) => {
      await db.addAppVolumes(app.id, planned);
      for (const v of planned) await eng.ensureVolume({ name: v.docker_name, labels: { [LABEL.managed]: 'true', [LABEL.app]: app.id } });
    } : null;

    // The app is stopped only when every check has passed (inside makeRestore's beforeWrite) and started again at the end, whatever happened.
    let held = null;
    let result; let failure = null;
    try {
      result = await makeRestore({
        file, passphrase: openWith, mode: restore.mode, volumes, app, dir, eng, log, provision,
        beforeWrite: async ({ touchesExisting }) => {
          if (!touchesExisting) return; // only new, empty volumes (not mounted by the running app) are written: nothing to stop, nothing to protect
          if (STOPPABLE.includes(app.runtime_state)) held = await stopApp(app, { db, eng, activity, log, forWhat: 'the restore' });
          if (!restore.safety_backup) return;
          log('Making a backup of the current data first');
          safetyId = await db.startSafetyBackup(app.id, app.name);
          if (!safetyId) throw new Error('A backup of this app is already being made, so the safety backup could not be started. Nothing was restored');
          await db.setRestoreSafety(restore.id, safetyId);
          try {
            const current = await loadPassphrase({ db, secretsKey });
            const made = await makeVolumeBackup({ id: safetyId, trigger: 'before_restore', dir, app, volumes, passphrase: current, version, stopped: held !== null, eng, now: now(), log });
            await db.markBackupOk(safetyId, made);
          } catch (err) {
            await db.markBackupFailed(safetyId, err.message).catch(() => {});
            throw new Error(`The backup of the current data failed, so nothing was restored: ${err.message}`);
          }
        },
      });
    } catch (err) { failure = err; }
    const restartNote = held ? await held.release() : null;
    if (failure) { if (restartNote) failure.message = `${failure.message}. ${restartNote}`; throw failure; }
    const added = result.addedPaths ?? [];
    const addedNote = added.length ? `Added the storage path${added.length === 1 ? '' : 's'} ${added.join(', ')} to the app: deploy it to mount ${added.length === 1 ? 'it' : 'them'}` : null;
    const warning = [addedNote, restartNote].filter(Boolean).join('. ');
    if (warning) result = { ...result, warning };
    await db.markRestoreOk(restore.id, { volumeCount: result.volumeCount, warning: result.warning ?? null });
    await db.recordAutomatic?.(restoreEntry(restore, { ok: true, volumeCount: result.volumeCount, warning: result.warning ?? null }));
    log(`Restore ${restore.id} finished`);
    return { ok: true, ...result };
  } catch (err) {
    const message = err.partial
      ? `${err.message}. The files of the app may be only partly restored${safetyId ? ': the backup made just before is in the list' : ''}`
      : err.message;
    log(`Restore ${restore.id} failed: ${message}`);
    await db.markRestoreFailed(restore.id, message).catch(() => {});
    await db.recordAutomatic?.(restoreEntry(restore, { ok: false, error: message }));
    return { ok: false, error: message };
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

/** Asks for the scheduled backups of the apps' volumes that are due (each app has its own schedule). Returns how many were asked for. */
export async function requestVolumeBackupsIfDue({ db = store, now = Date.now(), log = console.log } = {}) {
  let asked = 0;
  for (const app of await db.appsForVolumeSchedule()) {
    const schedule = normalizeSchedule({ frequency: app.frequency, hour: app.hour, weekday: app.weekday });
    if (!isBackupDue({ schedule, now, lastStartedAt: app.last_at, changedAt: app.changed_at })) continue;
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
  const interruptedRestores = await db.interruptRunningRestores().catch((err) => { log(`restores: ${err.message}`); return []; });
  const interrupted = [...(await db.interruptRunningBackups().catch((err) => { log(`backups: ${err.message}`); return []; })), ...interruptedRestores];
  await eng.removeStaleHelpers?.().catch((err) => log(`backups: ${err.message}`));
  for (const { app_id: appId } of interrupted) {
    if (!appId) continue; // (only a volume backup has an app)
    const app = await db.getVolumeBackupApp(appId).catch(() => null);
    if (app && (app.volume_backup_stop || interruptedRestores.some((r) => r.app_id === appId)) && app.desired_state === 'running' && app.runtime_state === 'stopped') {
      log(`Starting ${app.slug} again: its backup or restore was interrupted while it was stopped`);
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
    if (request) {
      await answerBackup(request, { db, eng, secretsKey, dir, secretsDir, version, log, activity });
      return true;
    }
    const restore = await db.claimQueuedRestore();
    if (!restore) return false;
    await answerRestore(restore, { db, eng, secretsKey, dir, version, log, activity });
    await db.pruneRestores?.().catch((err) => log(`restore history: ${err.message}`)); // the history keeps the number each app chose
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
