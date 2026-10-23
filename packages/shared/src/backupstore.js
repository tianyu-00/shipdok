// Backups of Shipdok itself: where the files live, what a file is called, and when the schedule says the next one is due.
// Used by the API (lists, downloads, deletes, the settings) and by the worker (makes them, and notices when one is due).
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where backup files are kept: BACKUP_DIR (compose sets it to the `shipdok_backups` volume), else ~/.shipdok/backups. */
export const backupRoot = (env = process.env) => env.BACKUP_DIR || join(homedir(), '.shipdok', 'backups');

// shipdok-backup-<UTC date>-<UTC time>-<first 8 characters of the id>.tar, plus .enc when it is encrypted; shipdok-volumes-... for the volumes of an app
// (the app's name is never part of a file name: it is user text, and it is in the row)
export const BACKUP_KINDS = ['platform', 'volumes'];
export const BACKUP_FILE_RE = /^shipdok-(backup|volumes)-\d{8}-\d{6}-[0-9a-f]{8}\.tar(\.enc)?$/;

const pad = (n, width = 2) => String(n).padStart(width, '0');

export function backupFilename(date, id, encrypted, kind = 'platform') {
  if (!BACKUP_KINDS.includes(kind)) throw new Error('Not a backup kind');
  const d = new Date(date);
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const short = String(id).replace(/-/g, '').slice(0, 8).toLowerCase();
  const name = `shipdok-${kind === 'volumes' ? 'volumes' : 'backup'}-${stamp}-${short}.tar${encrypted ? '.enc' : ''}`;
  if (!BACKUP_FILE_RE.test(name)) throw new Error('Not a usable backup file name');
  return name;
}

/** The path of a backup file inside `root`, or null when the name is not one of ours (never a path from outside the folder). */
export const backupFilePath = (root, filename) => (typeof filename === 'string' && BACKUP_FILE_RE.test(filename) ? join(root, filename) : null);

// What the stored passphrase is bound to (API writes it, worker reads it): a value stored for something else does not open as the passphrase.
export const BACKUP_PASSPHRASE_CONTEXT = 'backup:passphrase';

export const SCHEDULE_FREQUENCIES = ['off', 'daily', 'weekly'];
export const SCHEDULE_DEFAULTS = Object.freeze({ frequency: 'daily', hour: 3, weekday: 1, keep: 7 });
export const KEEP_MIN = 1;
export const KEEP_MAX = 60;

const whole = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

/** Messages for everything wrong in a schedule (`{}` = fine). Times are UTC: hour 0-23, weekday 0 (Sunday) to 6. */
export function scheduleProblems(s) {
  const p = {};
  if (!s || typeof s !== 'object') return { schedule: 'Give the schedule' };
  if (!SCHEDULE_FREQUENCIES.includes(s.frequency)) p.frequency = 'Off, daily or weekly';
  if (!whole(s.hour, 0, 23)) p.hour = 'A whole number of hours from 0 to 23';
  if (!whole(s.weekday, 0, 6)) p.weekday = 'A day from 0 (Sunday) to 6 (Saturday)';
  if (!whole(s.keep, KEEP_MIN, KEEP_MAX)) p.keep = `A whole number from ${KEEP_MIN} to ${KEEP_MAX}`;
  return p;
}

/** The stored schedule (or none) as a complete one: anything missing or unusable is the default. */
export function normalizeSchedule(stored) {
  const s = stored && typeof stored === 'object' ? stored : {};
  return {
    frequency: SCHEDULE_FREQUENCIES.includes(s.frequency) ? s.frequency : SCHEDULE_DEFAULTS.frequency,
    hour: whole(s.hour, 0, 23) ? s.hour : SCHEDULE_DEFAULTS.hour,
    weekday: whole(s.weekday, 0, 6) ? s.weekday : SCHEDULE_DEFAULTS.weekday,
    keep: whole(s.keep, KEEP_MIN, KEEP_MAX) ? s.keep : SCHEDULE_DEFAULTS.keep,
  };
}

const DAY = 24 * 60 * 60 * 1000;
const slotOnDay = (now, hour, daysBack = 0) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysBack, hour);

/** The latest moment, at or before `now`, at which the schedule wanted a backup; null when it is off. */
export function mostRecentSlot(schedule, nowValue = Date.now()) {
  if (schedule.frequency === 'off') return null;
  const now = new Date(nowValue);
  let t = slotOnDay(now, schedule.hour);
  if (t > now.getTime()) t -= DAY;
  if (schedule.frequency === 'weekly') {
    const back = (new Date(t).getUTCDay() - schedule.weekday + 7) % 7;
    t -= back * DAY;
  }
  return new Date(t);
}

/** The first moment after `now` at which the schedule wants a backup; null when it is off. */
export function nextSlot(schedule, nowValue = Date.now()) {
  const last = mostRecentSlot(schedule, nowValue);
  if (!last) return null;
  const next = new Date(last.getTime() + (schedule.frequency === 'weekly' ? 7 * DAY : DAY));
  return next;
}

/**
 * Is a scheduled backup due? Only when the latest slot has passed since the last backup was STARTED (any backup counts, so a manual one
 * just before the slot is enough) and since the schedule was last changed (switching it on does not back up at once for a slot that
 * passed earlier today). After the machine was off, ONE backup is made, not one per missed slot.
 */
export function isBackupDue({ schedule, now = Date.now(), lastStartedAt = null, changedAt = null }) {
  const slot = mostRecentSlot(schedule, now);
  if (!slot) return false;
  if (lastStartedAt && new Date(lastStartedAt).getTime() >= slot.getTime()) return false;
  if (changedAt && new Date(changedAt).getTime() >= slot.getTime()) return false;
  return true;
}
