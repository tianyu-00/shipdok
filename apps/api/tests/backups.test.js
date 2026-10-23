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
  await testPool.query('TRUNCATE volume_restores, backups');
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
  test.each([['get', '/api/backups'], ['post', '/api/backups'], ['put', '/api/backups/settings'], ['put', '/api/backups/passphrase'], ['post', '/api/backups/11111111-1111-4111-8111-111111111111/download'], ['delete', '/api/backups/11111111-1111-4111-8111-111111111111'], ['post', '/api/backups/11111111-1111-4111-8111-111111111111/restore']])('%s %s needs a session', async (method, path) => {
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
      await testPool.query('TRUNCATE volume_restores, backups');
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

// ---- Backups of an app's volumes
describe('backups of an app\'s volumes', () => {
  let appId;
  let appName;
  const addApp = async (name = 'Blog') => {
    const res = await agent.post('/api/apps').send({ name, repo: 'o/blog', container_port: 3000, host_port: 8080 + Math.floor(Math.random() * 500) });
    return res.body.id;
  };
  const addVolume = (id, path = '/data', state = 'in_use', size = null) => testPool.query(
    `INSERT INTO app_volumes (app_id, app_name, container_path, docker_name, state, size_bytes, measured_at) VALUES ($1, 'x', $2, $3, $4, $5, CASE WHEN $5::bigint IS NULL THEN NULL ELSE now() END)`,
    [id, path, `shipdok-vol-${Math.random().toString(16).slice(2)}`, state, size]);
  const volumeRow = async (id = appId) => (await testPool.query(`SELECT * FROM backups WHERE kind = 'volumes' AND app_id = $1`, [id])).rows;
  const settings = (over = {}, id = appId) => agent.put(`/api/backups/volumes/${id}/settings`).send({ enabled: true, stop: true, keep: 5, ...over });

  beforeEach(async () => {
    await testPool.query('TRUNCATE app_volumes');
    appName = 'Blog';
    appId = await addApp(appName);
    await addVolume(appId, '/data', 'in_use', 1000);
  });

  describe('who may use it', () => {
    test.each([['post', '/api/backups/volumes/11111111-1111-4111-8111-111111111111'], ['put', '/api/backups/volumes/11111111-1111-4111-8111-111111111111/settings']])('%s %s needs a session', async (method, path) => {
      expect((await request(app)[method](path).send({})).status).toBe(401);
    });
  });

  describe('the apps in the overview', () => {
    test('lists the apps that have mounted volumes, with the defaults: not in the schedule, not stopped, keep 3', async () => {
      const bare = await addApp('No data');
      await addVolume(bare, '/old', 'detached');
      const o = await overview();
      expect(o.apps).toEqual([{ id: appId, name: 'Blog', volumeCount: 1, sizeBytes: 1000, lastBackupAt: null, enabled: false, stop: false, keep: 3 }]);
    });
    test('adds the volumes of an app up, and says nothing about the size while any was never measured', async () => {
      await addVolume(appId, '/uploads', 'in_use', 234);
      expect((await overview()).apps[0]).toMatchObject({ volumeCount: 2, sizeBytes: 1234 });
      await addVolume(appId, '/cache', 'in_use', null);
      expect((await overview()).apps[0]).toMatchObject({ volumeCount: 3, sizeBytes: null });
    });
    test('apps are in alphabetical order, and an app being deleted is not listed', async () => {
      const a = await addApp('alpha'); await addVolume(a);
      const z = await addApp('Zulu'); await addVolume(z);
      expect((await overview()).apps.map((x) => x.name)).toEqual(['alpha', 'Blog', 'Zulu']);
      await testPool.query(`UPDATE apps SET deleting_at = now() WHERE id = $1`, [z]);
      expect((await overview()).apps.map((x) => x.name)).toEqual(['alpha', 'Blog']);
    });
    test('says when the latest good volume backup finished', async () => {
      await testPool.query(`INSERT INTO backups (kind, app_id, app_name, status, trigger, filename, finished_at) VALUES ('volumes', $1, 'Blog', 'ok', 'manual', 'shipdok-volumes-20261022-030000-aaaaaaaa.tar', '2026-10-22T03:00:00Z'), ('volumes', $1, 'Blog', 'failed', 'manual', NULL, '2026-10-23T03:00:00Z')`, [appId]);
      expect(new Date((await overview()).apps[0].lastBackupAt).toISOString()).toBe('2026-10-22T03:00:00.000Z');
    });
    test('a volume backup is listed with its kind, app and number of volumes, and never a file name', async () => {
      await testPool.query(`INSERT INTO backups (kind, app_id, app_name, volume_count, status, trigger, filename, size_bytes, encrypted, verified, finished_at) VALUES ('volumes', $1, 'Blog', 2, 'ok', 'scheduled', 'shipdok-volumes-20261022-030000-aaaaaaaa.tar', 77, false, true, now())`, [appId]);
      const o = await overview();
      expect(o.backups[0]).toMatchObject({ kind: 'volumes', appId, appName: 'Blog', volumeCount: 2, sizeBytes: 77, downloadable: true });
      expect(JSON.stringify(o)).not.toMatch(/shipdok-volumes|\.tar/);
      expect(o.totalBytes).toBe(77);
    });
    test('Shipdok\'s own backups say so', async () => {
      await insert();
      expect((await overview()).backups[0]).toMatchObject({ kind: 'platform', appId: null, appName: null, volumeCount: null });
    });
    test('a backup stays listed, under the name the app had, after the app is deleted', async () => {
      await testPool.query(`INSERT INTO backups (kind, app_id, app_name, status, trigger, filename, size_bytes, finished_at) VALUES ('volumes', $1, 'Blog', 'ok', 'manual', 'shipdok-volumes-20261022-030000-aaaaaaaa.tar', 5, now())`, [appId]);
      await testPool.query('DELETE FROM app_volumes WHERE app_id = $1', [appId]);
      await testPool.query('DELETE FROM apps WHERE id = $1', [appId]);
      expect((await overview()).backups[0]).toMatchObject({ kind: 'volumes', appId: null, appName: 'Blog', downloadable: true });
    });
  });

  describe('asking for one now', () => {
    test('is recorded as queued for the worker, with the app and its name', async () => {
      const res = await agent.post(`/api/backups/volumes/${appId}`);
      expect(res.status).toBe(202);
      const row = (await volumeRow())[0];
      expect([row.id, row.status, row.trigger, row.kind, row.app_name]).toEqual([res.body.id, 'queued', 'manual', 'volumes', 'Blog']);
    });
    test('one per app: a second is a 409, another app\'s and Shipdok\'s own are not blocked', async () => {
      expect((await agent.post(`/api/backups/volumes/${appId}`)).status).toBe(202);
      const again = await agent.post(`/api/backups/volumes/${appId}`);
      expect([again.status, again.body.code]).toEqual([409, 'already_running']);
      const other = await addApp('Other'); await addVolume(other);
      expect((await agent.post(`/api/backups/volumes/${other}`)).status).toBe(202);
      expect((await agent.post('/api/backups')).status).toBe(202);
    });
    test('two requests at the same moment make one', async () => {
      const results = await Promise.all([1, 2, 3].map(() => agent.post(`/api/backups/volumes/${appId}`)));
      expect(results.map((r) => r.status).sort()).toEqual([202, 409, 409]);
      expect(await volumeRow()).toHaveLength(1);
    });
    test('an app with no mounted volume is a 400 (a detached one does not count)', async () => {
      const bare = await addApp('Bare');
      let res = await agent.post(`/api/backups/volumes/${bare}`);
      expect([res.status, res.body.code]).toEqual([400, 'no_volumes']);
      await addVolume(bare, '/old', 'detached');
      res = await agent.post(`/api/backups/volumes/${bare}`);
      expect(res.status).toBe(400);
      expect(await volumeRow(bare)).toHaveLength(0);
    });
    test('an unknown app, a bad id and an app being deleted are 404', async () => {
      expect((await agent.post('/api/backups/volumes/11111111-1111-4111-8111-111111111111')).status).toBe(404);
      expect((await agent.post('/api/backups/volumes/not-an-id')).status).toBe(404);
      await testPool.query(`UPDATE apps SET deleting_at = now() WHERE id = $1`, [appId]);
      expect((await agent.post(`/api/backups/volumes/${appId}`)).status).toBe(404);
    });
    test('a finished backup can be deleted, and a waiting one cannot (the same rules as Shipdok\'s own)', async () => {
      const queued = await agent.post(`/api/backups/volumes/${appId}`);
      expect((await agent.delete(`/api/backups/${queued.body.id}`)).status).toBe(409);
      await testPool.query(`UPDATE backups SET status = 'failed' WHERE id = $1`, [queued.body.id]);
      expect((await agent.delete(`/api/backups/${queued.body.id}`)).status).toBe(204);
    });
  });

  describe('the settings of an app', () => {
    test('are saved, answered with the new overview, and kept', async () => {
      const res = await settings({ enabled: true, stop: true, keep: 5 });
      expect(res.status).toBe(200);
      expect(res.body.apps[0]).toMatchObject({ id: appId, enabled: true, stop: true, keep: 5 });
      expect((await overview()).apps[0]).toMatchObject({ enabled: true, stop: true, keep: 5 });
    });
    test('switching the schedule on records when (so that a slot that passed earlier today is not made up for), leaving it on does not move that', async () => {
      expect((await testPool.query('SELECT volume_backup_changed_at FROM apps WHERE id = $1', [appId])).rows[0].volume_backup_changed_at).toBeNull();
      await settings({ enabled: true });
      const first = (await testPool.query('SELECT volume_backup_changed_at AS t FROM apps WHERE id = $1', [appId])).rows[0].t;
      expect(first).not.toBeNull();
      await testPool.query(`UPDATE apps SET volume_backup_changed_at = '2020-01-01' WHERE id = $1`, [appId]);
      await settings({ enabled: true, keep: 9 });
      expect((await testPool.query('SELECT volume_backup_changed_at AS t FROM apps WHERE id = $1', [appId])).rows[0].t.toISOString()).toBe('2020-01-01T00:00:00.000Z');
      await settings({ enabled: false });
      expect((await testPool.query('SELECT volume_backup_changed_at AS t FROM apps WHERE id = $1', [appId])).rows[0].t.getFullYear()).toBeGreaterThan(2020);
    });
    test.each([
      [{ keep: 0 }], [{ keep: 61 }], [{ keep: 2.5 }], [{ keep: '5' }], [{ enabled: 'yes' }], [{ stop: null }], [{ extra: 1 }],
    ])('refuses %j', async (over) => {
      expect((await settings(over)).status).toBe(400);
      expect((await overview()).apps[0]).toMatchObject({ enabled: false, stop: false, keep: 3 });
    });
    test('both ends of the number to keep are fine', async () => {
      expect((await settings({ keep: 1 })).status).toBe(200);
      expect((await settings({ keep: 60 })).status).toBe(200);
    });
    test('an unknown app, a bad id and an app being deleted are 404', async () => {
      expect((await settings({}, '11111111-1111-4111-8111-111111111111')).status).toBe(404);
      expect((await settings({}, 'nope')).status).toBe(404);
      await testPool.query(`UPDATE apps SET deleting_at = now() WHERE id = $1`, [appId]);
      expect((await settings()).status).toBe(404);
    });
    test('missing fields are refused: nothing is half-saved', async () => {
      expect((await agent.put(`/api/backups/volumes/${appId}/settings`).send({ enabled: true })).status).toBe(400);
    });
  });

  describe('downloading', () => {
    test('works for a volume backup like for any other: the password, the record in the sign-ins list, the bytes', async () => {
      const name = 'shipdok-volumes-20261022-030000-aaaaaaaa.tar';
      writeFileSync(join(dir, name), CONTENT);
      const { rows } = await testPool.query(`INSERT INTO backups (kind, app_id, app_name, status, trigger, filename, size_bytes, finished_at) VALUES ('volumes', $1, 'Blog', 'ok', 'manual', $2, $3, now()) RETURNING id`, [appId, name, CONTENT.length]);
      const bad = await agent.post(`/api/backups/${rows[0].id}/download`).send({ password: 'wrong-password-here' });
      expect(bad.status).toBe(403);
      const res = await agent.post(`/api/backups/${rows[0].id}/download`).send({ password: PASSWORD }).buffer().parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain(name);
      expect(Buffer.compare(res.body, CONTENT)).toBe(0);
      expect(await attempts('download')).toHaveLength(1);
    });
  });
});

// ---- Restoring the volumes of an app from a backup
describe('restoring from a volume backup', () => {
  const VNAME = 'shipdok-volumes-20261022-030000-aaaaaaaa.tar';
  let appId;
  const body = (over = {}) => ({ password: PASSWORD, mode: 'replace', safetyBackup: true, ...over });
  const volumeBackup = async ({ status = 'ok', kind = 'volumes', app = appId, filename = VNAME, encrypted = false, file = true } = {}) => {
    if (file && status === 'ok') writeFileSync(join(dir, filename), CONTENT);
    const { rows } = await testPool.query(
      `INSERT INTO backups (kind, app_id, app_name, status, trigger, filename, size_bytes, encrypted, finished_at) VALUES ($1, $2, $3, $4, 'manual', $5, 5, $6, '2026-10-22T03:00:00Z') RETURNING id`,
      [kind, kind === 'volumes' ? app : null, kind === 'volumes' ? 'Blog' : null, status, status === 'ok' ? filename : null, encrypted]);
    return rows[0].id;
  };
  const restore = (id, over = {}) => agent.post(`/api/backups/${id}/restore`).send(body(over));
  const restoreRows = async () => (await testPool.query('SELECT * FROM volume_restores')).rows;

  beforeEach(async () => {
    await testPool.query('TRUNCATE app_volumes');
    appId = (await agent.post('/api/apps').send({ name: 'Blog', repo: 'o/blog', container_port: 3000, host_port: 8300 })).body.id;
    await testPool.query(`INSERT INTO app_volumes (app_id, app_name, container_path, docker_name) VALUES ($1, 'Blog', '/data', 'shipdok-vol-r1')`, [appId]);
  });

  test('is recorded as queued with what the person chose, and the password is checked and the use recorded in the sign-ins list', async () => {
    const id = await volumeBackup();
    const res = await restore(id, { mode: 'add', safetyBackup: false });
    expect(res.status).toBe(202);
    const [row] = await restoreRows();
    expect(row).toMatchObject({ id: res.body.id, backup_id: id, app_id: appId, app_name: 'Blog', mode: 'add', safety_backup: false, status: 'queued', passphrase_enc: null });
    expect(new Date(row.backup_made_at).toISOString()).toBe('2026-10-22T03:00:00.000Z');
    expect(await attempts('restore')).toHaveLength(1);
  });
  test('a wrong password is a 403 and nothing is recorded, not even in the sign-ins list', async () => {
    const id = await volumeBackup();
    const res = await restore(id, { password: 'wrong-password-here' });
    expect([res.status, res.body.code]).toEqual([403, 'wrong_password']);
    expect(await restoreRows()).toHaveLength(0);
    expect(await attempts('restore')).toHaveLength(0);
  });
  test('the passphrase given for an older backup is kept encrypted with the platform key, bound to that one restore', async () => {
    const id = await volumeBackup({ encrypted: true });
    const res = await restore(id, { passphrase: 'the old passphrase of mine' });
    expect(res.status).toBe(202);
    const [row] = await restoreRows();
    expect(row.passphrase_enc).not.toContain('old passphrase');
    const key = loadSecretsKeyForTests();
    expect(decryptSecret(row.passphrase_enc, key, `restore:passphrase:${res.body.id}`)).toBe('the old passphrase of mine');
    expect(() => decryptSecret(row.passphrase_enc, key, 'restore:passphrase:other')).toThrow();
    expect(JSON.stringify(await overview())).not.toContain('old passphrase');
  });
  test.each([
    [{ mode: 'wipe' }], [{ mode: undefined }], [{ safetyBackup: undefined }], [{ safetyBackup: 'yes' }], [{ password: undefined }], [{ passphrase: '' }], [{ passphrase: 'x'.repeat(257) }], [{ extra: 1 }],
  ])('refuses %j', async (over) => {
    const id = await volumeBackup();
    const res = await agent.post(`/api/backups/${id}/restore`).send({ ...body(), ...over });
    expect(res.status).toBe(400);
    expect(await restoreRows()).toHaveLength(0);
  });
  test('all three modes are accepted', async () => {
    for (const mode of ['replace', 'add', 'empty']) {
      await testPool.query('TRUNCATE volume_restores');
      expect((await restore(await volumeBackup(), { mode })).status).toBe(202);
    }
  });

  describe('what it refuses', () => {
    const none = async () => expect(await restoreRows()).toHaveLength(0);
    test('an unknown backup and a bad id are 404', async () => {
      expect((await restore('11111111-1111-4111-8111-111111111111')).status).toBe(404);
      expect((await restore('nope')).status).toBe(404);
      await none();
    });
    test('a backup of Shipdok itself is a 400: that restore is not available here', async () => {
      const id = await volumeBackup({ kind: 'platform', filename: 'shipdok-backup-20261022-030000-aaaaaaaa.tar' });
      const res = await restore(id);
      expect([res.status, res.body.code]).toEqual([400, 'not_volumes']);
      await none();
    });
    test('a backup that failed or is still being made has no file to restore from', async () => {
      for (const status of ['failed', 'queued', 'running']) {
        await testPool.query('TRUNCATE volume_restores, backups');
        const res = await restore(await volumeBackup({ status }));
        expect([res.status, res.body.code]).toEqual([409, 'no_file']);
      }
      await none();
    });
    test('the app of the backup is gone, or being deleted', async () => {
      const id = await volumeBackup();
      await testPool.query(`UPDATE apps SET deleting_at = now() WHERE id = $1`, [appId]);
      expect((await restore(id)).body.code).toBe('app_gone');
      await testPool.query(`UPDATE apps SET deleting_at = NULL WHERE id = $1`, [appId]);
      await testPool.query('DELETE FROM app_volumes'); await testPool.query('DELETE FROM apps WHERE id = $1', [appId]);
      expect([(await restore(id)).status, (await restore(id)).body.code]).toEqual([409, 'app_gone']);
      await none();
    });
    test('the file is gone from the backups folder: 410', async () => {
      const id = await volumeBackup({ file: false });
      const res = await restore(id);
      expect([res.status, res.body.code]).toEqual([410, 'file_missing']);
      await none();
    });
    test('the app has no mounted volume any more (a detached one does not count)', async () => {
      const id = await volumeBackup();
      await testPool.query(`UPDATE app_volumes SET state = 'detached'`);
      const res = await restore(id);
      expect([res.status, res.body.code]).toEqual([400, 'no_volumes']);
      await none();
    });
    test('a backup of the app that is waiting or running blocks it, and so does a restore already waiting', async () => {
      const id = await volumeBackup();
      expect((await agent.post(`/api/backups/volumes/${appId}`)).status).toBe(202);
      const res = await restore(id);
      expect([res.status, res.body.code]).toEqual([409, 'backup_running']);
      await testPool.query(`UPDATE backups SET status = 'failed' WHERE status = 'queued'`);
      expect((await restore(id)).status).toBe(202);
      const again = await restore(id);
      expect([again.status, again.body.code]).toEqual([409, 'already_running']);
      expect(await restoreRows()).toHaveLength(1);
    });
    test('a backup of ANOTHER app does not block it', async () => {
      const other = (await agent.post('/api/apps').send({ name: 'Other', repo: 'o/other', container_port: 3000, host_port: 8301 })).body.id;
      await testPool.query(`INSERT INTO app_volumes (app_id, app_name, container_path, docker_name) VALUES ($1, 'Other', '/d', 'shipdok-vol-r2')`, [other]);
      expect((await agent.post(`/api/backups/volumes/${other}`)).status).toBe(202);
      expect((await restore(await volumeBackup())).status).toBe(202);
    });
  });

  test('a backup of an app\'s volumes cannot be asked for while a restore of that app waits or runs (and nothing is recorded)', async () => {
    expect((await restore(await volumeBackup())).status).toBe(202);
    const res = await agent.post(`/api/backups/volumes/${appId}`);
    expect([res.status, res.body.code]).toEqual([409, 'restore_running']);
    expect((await testPool.query(`SELECT count(*)::int AS n FROM backups WHERE status = 'queued'`)).rows[0].n).toBe(0);
  });

  describe('in the overview', () => {
    test('says which backups can be restored: finished volume backups with a file whose app exists', async () => {
      const good = await volumeBackup();
      const failed = await volumeBackup({ status: 'failed' });
      const platform = await volumeBackup({ kind: 'platform', filename: 'shipdok-backup-20261022-030000-bbbbbbbb.tar' });
      const gone = await volumeBackup({ app: null, filename: 'shipdok-volumes-20261022-030000-cccccccc.tar' });
      const byId = Object.fromEntries((await overview()).backups.map((b) => [b.id, b.restorable]));
      expect(byId).toEqual({ [good]: true, [failed]: false, [platform]: false, [gone]: false });
    });
    test('lists the latest restores, newest first, with how each went and never the passphrase', async () => {
      const id = await volumeBackup();
      const first = (await restore(id, { passphrase: 'secret passphrase 1' })).body.id;
      await testPool.query(`UPDATE volume_restores SET status = 'failed', error = 'Not enough free disk space', finished_at = now(), requested_at = now() - interval '1 hour' WHERE id = $1`, [first]);
      const second = (await restore(id, { mode: 'empty', safetyBackup: false })).body.id;
      const o = await overview();
      expect(o.restores.map((r) => r.id)).toEqual([second, first]);
      expect(o.restores[0]).toMatchObject({ backupId: id, appId, appName: 'Blog', mode: 'empty', safetyBackup: false, status: 'queued', error: null });
      expect(o.restores[1]).toMatchObject({ status: 'failed', error: 'Not enough free disk space' });
      expect(JSON.stringify(o)).not.toMatch(/passphrase_enc|secret passphrase/);
    });
    test('shows at most 20 restores', async () => {
      await testPool.query(`INSERT INTO volume_restores (app_name, mode, safety_backup, status, requested_at) SELECT 'x', 'add', true, 'ok', now() - make_interval(mins => g) FROM generate_series(1, 25) g`);
      expect((await overview()).restores).toHaveLength(20);
    });
    test('a backup stays restorable-looking data after its restore row refers to it, and deleting the backup keeps the restore row', async () => {
      const id = await volumeBackup();
      await restore(id);
      await testPool.query(`UPDATE volume_restores SET status = 'ok'`);
      expect((await agent.delete(`/api/backups/${id}`)).status).toBe(204);
      expect((await overview()).restores[0]).toMatchObject({ backupId: null, status: 'ok' });
    });
  });
});
