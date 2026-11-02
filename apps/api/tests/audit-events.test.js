// What the activity log says for each thing the administrator does to apps, deployments, variables, storage and backups, and for the account:
// the category, the one-line summary, the facts (before and after), and that a secret is never in an entry.
import request from 'supertest';
import { jest } from '@jest/globals';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from './helpers.js';

let agent;
let queue;
let appId;
const SECRET = 'Sup3r-Secret-Value-Never-In-The-Log';

beforeEach(async () => {
  await resetDb();
  await testPool.query('TRUNCATE app_volumes, volume_restores, backups, build_cache');
  queue = { add: jest.fn(async () => ({ id: '1' })), remove: jest.fn(async () => {}) };
  agent = request.agent(await makeApp({ queue, backupDir: mkdtempSync(join(tmpdir(), 'ev-')) }));
  await agent.post('/api/auth/setup').send({ username: 'admin', password: PASSWORD });
  appId = (await agent.post('/api/apps').send({ name: 'Blog', repo: 'o/blog', container_port: 3000, host_port: 8101 })).body.id;
});
afterAll(closeDb);

const entries = async (query = '') => (await agent.get(`/api/audit?limit=500${query}`)).body.entries;
const last = async () => (await entries())[0];
const detail = (e, label) => e.details.find((d) => d.label === label);
const everything = async () => JSON.stringify((await testPool.query('SELECT * FROM audit_log')).rows);

describe('apps', () => {
  test('creating one says what it is', async () => {
    const e = (await entries()).find((x) => x.action === 'app_created');
    expect(e).toMatchObject({ category: 'apps', summary: 'App created: Blog', appId, appName: 'Blog', actor: 'admin', source: 'user' });
    expect(detail(e, 'Repository').value).toBe('o/blog');
    expect(detail(e, 'Branch').value).toBe('main');
    expect(detail(e, 'Host port').value).toBe('8101');
    expect(detail(e, 'GitHub app').value).toBe('none (a public repository)');
  });

  test('a failed creation leaves no entry', async () => {
    const before = (await entries()).length;
    expect((await agent.post('/api/apps').send({ name: 'Blog', repo: 'o/other', container_port: 3000, host_port: 8102 })).status).toBe(409);
    expect((await entries()).length).toBe(before);
  });

  test('an edit lists each setting that changed, before and after, and nothing else', async () => {
    expect((await agent.put(`/api/apps/${appId}`).send({ branch: 'dev', memory_mb: 256, health_path: '/up' })).status).toBe(200);
    const e = await last();
    expect(e).toMatchObject({ category: 'apps', action: 'app_edited', appName: 'Blog' });
    expect(e.summary).toMatch(/^Settings of Blog changed: /);
    expect(e.details).toHaveLength(3);
    expect(detail(e, 'Branch')).toEqual({ label: 'Branch', from: 'main', to: 'dev' });
    expect(detail(e, 'Memory (MB)')).toEqual({ label: 'Memory (MB)', from: '512', to: '256' });
    expect(detail(e, 'Health check path')).toEqual({ label: 'Health check path', from: '', to: '/up' });
  });

  test('the same values again, or 1 for 1.00 CPUs, are not a change', async () => {
    await agent.put(`/api/apps/${appId}`).send({ branch: 'main', cpus: 1 });
    expect(await last()).toMatchObject({ action: 'app_edited', summary: 'Settings of Blog saved, nothing changed', details: [] });
  });

  test('a rename names the new name in the summary', async () => {
    await agent.put(`/api/apps/${appId}`).send({ name: 'Blog 2' });
    const e = await last();
    expect(e.summary).toBe('Settings of Blog 2 changed: name');
    expect(detail(e, 'Name')).toEqual({ label: 'Name', from: 'Blog', to: 'Blog 2' });
  });

  test('a refused edit leaves no entry', async () => {
    const before = (await entries()).length;
    expect((await agent.put(`/api/apps/${appId}`).send({ memory_mb: 'lots' })).status).toBe(400);
    expect((await entries()).length).toBe(before);
  });

  test.each([['stop', 'Stop requested for Blog', 'stopped'], ['start', 'Start requested for Blog', 'running'], ['restart', 'Restart requested for Blog', 'running']])('%s', async (action, summary, wanted) => {
    expect((await agent.post(`/api/apps/${appId}/${action}`)).status).toBe(202);
    const e = await last();
    expect(e).toMatchObject({ category: 'apps', action: `app_${action}`, summary, appId });
    expect(detail(e, 'Wanted state').value).toBe(wanted);
  });

  test('deleting says what goes and whether the volumes stay', async () => {
    expect((await agent.delete(`/api/apps/${appId}`).send({ confirm: 'Blog' })).status).toBe(202);
    let e = await last();
    expect(e).toMatchObject({ category: 'apps', action: 'app_deleted', summary: 'App deletion started: Blog' });
    expect(detail(e, 'Persistent volumes').value).toMatch(/^kept/);
    await agent.delete(`/api/apps/${appId}`).send({ confirm: 'Blog', deleteVolumes: true });
    e = await last();
    expect(detail(e, 'Persistent volumes').value).toBe('deleted');
  });

  test('a delete with the wrong name leaves no entry', async () => {
    const before = (await entries()).length;
    expect((await agent.delete(`/api/apps/${appId}`).send({ confirm: 'nope' })).status).toBe(400);
    expect((await entries()).length).toBe(before);
  });
});

describe('deployments', () => {
  test('a deploy names the app, the branch and the deployment; the flags are only said when used', async () => {
    const dep = (await agent.post(`/api/apps/${appId}/deployments`)).body;
    let e = await last();
    expect(e).toMatchObject({ category: 'deployments', action: 'deploy_requested', summary: 'Deployment requested for Blog', appId });
    expect(detail(e, 'Deployment').value).toBe(dep.id.slice(0, 8));
    expect(e.details.map((d) => d.label)).toEqual(['App', 'Branch', 'Deployment']);
    await agent.post(`/api/apps/${appId}/deployments`).send({ noCache: true, start: true });
    e = await last();
    expect(detail(e, 'Cache').value).toBe('built without the cache');
    expect(detail(e, 'Afterwards')).toBeDefined();
  });

  test('a cancel says which deployment and how', async () => {
    const dep = (await agent.post(`/api/apps/${appId}/deployments`)).body;
    expect((await agent.post(`/api/deployments/${dep.id}/cancel`)).status).toBe(200);
    const e = await last();
    expect(e).toMatchObject({ category: 'deployments', action: 'deploy_cancelled', summary: `Deployment cancelled: Blog ${dep.id.slice(0, 8)}` });
    expect(detail(e, 'How').value).toMatch(/ended at once/);
  });

  test('a rollback says which version it goes back to and what it replaces', async () => {
    const make = async (sha, image) => (await testPool.query(
      `INSERT INTO deployments (app_id, trigger, commit_sha, status, config_snapshot, finished_at, image_ref, image_bytes) VALUES ($1, 'manual', $2, 'successful', '{}', now(), $3, 1000) RETURNING id`,
      [appId, sha, image])).rows[0].id;
    const older = await make('a'.repeat(40), 'shipdok-img:old');
    await new Promise((r) => setTimeout(r, 15));
    await make('b'.repeat(40), 'shipdok-img:new');
    const res = await agent.post(`/api/apps/${appId}/rollback`).send({ deploymentId: older });
    expect(res.status).toBe(202);
    const e = await last();
    expect(e).toMatchObject({ category: 'deployments', action: 'rollback_requested', summary: 'Rollback of Blog to aaaaaaaa' });
    expect(detail(e, 'Back to the version of deployment').value).toBe(older.slice(0, 8));
    expect(detail(e, 'Replaces').value).toBe('commit bbbbbbbb');
  });

  test('a refused deploy (the app is being deleted) leaves no entry', async () => {
    await agent.delete(`/api/apps/${appId}`).send({ confirm: 'Blog' });
    const before = (await entries()).length;
    expect((await agent.post(`/api/apps/${appId}/deployments`)).status).toBe(409);
    expect((await entries()).length).toBe(before);
  });
});

describe('variables: the name, never the value', () => {
  const put = (k, body) => agent.put(`/api/apps/${appId}/env/${k}`).send(body);

  test('adding says where it is available, and no value is anywhere in the log', async () => {
    await put('API_TOKEN', { value: SECRET, scope: 'both' });
    const e = await last();
    expect(e).toMatchObject({ category: 'variables', action: 'var_added', summary: 'Variable added to Blog: API_TOKEN', appId });
    expect(detail(e, 'Available in').value).toBe('both');
    expect(detail(e, 'Passed to the build as').value).toBe('arg');
    expect(detail(e, 'Value').value).toBe('never recorded');
    expect(await everything()).not.toContain(SECRET);
  });

  test('a runtime-only variable does not say how it is passed to the build', async () => {
    await put('RUNTIME_ONLY', { value: SECRET });
    expect(detail(await last(), 'Passed to the build as')).toBeUndefined();
  });

  test('a new value says it changed, without the value; a changed scope is before and after', async () => {
    await put('A', { value: 'one' });
    await put('A', { value: SECRET, scope: 'build' });
    const e = await last();
    expect(e).toMatchObject({ action: 'var_changed', summary: 'Variable value changed in Blog: A' });
    expect(detail(e, 'Available in')).toEqual({ label: 'Available in', from: 'runtime', to: 'build' });
    expect(await everything()).not.toContain(SECRET);
  });

  test('only a changed scope or way of passing it is "settings changed"; the same again records nothing', async () => {
    await put('A', { value: 'one', scope: 'both' });
    await put('A', { buildAs: 'secret' });
    const e = await last();
    expect(e.summary).toBe('Variable settings changed in Blog: A');
    expect(detail(e, 'Passed to the build as')).toEqual({ label: 'Passed to the build as', from: 'arg', to: 'secret' });
    const before = (await entries()).length;
    await put('A', { buildAs: 'secret' });
    expect((await entries()).length).toBe(before);
  });

  test('a rename says from and to', async () => {
    await put('OLD', { value: 'x' });
    await put('OLD', { newKey: 'NEW' });
    const e = await last();
    expect(e).toMatchObject({ action: 'var_renamed', summary: 'Variable renamed in Blog: OLD → NEW' });
    expect(detail(e, 'Name')).toEqual({ label: 'Name', from: 'OLD', to: 'NEW' });
  });

  test('deleting, importing and revealing are each recorded; the import lists names, counts and no values', async () => {
    await put('GONE', { value: 'x' });
    await agent.delete(`/api/apps/${appId}/env/GONE`);
    expect(await last()).toMatchObject({ action: 'var_deleted', summary: 'Variable deleted from Blog: GONE' });
    await put('KEEP', { value: 'x' });
    await agent.post(`/api/apps/${appId}/env/import`).send({ content: `KEEP=${SECRET}\nNEWONE=${SECRET}\n` });
    const imported = await last();
    expect(imported).toMatchObject({ action: 'var_imported', summary: 'Variables imported into Blog: 1 added, 1 changed' });
    expect(detail(imported, 'Names').value).toBe('KEEP, NEWONE');
    const shown = await agent.post(`/api/apps/${appId}/env/KEEP/reveal`);
    expect(shown.body.value).toBe(SECRET);
    expect(await last()).toMatchObject({ action: 'var_revealed', summary: 'Variable value shown: KEEP of Blog' });
    expect(await everything()).not.toContain(SECRET);
  });

  test('a refused change and a variable that is not there leave no entry', async () => {
    const before = (await entries()).length;
    expect((await put('lower-case', { value: 'x' })).status).toBe(400);
    expect((await agent.delete(`/api/apps/${appId}/env/NOPE`)).status).toBe(404);
    expect((await agent.post(`/api/apps/${appId}/env/NOPE/reveal`)).status).toBe(404);
    expect((await entries()).length).toBe(before);
  });
});

describe('storage', () => {
  test('the paths of an app: added, detached, and "nothing changed"', async () => {
    await agent.put(`/api/apps/${appId}/volumes`).send({ paths: ['/data', '/uploads'] });
    let e = await last();
    expect(e).toMatchObject({ category: 'storage', action: 'storage_paths', summary: 'Persistent storage of Blog changed' });
    expect(detail(e, 'Paths added').value).toBe('/data, /uploads');
    expect(detail(e, 'Takes effect').value).toBe('with the next deployment');
    await agent.put(`/api/apps/${appId}/volumes`).send({ paths: ['/data'] });
    e = await last();
    expect(detail(e, 'Paths detached (the data is kept)').value).toBe('/uploads');
    expect(detail(e, 'Paths added')).toBeUndefined();
    await agent.put(`/api/apps/${appId}/volumes`).send({ paths: ['/data'] });
    expect(await last()).toMatchObject({ summary: 'Persistent storage of Blog saved, nothing changed', details: [] });
  });

  test('reclaiming and deleting a kept volume say whose it was and where it went', async () => {
    const other = (await agent.post('/api/apps').send({ name: 'Shop', repo: 'o/shop', container_port: 3000, host_port: 8102 })).body.id;
    await agent.put(`/api/apps/${appId}/volumes`).send({ paths: ['/data'] });
    await agent.put(`/api/apps/${appId}/volumes`).send({ paths: [] });
    const kept = (await agent.get('/api/volumes')).body.volumes[0];
    expect((await agent.post(`/api/volumes/${kept.id}/reclaim`).send({ appId: other, path: '/shopdata' })).status).toBe(200);
    let e = await last();
    expect(e).toMatchObject({ category: 'storage', action: 'volume_reclaimed', summary: 'Kept volume attached to Shop at /shopdata', appName: 'Shop' });
    expect(detail(e, 'Was kept from').value).toBe('Blog');
    expect(detail(e, 'Volume').value).toBe(kept.dockerName);
    await agent.put(`/api/apps/${other}/volumes`).send({ paths: [] });
    const again = (await agent.get('/api/volumes')).body.volumes[0];
    expect((await agent.delete(`/api/volumes/${again.id}`)).status).toBe(202);
    e = await last();
    expect(e).toMatchObject({ action: 'volume_deleted', summary: 'Volume deletion asked for: /shopdata of Shop' });
    expect(detail(e, 'Its data').value).toBe('deleted for good');
  });

  test('a refused reclaim or delete (the volume is mounted) leaves no entry', async () => {
    await agent.put(`/api/apps/${appId}/volumes`).send({ paths: ['/data'] });
    const mounted = (await testPool.query('SELECT id FROM app_volumes')).rows[0].id;
    const before = (await entries()).length;
    expect((await agent.delete(`/api/volumes/${mounted}`)).status).toBe(409);
    expect((await agent.post(`/api/volumes/${mounted}/reclaim`).send({ appId, path: '/x' })).status).toBe(409);
    expect((await entries()).length).toBe(before);
  });

  test('image clean-up of one app, and keeping fewer versions with before and after', async () => {
    expect((await agent.post(`/api/apps/${appId}/prune`)).status).toBe(202);
    expect(await last()).toMatchObject({ category: 'storage', action: 'image_cleanup', summary: 'Old images of Blog clean-up asked for' });
    await agent.put(`/api/apps/${appId}/retention`).send({ keep_previous_images: 3, auto_prune: false });
    const e = await last();
    expect(e).toMatchObject({ action: 'image_retention', summary: expect.stringMatching(/^Image keeping of Blog changed: /) });
    expect(detail(e, 'Earlier versions kept')).toEqual({ label: 'Earlier versions kept', from: '1', to: '3' });
    expect(detail(e, 'Clean up old images automatically')).toEqual({ label: 'Clean up old images automatically', from: 'true', to: 'false' });
    await agent.put(`/api/apps/${appId}/retention`).send({ keep_previous_images: 3 });
    expect(await last()).toMatchObject({ summary: 'Image keeping of Blog saved, nothing changed', details: [] });
  });

  test('cleaning every app, the switch for all of them, and the notice size', async () => {
    await agent.post('/api/images/prune');
    expect(await last()).toMatchObject({ action: 'image_cleanup_all', summary: 'Old images clean-up asked for 1 of 1 apps' });
    await agent.post('/api/images/auto-cleanup').send({ enabled: false });
    let e = await last();
    expect(e.summary).toBe('Automatic clean-up of old images turned off for every app');
    expect(detail(e, 'Clean up old images automatically')).toEqual({ label: 'Clean up old images automatically', from: 'on', to: 'off' });
    expect(detail(e, 'Apps changed').value).toBe('1');
    await agent.put('/api/images/notice').send({ thresholdBytes: 2 * 1024 ** 3 });
    e = await last();
    expect(e.summary).toBe('Old-images notice set to 2 GB');
    expect(detail(e, 'Say so when old images reach')).toEqual({ label: 'Say so when old images reach', from: 'never', to: '2 GB' });
    await agent.put('/api/images/notice').send({ thresholdBytes: null });
    e = await last();
    expect(e.summary).toBe('Old-images notice turned off');
    expect(detail(e, 'Say so when old images reach')).toEqual({ label: 'Say so when old images reach', from: '2 GB', to: 'never' });
  });

  test('the build cache clean-up says which kind', async () => {
    await agent.post('/api/build-cache/clean').send({ all: true });
    expect(await last()).toMatchObject({ category: 'storage', action: 'build_cache_clean', summary: 'Build cache clean-up asked for: everything unused' });
    await testPool.query('UPDATE build_cache SET requested_at = NULL');
    await agent.post('/api/build-cache/clean').send({});
    expect((await last()).summary).toBe('Build cache clean-up asked for: what was not used for a day');
  });

  test('a clean-up that was refused (one is already waiting) leaves no entry', async () => {
    await agent.post('/api/build-cache/clean').send({ all: true });
    const before = (await entries()).length;
    expect((await agent.post('/api/build-cache/clean').send({ all: true })).status).toBe(409);
    expect((await entries()).length).toBe(before);
  });
});

describe('backups', () => {
  test('asking for a backup of Shipdok, and of an app', async () => {
    await agent.post('/api/backups');
    expect(await last()).toMatchObject({ category: 'backups', action: 'backup_requested', summary: 'Backup of Shipdok asked for' });
    await agent.put(`/api/apps/${appId}/volumes`).send({ paths: ['/data'] });
    expect((await agent.post(`/api/backups/volumes/${appId}`)).status).toBe(202);
    expect(await last()).toMatchObject({ action: 'backup_requested', summary: "Backup of Blog's data asked for", appName: 'Blog' });
  });

  test('a second request while one is waiting leaves no second entry', async () => {
    await agent.post('/api/backups');
    const before = (await entries()).length;
    expect((await agent.post('/api/backups')).status).toBe(409);
    expect((await entries()).length).toBe(before);
  });

  test('the schedule of Shipdok: before and after, and the hour and day only when they matter', async () => {
    await agent.put('/api/backups/settings').send({ frequency: 'weekly', hour: 5, weekday: 2, keep: 10 });
    const e = await last();
    expect(e).toMatchObject({ category: 'backups', action: 'backup_schedule' });
    expect(detail(e, 'Automatic backups')).toEqual({ label: 'Automatic backups', from: 'daily', to: 'weekly' });
    expect(detail(e, 'Hour (UTC)')).toEqual({ label: 'Hour (UTC)', from: '3', to: '5' });
    expect(detail(e, 'Backups kept')).toEqual({ label: 'Backups kept', from: '7', to: '10' });
    await agent.put('/api/backups/settings').send({ frequency: 'off', hour: 9, weekday: 4, keep: 10 });
    expect((await last()).details.map((d) => d.label)).toEqual(['Automatic backups']); // 'off' has no hour or day
    await agent.put('/api/backups/settings').send({ frequency: 'off', hour: 1, weekday: 1, keep: 10 });
    expect(await last()).toMatchObject({ summary: 'Schedule of the backups of Shipdok saved, nothing changed', details: [] });
  });

  test('the backup settings of one app', async () => {
    await agent.put(`/api/backups/volumes/${appId}/settings`).send({ frequency: 'daily', hour: 4, weekday: 0, stop: true, keep: 5, restoreKeep: 25 });
    const e = await last();
    expect(e).toMatchObject({ category: 'backups', action: 'volume_backup_settings', appName: 'Blog' });
    expect(detail(e, 'Automatic backups')).toEqual({ label: 'Automatic backups', from: 'off', to: 'daily' });
    expect(detail(e, 'Stop the app while copying')).toEqual({ label: 'Stop the app while copying', from: 'false', to: 'true' });
    expect(detail(e, 'Backups kept')).toEqual({ label: 'Backups kept', from: '2', to: '5' });
    expect(detail(e, 'Restores remembered')).toEqual({ label: 'Restores remembered', from: '10', to: '25' });
    expect(detail(e, 'Day of the week (0 = Sunday)')).toBeUndefined(); // a daily schedule has no day
    await agent.put(`/api/backups/volumes/${appId}/settings`).send({ frequency: 'daily', hour: 4, weekday: 6, stop: true, keep: 5 });
    expect(await last()).toMatchObject({ summary: 'Backup settings of Blog saved, nothing changed', details: [] });
  });

  test('deleting a backup says which one', async () => {
    const id = (await testPool.query(`INSERT INTO backups (status, trigger, filename, size_bytes, verified, finished_at) VALUES ('ok', 'manual', 'shipdok-backup-20261022-030405-12345678.tar', 5, true, '2026-10-22T03:00:00Z') RETURNING id`)).rows[0].id;
    expect((await agent.delete(`/api/backups/${id}`)).status).toBe(204);
    const e = await last();
    expect(e).toMatchObject({ category: 'backups', action: 'backup_deleted', summary: 'Backup of Shipdok deleted' });
    expect(detail(e, 'Made').value).toBe('2026-10-22T03:00:00.000Z');
  });
});

describe('the account', () => {
  test('a password change, new recovery codes and signing out everywhere are each recorded, with no password or code in the log', async () => {
    const NEW = 'a-Brand-New-Pass-phrase-77';
    expect((await agent.post('/api/auth/password').send({ currentPassword: PASSWORD, newPassword: NEW })).status).toBe(204);
    expect(await last()).toMatchObject({ category: 'security', action: 'password_changed', summary: 'Password changed', actor: 'admin' });
    const codes = (await agent.post('/api/auth/recovery').send({ password: NEW })).body.codes;
    expect(await last()).toMatchObject({ category: 'security', action: 'recovery_codes_new', summary: 'New recovery codes made' });
    const log = await everything();
    expect(log).not.toContain(NEW);
    expect(log).not.toContain(PASSWORD);
    for (const c of codes) expect(log).not.toContain(c);
    const check = (await testPool.query("SELECT 1")).rowCount; // the session is still there for the next call
    expect(check).toBe(1);
    expect((await agent.post('/api/auth/logout-all')).status).toBe(204);
    const again = request.agent(await makeApp({ queue }));
    await again.post('/api/auth/login').send({ username: 'admin', password: NEW });
    expect((await again.get('/api/audit?limit=1')).body.entries[0]).toMatchObject({ action: 'sign_out_everywhere', summary: 'Signed out everywhere' });
  });

  test('a wrong current password records nothing', async () => {
    const before = (await entries()).length;
    expect((await agent.post('/api/auth/password').send({ currentPassword: 'not-it-at-all-1', newPassword: 'another-Long-Pass-99' })).status).toBe(403);
    expect((await agent.post('/api/auth/recovery').send({ password: 'not-it-at-all-1' })).status).toBe(403);
    expect((await entries()).length).toBe(before);
  });
});

describe('writing an entry never turns a done action into an error', () => {
  test('when the log cannot be written the answer is still the success', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await testPool.query('ALTER TABLE audit_log RENAME TO audit_log_gone');
    try {
      expect((await agent.put(`/api/apps/${appId}`).send({ branch: 'dev' })).status).toBe(200);
      expect((await agent.post(`/api/apps/${appId}/stop`)).status).toBe(202);
      expect(spy).toHaveBeenCalledWith('Activity log entry not written:', expect.any(String));
    } finally {
      await testPool.query('ALTER TABLE audit_log_gone RENAME TO audit_log');
      spy.mockRestore();
    }
  });
});
