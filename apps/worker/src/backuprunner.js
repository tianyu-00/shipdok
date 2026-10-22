// Answers requests for a backup and makes the scheduled ones. It runs beside the deployment queue, not in it: a backup must not wait behind a
// build that takes ten minutes, and it never holds a deployment up either (it only reads the database).
//
// Every few seconds: is a backup waiting (the dashboard asked, or the schedule asked a moment ago)? Once a minute: does the schedule say one is due?
// If so, record a request: the same path as a click on "Back up now". The database allows ONE waiting or running backup, so a double request is dropped.
import { isBackupDue, normalizeSchedule, backupRoot, decryptSecret, backupPassphraseProblem, BACKUP_PASSPHRASE_CONTEXT } from '@shipdok/shared';
import * as realEngine from './docker.js';
import * as store from './db.js';
import { makeBackup, removeBackupFiles } from './backup.js';

export const PASSPHRASE_CONTEXT = BACKUP_PASSPHRASE_CONTEXT;

/** The passphrase the backups are encrypted with, or null when none is set. Throws when one is set and cannot be read: never a plain backup by surprise. */
export async function loadPassphrase({ db = store, secretsKey }) {
  const row = await db.getSettingRow('backup_passphrase');
  if (!row || row.value == null) return null;
  const phrase = decryptSecret(row.value, secretsKey, PASSPHRASE_CONTEXT);
  if (backupPassphraseProblem(phrase)) throw new Error('The stored backup passphrase is not usable');
  return phrase;
}

/** Makes the backup that was asked for, records how it went, and removes the old ones. Never throws. */
export async function answerBackup(request, { db = store, eng = realEngine, secretsKey, dir = backupRoot(), secretsDir = process.env.SECRETS_DIR || '/run/shipdok-secrets', version = null, log = console.log, now = () => new Date() } = {}) {
  try {
    const passphrase = await loadPassphrase({ db, secretsKey }).catch(() => { throw new Error('The backup passphrase could not be read, so no backup was made (set it again on the Storage page)'); });
    const result = await makeBackup({
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

/** Asks for a scheduled backup if one is due. Returns whether one was asked for. */
export async function requestIfDue({ db = store, now = Date.now(), log = console.log } = {}) {
  const row = await db.getSettingRow('backup_schedule');
  const schedule = normalizeSchedule(row?.value);
  if (!isBackupDue({ schedule, now, lastStartedAt: await db.lastBackupAt(), changedAt: row?.updated_at ?? null })) return false;
  const id = await db.requestBackup('scheduled');
  if (id) log('A scheduled backup is due');
  return id !== null;
}

export function createBackupRunner({ db = store, eng = realEngine, secretsKey, dir, secretsDir, version, intervalMs = 3000, scheduleEveryMs = 60_000, log = console.log } = {}) {
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
    }
    const request = await db.claimQueuedBackup();
    if (!request) return false;
    await answerBackup(request, { db, eng, secretsKey, dir, secretsDir, version, log });
    return true;
  };
  return {
    tick,
    start() {
      if (running) return;
      stopping = false;
      running = (async () => {
        await db.interruptRunningBackups().catch((err) => log(`backups: ${err.message}`));
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
