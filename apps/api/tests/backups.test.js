// Backups of Shipdok itself: asking for one, the list, the schedule, the passphrase, the download and the delete.
import request from 'supertest';
import { jest } from '@jest/globals';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptSecret, loadSecretsKeyForTests } from './helpers-backups.js';
import { inOwnVolume } from '../src/routes/backups.js';
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from './helpers.js';

const FILE = 'shipdok-backup-20261022-030405-12345678.tar';
const CONTENT = Buffer.from('pretend backup bytes \u0000\u0001\u0002 with binary');
let dir;
let agent;
let app;

beforeEach(async () => {
  await resetDb();
  await testPool.query('TRUNCATE backups');
  dir = mkdtempSync(join(tmpdir(), 'bk-api-'));
  app = await makeApp({ queue: { add: jest.fn(), remove: jest.fn() }, backupDir: dir });
  agent = request.agent(app);
  await agent.post('/api/auth/setup').send({ username: 'admin', password: PASSWORD });
});
afterAll(closeDb);

const insert = async ({ status = 'ok', filename = FILE, size = CONTENT.length, trigger = 'manual', at = null, encrypted = false, extra = {} } = {}) => {
  const { rows } = await testPool.query(
    `INSERT INTO backups (status, trigger, filename, size_bytes, encrypted, verified, version, requested_at, finished_at, error, warning)
     VALUES ($1, $2, $3, $4, $5, $6, '0.1.17', COALESCE($7::timestamptz, now()), now(), $8, $9) RETURNING id`,
    [status, trigger, status === 'ok' ? filename : null, status === 'ok' ? size : null, encrypted, status === 'ok', at, extra.error ?? null, extra.warning ?? null]);
  return rows[0].id;
};
const overview = async () => (await agent.get('/api/backups')).body;
const attempts = async (kind) => (await testPool.query('SELECT username, success FROM login_attempts WHERE kind = $1', [kind])).rows;

describe('who may use it', () => {
  test.each([['get', '/api/backups'], ['post', '/api/backups'], ['put', '/api/backups/settings'], ['put', '/api/backups/passphrase'], ['post', '/api/backups/11111111-1111-4111-8111-111111111111/download'], ['delete', '/api/backups/11111111-1111-4111-8111-111111111111']])('%s %s needs a session', async (method, path) => {
    expect((await request(app)[method](path).send({})).status).toBe(401);
  });
});

describe('the overview', () => {
  test('starts empty, with the default schedule (daily at 03:00 UTC, keep 7), no encryption and the next run', async () => {
    const o = await overview();
    expect(o).toMatchObject({ backups: [], totalBytes: 0, schedule: { frequency: 'daily', hour: 3, weekday: 1, keep: 7 }, encryption: { enabled: false }, persistent: true });
    expect(new Date(o.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(o.nextRunAt).getUTCHours()).toBe(3);
  });
  test('lists newest first with each backup\'s state, and counts only the finished ones in the total', async () => {
    const old = await insert({ at: '2026-10-20T03:00:00Z', size: 100 });
    const failed = await insert({ status: 'failed', at: '2026-10-21T03:00:00Z', extra: { error: 'pg_dump failed' } });
    const recent = await insert({ at: '2026-10-22T03:00:00Z', size: 250, encrypted: true, trigger: 'scheduled', filename: 'shipdok-backup-20261022-030000-aaaaaaaa.tar.enc', extra: { warning: 'no secrets' } });
    const o = await overview();
    expect(o.backups.map((b) => b.id)).toEqual([recent, failed, old]);
    expect(o.totalBytes).toBe(350);
    expect(o.backups[0]).toMatchObject({ status: 'ok', trigger: 'scheduled', encrypted: true, verified: true, sizeBytes: 250, version: '0.1.17', warning: 'no secrets', downloadable: true, error: null });
    expect(o.backups[1]).toMatchObject({ status: 'failed', error: 'pg_dump failed', downloadable: false, sizeBytes: null });
  });
  test('only finished backups count in the total, whatever a failed row says about its size', async () => {
    await testPool.query(`INSERT INTO backups (status, trigger, size_bytes) VALUES ('failed', 'manual', 999)`);
    await insert({ size: 100 });
    expect((await overview()).totalBytes).toBe(100);
  });
  test('never shows a file name or a path', async () => {
    await insert();
    expect(JSON.stringify(await overview())).not.toMatch(/shipdok-backup|\.tar/);
  });
  test('shows at most the newest 200', async () => {
    await testPool.query(`INSERT INTO backups (status, trigger, requested_at) SELECT 'failed', 'manual', now() - make_interval(mins => g) FROM generate_series(1, 210) g`);
    expect((await overview()).backups).toHaveLength(200);
  });
  test('says when there is no end to the schedule: off has no next run', async () => {
    await agent.put('/api/backups/settings').send({ frequency: 'off', hour: 3, weekday: 1, keep: 7 });
    expect((await overview()).nextRunAt).toBeNull();
  });
});

describe('is the folder a volume of its own', () => {
  const stat = (devs) => async (p) => { if (!(p in devs)) throw new Error('no such folder'); return { dev: devs[p] }; };
  test('outside a container it always is', async () => expect(await inOwnVolume('/b/backups', { insideContainer: () => false, statFn: stat({}) })).toBe(true));
  test('in a container it is when the folder is on another device than the folder above it', async () => {
    expect(await inOwnVolume('/var/lib/shipdok/backups', { insideContainer: () => true, statFn: stat({ '/var/lib/shipdok/backups': 7, '/var/lib/shipdok': 3 }) })).toBe(true);
  });
  test('in a container it is not when both are on the container\'s own storage', async () => {
    expect(await inOwnVolume('/var/lib/shipdok/backups', { insideContainer: () => true, statFn: stat({ '/var/lib/shipdok/backups': 3, '/var/lib/shipdok': 3 }) })).toBe(false);
  });
  test('when it cannot be looked at, it is not claimed to be', async () => {
    expect(await inOwnVolume('/missing/backups', { insideContainer: () => true, statFn: stat({}) })).toBe(false);
  });
});

describe('asking for a backup', () => {
  test('is recorded as queued for the worker', async () => {
    const res = await agent.post('/api/backups');
    expect(res.status).toBe(202);
    const row = (await testPool.query('SELECT status, trigger FROM backups WHERE id = $1', [res.body.id])).rows[0];
    expect(row).toEqual({ status: 'queued', trigger: 'manual' });
    expect((await overview()).backups[0]).toMatchObject({ id: res.body.id, status: 'queued', downloadable: false });
  });
  test('only one may wait or run: a second is a 409, a finished one does not block', async () => {
    expect((await agent.post('/api/backups')).status).toBe(202);
    const again = await agent.post('/api/backups');
    expect([again.status, again.body.code]).toEqual([409, 'already_running']);
    await testPool.query(`UPDATE backups SET status = 'running'`);
    expect((await agent.post('/api/backups')).status).toBe(409);
    await testPool.query(`UPDATE backups SET status = 'ok', filename = NULL`);
    expect((await agent.post('/api/backups')).status).toBe(202);
  });
  test('two requests at the same moment make one', async () => {
    const results = await Promise.all([agent.post('/api/backups'), agent.post('/api/backups'), agent.post('/api/backups')]);
    expect(results.map((r) => r.status).sort()).toEqual([202, 409, 409]);
    expect((await testPool.query('SELECT count(*)::int AS n FROM backups')).rows[0].n).toBe(1);
  });
});

describe('the schedule', () => {
  const body = (over = {}) => ({ frequency: 'weekly', hour: 5, weekday: 3, keep: 14, ...over });
  test('is saved and answered with the new overview, and kept', async () => {
    const res = await agent.put('/api/backups/settings').send(body());
    expect(res.status).toBe(200);
    expect(res.body.schedule).toEqual(body());
    expect((await overview()).schedule).toEqual(body());
    const next = new Date(res.body.nextRunAt);
    expect([next.getUTCDay(), next.getUTCHours()]).toEqual([3, 5]);
  });
  test('can be changed again', async () => {
    await agent.put('/api/backups/settings').send(body());
    expect((await agent.put('/api/backups/settings').send(body({ frequency: 'daily', keep: 3 }))).body.schedule).toMatchObject({ frequency: 'daily', keep: 3 });
  });
  test.each([
    [{ frequency: 'hourly' }], [{ frequency: '' }], [{ hour: 24 }], [{ hour: -1 }], [{ hour: 1.5 }], [{ hour: '3' }], [{ weekday: 7 }], [{ keep: 0 }], [{ keep: 61 }], [{ keep: '7' }], [{ extra: 1 }],
  ])('refuses %j', async (bad) => {
    expect((await agent.put('/api/backups/settings').send(body(bad))).status).toBe(400);
    expect((await overview()).schedule).toMatchObject({ frequency: 'daily', keep: 7 });
  });
  test.each([['frequency'], ['hour'], ['weekday'], ['keep']])('refuses a schedule without %s', async (field) => {
    const b = body(); delete b[field];
    expect((await agent.put('/api/backups/settings').send(b)).status).toBe(400);
  });
  test('the limits themselves are fine', async () => {
    for (const ok of [{ hour: 0, keep: 1, weekday: 0 }, { hour: 23, keep: 60, weekday: 6 }]) expect((await agent.put('/api/backups/settings').send(body(ok))).status).toBe(200);
  });
  test('the change time is stored, so the worker does not catch up on a slot that passed before it', async () => {
    await agent.put('/api/backups/settings').send(body());
    const row = (await testPool.query(`SELECT updated_at FROM settings WHERE key = 'backup_schedule'`)).rows[0];
    expect(Date.now() - new Date(row.updated_at).getTime()).toBeLessThan(10_000);
  });
});

describe('the passphrase', () => {
  const PASS = 'correct horse battery staple';
  const put = (body) => agent.put('/api/backups/passphrase').send(body);
  const stored = async () => (await testPool.query(`SELECT value FROM settings WHERE key = 'backup_passphrase'`)).rows[0]?.value ?? null;

  test('is stored encrypted with the platform key (not in the clear), bound to its purpose, and turns encryption on', async () => {
    const res = await put({ password: PASSWORD, passphrase: PASS });
    expect(res.status).toBe(200);
    expect(res.body.encryption).toEqual({ enabled: true });
    const value = await stored();
    expect(JSON.stringify(value)).not.toContain(PASS);
    const key = loadSecretsKeyForTests();
    expect(decryptSecret(value, key, 'backup:passphrase')).toBe(PASS);
    expect(() => decryptSecret(value, key, 'backup:other')).toThrow();
  });
  test('is never in an answer', async () => {
    await put({ password: PASSWORD, passphrase: PASS });
    expect(JSON.stringify((await overview()))).not.toContain(PASS);
    expect(JSON.stringify((await put({ password: PASSWORD, passphrase: PASS })).body)).not.toContain(PASS);
  });
  test('null removes it', async () => {
    await put({ password: PASSWORD, passphrase: PASS });
    const res = await put({ password: PASSWORD, passphrase: null });
    expect(res.body.encryption).toEqual({ enabled: false });
    expect(await stored()).toBeNull();
  });
  test('needs the current password: a wrong one is a 403 and changes nothing', async () => {
    const res = await put({ password: 'not-the-password-123', passphrase: PASS });
    expect([res.status, res.body.code]).toEqual([403, 'wrong_password']);
    expect(await stored()).toBeNull();
    expect(await attempts('backup')).toEqual([]);
  });
  test.each([['short'], ['x'.repeat(11)], ['x'.repeat(257)], [' leading space here'], ['trailing space here '], [7], [undefined]])('refuses the passphrase %j', async (bad) => {
    expect((await put({ password: PASSWORD, passphrase: bad })).status).toBe(400);
    expect(await stored()).toBeNull();
  });
  test('refuses a request without a password, or with an extra field', async () => {
    expect((await put({ passphrase: PASS })).status).toBe(400);
    expect((await put({ password: PASSWORD, passphrase: PASS, extra: 1 })).status).toBe(400);
  });
  test('setting and removing it are recorded in the sign-ins list', async () => {
    await put({ password: PASSWORD, passphrase: PASS });
    await put({ password: PASSWORD, passphrase: null });
    expect(await attempts('backup')).toEqual([{ username: 'admin', success: true }, { username: 'admin', success: true }]);
  });
  test('a new one replaces the old', async () => {
    await put({ password: PASSWORD, passphrase: PASS });
    const first = await stored();
    await put({ password: PASSWORD, passphrase: 'another long passphrase 123' });
    expect(decryptSecret(await stored(), loadSecretsKeyForTests(), 'backup:passphrase')).toBe('another long passphrase 123');
    expect(await stored()).not.toEqual(first);
  });
});

describe('downloading', () => {
  const download = (id, body = { password: PASSWORD }) => agent.post(`/api/backups/${id}/download`).send(body).buffer(true).parse((res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { const all = Buffer.concat(chunks); cb(null, /json/.test(res.headers['content-type'] ?? '') ? JSON.parse(all.toString()) : all); }); });

  test('sends the file as it is, as a download, and records it', async () => {
    writeFileSync(join(dir, FILE), CONTENT);
    const id = await insert();
    const res = await download(id);
    expect(res.status).toBe(200);
    expect(res.body.equals(CONTENT)).toBe(true);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${FILE}"`);
    expect(res.headers['content-length']).toBe(String(CONTENT.length));
    expect(res.headers['cache-control']).toBe('no-store');
    expect(await attempts('download')).toEqual([{ username: 'admin', success: true }]);
  });
  test('needs the current password: none is a 400, a wrong one a 403, and the file is not sent or recorded', async () => {
    writeFileSync(join(dir, FILE), CONTENT);
    const id = await insert();
    expect((await download(id, {})).status).toBe(400);
    const wrong = await agent.post(`/api/backups/${id}/download`).send({ password: 'not-the-password-123' });
    expect([wrong.status, wrong.body.code]).toEqual([403, 'wrong_password']);
    expect(wrong.headers['content-disposition']).toBeUndefined();
    expect(await attempts('download')).toEqual([]);
  });
  test('a password in the address is no use: it has to be in the body of a POST', async () => {
    writeFileSync(join(dir, FILE), CONTENT);
    const id = await insert();
    expect((await agent.get(`/api/backups/${id}/download?password=${PASSWORD}`)).status).toBe(404);
  });
  test('a backup that failed, or is still being made, has nothing to download', async () => {
    for (const status of ['failed', 'queued']) {
      await testPool.query('TRUNCATE backups');
      const id = status === 'failed' ? await insert({ status }) : (await agent.post('/api/backups')).body.id;
      const res = await download(id);
      expect([res.status, res.body.code]).toEqual([409, 'no_file']);
    }
  });
  test('a failed backup is refused even if a file with its name is there (only a finished one is served)', async () => {
    writeFileSync(join(dir, FILE), CONTENT);
    await testPool.query(`INSERT INTO backups (status, trigger, filename) VALUES ('failed', 'manual', $1)`, [FILE]);
    const id = (await testPool.query(`SELECT id FROM backups`)).rows[0].id;
    const res = await download(id);
    expect([res.status, res.body.code]).toEqual([409, 'no_file']);
  });
  test('a file that has gone from the folder is a 410 that says so', async () => {
    const id = await insert();
    const res = await agent.post(`/api/backups/${id}/download`).send({ password: PASSWORD });
    expect([res.status, res.body.code]).toEqual([410, 'file_missing']);
    expect(await attempts('download')).toEqual([]);
  });
  test('an unknown or malformed id is a 404', async () => {
    expect((await agent.post('/api/backups/11111111-1111-4111-8111-111111111111/download').send({ password: PASSWORD })).status).toBe(404);
    for (const bad of ['not-a-uuid', '..', '%2e%2e%2fetc%2fpasswd', '1']) expect((await agent.post(`/api/backups/${bad}/download`).send({ password: PASSWORD })).status).toBe(404);
  });
  test('the database refuses a file name that could point outside the folder, whatever the application does', async () => {
    for (const name of ['../etc/passwd', '/etc/passwd', 'shipdok-backup-20261022-030405-12345678.tar/../x', 'other.tar']) {
      await expect(testPool.query(`INSERT INTO backups (status, trigger, filename) VALUES ('ok', 'manual', $1)`, [name])).rejects.toThrow(/check constraint/);
    }
  });
  test('an encrypted file is sent still encrypted', async () => {
    const name = 'shipdok-backup-20261022-030405-12345678.tar.enc';
    writeFileSync(join(dir, name), Buffer.from('SHIPDOK-BACKUP-1\nrest'));
    const id = await insert({ filename: name, encrypted: true });
    const res = await download(id);
    expect(res.body.toString().startsWith('SHIPDOK-BACKUP-1')).toBe(true);
    expect(res.headers['content-disposition']).toContain('.tar.enc');
  });
});

describe('deleting', () => {
  test('removes the file and the record', async () => {
    writeFileSync(join(dir, FILE), CONTENT);
    const id = await insert();
    expect((await agent.delete(`/api/backups/${id}`)).status).toBe(204);
    expect(existsSync(join(dir, FILE))).toBe(false);
    expect((await overview()).backups).toEqual([]);
  });
  test('removes the record of a failed backup, which has no file', async () => {
    const id = await insert({ status: 'failed' });
    expect((await agent.delete(`/api/backups/${id}`)).status).toBe(204);
    expect((await overview()).backups).toEqual([]);
  });
  test('a record whose file is already gone can still be removed', async () => {
    const id = await insert();
    expect((await agent.delete(`/api/backups/${id}`)).status).toBe(204);
  });
  test('refuses while it is being made, and keeps it', async () => {
    const id = (await agent.post('/api/backups')).body.id;
    const res = await agent.delete(`/api/backups/${id}`);
    expect([res.status, res.body.code]).toEqual([409, 'in_progress']);
    await testPool.query(`UPDATE backups SET status = 'running'`);
    expect((await agent.delete(`/api/backups/${id}`)).status).toBe(409);
    expect((await overview()).backups).toHaveLength(1);
  });
  test('only the one named goes, and files that are not backups are left alone', async () => {
    writeFileSync(join(dir, FILE), CONTENT);
    writeFileSync(join(dir, 'notes.txt'), 'keep');
    const other = await insert({ filename: 'shipdok-backup-20261023-030405-87654321.tar' });
    writeFileSync(join(dir, 'shipdok-backup-20261023-030405-87654321.tar'), CONTENT);
    const id = await insert();
    await agent.delete(`/api/backups/${id}`);
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
    expect(existsSync(join(dir, 'shipdok-backup-20261023-030405-87654321.tar'))).toBe(true);
    expect((await overview()).backups.map((b) => b.id)).toEqual([other]);
  });
  test('an unknown or malformed id is a 404', async () => {
    expect((await agent.delete('/api/backups/11111111-1111-4111-8111-111111111111')).status).toBe(404);
    expect((await agent.delete('/api/backups/not-a-uuid')).status).toBe(404);
  });
});
