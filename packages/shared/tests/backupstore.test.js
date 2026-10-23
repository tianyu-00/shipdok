import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BACKUP_PASSPHRASE_CONTEXT, backupFilename, backupFilePath, backupRoot, isBackupDue, mostRecentSlot, nextSlot, normalizeSchedule, scheduleProblems, SCHEDULE_DEFAULTS } from '../src/backupstore.js';

const utc = (s) => new Date(s + 'Z');
const daily = (hour = 3) => ({ frequency: 'daily', hour, weekday: 1, keep: 7 });
const weekly = (hour = 3, weekday = 1) => ({ frequency: 'weekly', hour, weekday, keep: 7 });

describe('where backups live and what they are called', () => {
  test('BACKUP_DIR, else a folder in the home directory', () => {
    assert.equal(backupRoot({ BACKUP_DIR: '/var/lib/shipdok/backups' }), '/var/lib/shipdok/backups');
    assert.match(backupRoot({}), /\.shipdok[\\/]backups$/);
  });
  test('a file name has the UTC time and part of the id, and .enc when encrypted', () => {
    assert.equal(backupFilename('2026-10-22T03:04:05Z', '12345678-aaaa-4bbb-8ccc-1234567890ab', false), 'shipdok-backup-20261022-030405-12345678.tar');
    assert.equal(backupFilename('2026-01-02T23:59:59Z', 'ABCDEF01-aaaa-4bbb-8ccc-1234567890ab', true), 'shipdok-backup-20260102-235959-abcdef01.tar.enc');
  });
  test('a volume backup has its own name, never with the app\'s name in it', () => {
    assert.equal(backupFilename('2026-10-22T03:04:05Z', '12345678-aaaa-4bbb-8ccc-1234567890ab', false, 'volumes'), 'shipdok-volumes-20261022-030405-12345678.tar');
    assert.equal(backupFilename('2026-10-22T03:04:05Z', '12345678-aaaa-4bbb-8ccc-1234567890ab', true, 'volumes'), 'shipdok-volumes-20261022-030405-12345678.tar.enc');
    assert.equal(backupFilename('2026-10-22T03:04:05Z', '12345678-aaaa-4bbb-8ccc-1234567890ab', false, 'platform'), 'shipdok-backup-20261022-030405-12345678.tar');
    assert.throws(() => backupFilename('2026-10-22T03:04:05Z', '12345678-aaaa-4bbb-8ccc-1234567890ab', false, '../x'), /backup kind/);
    assert.equal(backupFilePath('/b', 'shipdok-volumes-20261022-030405-12345678.tar.enc'), '/b/shipdok-volumes-20261022-030405-12345678.tar.enc');
    for (const bad of ['shipdok-volumes-my-blog-20261022-030405-12345678.tar', 'shipdok-other-20261022-030405-12345678.tar', 'shipdok-volumes-20261022-030405-12345678.tgz']) assert.equal(backupFilePath('/b', bad), null, bad);
  });
  test('only our own file names become paths, and never anything outside the folder', () => {
    const ok = 'shipdok-backup-20261022-030405-12345678.tar';
    assert.equal(backupFilePath('/b', ok), `/b/${ok}`);
    assert.equal(backupFilePath('/b', `${ok}.enc`), `/b/${ok}.enc`);
    for (const bad of ['../etc/passwd', `../${ok}`, `${ok}/../x`, `/${ok}`, `${ok}x`, 'x.tar', '', null, undefined, 5, `${ok}\n`, 'shipdok-backup-20261022-030405-1234567.tar', 'shipdok-backup-20261022-030405-1234567G.tar']) {
      assert.equal(backupFilePath('/b', bad), null, String(bad));
    }
  });
});

test('the passphrase is bound to its purpose (the API and the worker use the same word)', () => assert.equal(BACKUP_PASSPHRASE_CONTEXT, 'backup:passphrase'));

describe('a schedule', () => {
  test('is complete with its defaults: daily at 03:00 UTC, keeping 7', () => {
    assert.deepEqual(SCHEDULE_DEFAULTS, { frequency: 'daily', hour: 3, weekday: 1, keep: 7 });
    assert.deepEqual(normalizeSchedule(undefined), SCHEDULE_DEFAULTS);
    assert.deepEqual(normalizeSchedule({ frequency: 'weekly', keep: 14 }), { frequency: 'weekly', hour: 3, weekday: 1, keep: 14 });
    assert.deepEqual(normalizeSchedule({ frequency: 'hourly', hour: 99, weekday: -1, keep: 0 }), SCHEDULE_DEFAULTS);
  });
  test('is checked: frequency, hour 0-23, weekday 0-6 and keep 1-60', () => {
    assert.deepEqual(scheduleProblems(daily()), {});
    assert.deepEqual(Object.keys(scheduleProblems({ frequency: 'hourly', hour: 24, weekday: 7, keep: 61 })).sort(), ['frequency', 'hour', 'keep', 'weekday']);
    for (const bad of [{ keep: 0 }, { keep: 61 }, { keep: 1.5 }, { hour: -1 }, { hour: '3' }, { weekday: 7 }, { frequency: 'off ' }]) assert.ok(Object.keys(scheduleProblems({ ...daily(), ...bad })).length, JSON.stringify(bad));
    for (const ok of [{ keep: 1 }, { keep: 60 }, { hour: 0 }, { hour: 23 }, { weekday: 0 }, { weekday: 6 }, { frequency: 'off' }]) assert.deepEqual(scheduleProblems({ ...daily(), ...ok }), {}, JSON.stringify(ok));
    assert.ok(scheduleProblems(null).schedule);
  });
});

describe('the slots', () => {
  test('off has none', () => {
    assert.equal(mostRecentSlot({ ...daily(), frequency: 'off' }, Date.now()), null);
    assert.equal(nextSlot({ ...daily(), frequency: 'off' }, Date.now()), null);
  });
  test('daily: after the hour it is today, before it yesterday, and exactly at it that moment', () => {
    assert.equal(mostRecentSlot(daily(3), utc('2026-10-22T10:00:00')).toISOString(), '2026-10-22T03:00:00.000Z');
    assert.equal(mostRecentSlot(daily(3), utc('2026-10-22T02:59:59')).toISOString(), '2026-10-21T03:00:00.000Z');
    assert.equal(mostRecentSlot(daily(3), utc('2026-10-22T03:00:00')).toISOString(), '2026-10-22T03:00:00.000Z');
  });
  test('daily across a month and a year end', () => {
    assert.equal(mostRecentSlot(daily(3), utc('2026-11-01T01:00:00')).toISOString(), '2026-10-31T03:00:00.000Z');
    assert.equal(mostRecentSlot(daily(0), utc('2027-01-01T00:00:00')).toISOString(), '2027-01-01T00:00:00.000Z');
    assert.equal(mostRecentSlot(daily(23), utc('2027-01-01T05:00:00')).toISOString(), '2026-12-31T23:00:00.000Z');
  });
  test('weekly: the latest chosen weekday at the hour (2026-10-22 is a Thursday)', () => {
    assert.equal(mostRecentSlot(weekly(3, 1), utc('2026-10-22T10:00:00')).toISOString(), '2026-10-19T03:00:00.000Z'); // Monday
    assert.equal(mostRecentSlot(weekly(3, 4), utc('2026-10-22T10:00:00')).toISOString(), '2026-10-22T03:00:00.000Z'); // today
    assert.equal(mostRecentSlot(weekly(3, 4), utc('2026-10-22T02:00:00')).toISOString(), '2026-10-15T03:00:00.000Z'); // today's slot is still to come
    assert.equal(mostRecentSlot(weekly(3, 0), utc('2026-10-22T10:00:00')).toISOString(), '2026-10-18T03:00:00.000Z'); // Sunday
    assert.equal(mostRecentSlot(weekly(3, 6), utc('2026-10-22T10:00:00')).toISOString(), '2026-10-17T03:00:00.000Z'); // Saturday
  });
  test('the next slot is a day or a week after the latest', () => {
    assert.equal(nextSlot(daily(3), utc('2026-10-22T10:00:00')).toISOString(), '2026-10-23T03:00:00.000Z');
    assert.equal(nextSlot(weekly(3, 1), utc('2026-10-22T10:00:00')).toISOString(), '2026-10-26T03:00:00.000Z');
    assert.equal(nextSlot(daily(3), utc('2026-10-22T02:00:00')).toISOString(), '2026-10-22T03:00:00.000Z');
  });
});

describe('when a backup is due', () => {
  const now = utc('2026-10-22T10:00:00');
  test('when the latest slot has passed and nothing was backed up since', () => assert.equal(isBackupDue({ schedule: daily(3), now, lastStartedAt: utc('2026-10-21T03:00:05') }), true));
  test('never when it is off', () => assert.equal(isBackupDue({ schedule: { ...daily(), frequency: 'off' }, now }), false));
  test('not when one was started since the slot (a manual one counts)', () => {
    assert.equal(isBackupDue({ schedule: daily(3), now, lastStartedAt: utc('2026-10-22T03:00:01') }), false);
    assert.equal(isBackupDue({ schedule: daily(3), now, lastStartedAt: utc('2026-10-22T09:00:00') }), false);
    assert.equal(isBackupDue({ schedule: daily(3), now, lastStartedAt: utc('2026-10-22T03:00:00') }), false, 'exactly at the slot counts');
  });
  test('the first time ever it is due once the slot has passed', () => assert.equal(isBackupDue({ schedule: daily(3), now }), true));
  test('not for a slot that passed before the schedule was changed (switching it on does not back up at once)', () => {
    assert.equal(isBackupDue({ schedule: daily(3), now, changedAt: utc('2026-10-22T08:00:00') }), false);
    assert.equal(isBackupDue({ schedule: daily(3), now, changedAt: utc('2026-10-22T02:00:00') }), true);
    assert.equal(isBackupDue({ schedule: daily(3), now: utc('2026-10-23T03:00:00'), changedAt: utc('2026-10-22T08:00:00') }), true, 'the next slot is due');
  });
  test('after a long stop it is due once, not once per missed day', () => {
    assert.equal(isBackupDue({ schedule: daily(3), now: utc('2026-11-20T10:00:00'), lastStartedAt: utc('2026-10-22T03:00:00') }), true);
    assert.equal(isBackupDue({ schedule: daily(3), now: utc('2026-11-20T10:00:00'), lastStartedAt: utc('2026-11-20T10:00:00') }), false);
  });
  test('weekly waits for its day', () => {
    assert.equal(isBackupDue({ schedule: weekly(3, 1), now, lastStartedAt: utc('2026-10-19T03:00:30') }), false); // done on Monday
    assert.equal(isBackupDue({ schedule: weekly(3, 1), now, lastStartedAt: utc('2026-10-12T03:00:30') }), true);
  });
});
