// Persistent storage on the worker's side: what happens to the volumes when an app is deleted (keep or delete), and deleting one volume.
// The database is real; Docker is a stand-in that records what it is asked.
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../src/db.js';
import { deleteApp, processDeleteJob } from '../src/deleteapp.js';
import { removeVolume, processRemoveVolumeJob } from '../src/removevolume.js';
import { pool, ready, reset, makeApp } from './helpers.js';

before(ready);
beforeEach(async () => { await reset(); await pool.query('TRUNCATE app_volumes'); });
after(() => pool.end());

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'vols-')); });
after(() => rmSync(root, { recursive: true, force: true }));

const noLog = () => {};
const mark = (appId) => pool.query('UPDATE apps SET deleting_at = now() WHERE id = $1', [appId]);
const vol = async (appId, path, state = 'in_use') => (await pool.query(
  `INSERT INTO app_volumes (app_id, app_name, container_path, docker_name, state) VALUES ($1, 'Old name', $2, $3, $4) RETURNING *`,
  [appId, path, `shipdok-vol-${randomUUID()}`, state])).rows[0];
const allRows = async () => (await pool.query('SELECT * FROM app_volumes ORDER BY container_path')).rows;
const appExists = async (id) => (await pool.query('SELECT 1 FROM apps WHERE id = $1', [id])).rows.length === 1;

// Docker: containers first, then volumes. `inUse` names answer 'in-use'; `gone` names answer 'gone'.
function fakeDocker({ containers = [], inUse = [], gone = [], foreign = [] } = {}) {
  const events = [];
  return {
    events,
    async findAppContainers() { return containers.map((name) => ({ name })); },
    async stopContainer() {},
    async removeContainerStrict(c) { events.push(`rm container ${c.name}`); return 'removed'; },
    async listAppImages() { return []; },
    async removeImageStrict() { return 'removed'; },
    async removeVolumeStrict(name) {
      events.push(`rm volume ${name}`);
      if (foreign.includes(name)) throw new Error('That volume does not belong to Shipdok');
      if (inUse.includes(name)) return 'in-use';
      if (gone.includes(name)) return 'gone';
      return 'removed';
    },
  };
}
const del = (appId, eng, extra = {}) => deleteApp({ appId, ...extra }, { eng, db: store, logRoot: root, log: noLog });

describe('deleting an app and KEEPING its data (the default)', () => {
  test('every volume of the app, mounted or detached, becomes orphaned (kept, remembered by the app\'s name); Docker is not asked to remove any', async () => {
    const a = await makeApp();
    await pool.query("UPDATE apps SET name = 'Shop' WHERE id = $1", [a]);
    await vol(a, '/data');
    await vol(a, '/old', 'detached');
    await mark(a);
    const eng = fakeDocker({ containers: ['live'] });
    await del(a, eng);
    assert.ok(!eng.events.some((e) => e.startsWith('rm volume')), 'no volume is removed');
    const rows = await allRows();
    assert.deepEqual(rows.map((r) => [r.container_path, r.state, r.app_id, r.app_name]), [['/data', 'orphaned', null, 'Shop'], ['/old', 'orphaned', null, 'Shop']]);
    assert.equal(await appExists(a), false);
  });

  test('another app\'s volumes are not touched', async () => {
    const a = await makeApp(); const b = await makeApp();
    await vol(a, '/data'); const other = await vol(b, '/keep');
    await mark(a);
    await del(a, fakeDocker());
    const still = (await allRows()).find((r) => r.id === other.id);
    assert.deepEqual([still.state, still.app_id], ['in_use', b]);
  });
});

describe('deleting an app AND its data (only when asked)', () => {
  test('the Docker volumes are removed AFTER the containers, then their records; nothing is left', async () => {
    const a = await makeApp();
    const v1 = await vol(a, '/data'); const v2 = await vol(a, '/old', 'detached');
    await mark(a);
    const eng = fakeDocker({ containers: ['live'] });
    await del(a, eng, { deleteVolumes: true });
    const order = eng.events;
    assert.ok(order.indexOf('rm container live') < order.indexOf(`rm volume ${v1.docker_name}`), 'a container is gone before its volume is removed');
    assert.deepEqual(order.filter((e) => e.startsWith('rm volume')).sort(), [`rm volume ${v1.docker_name}`, `rm volume ${v2.docker_name}`].sort());
    assert.equal((await allRows()).length, 0);
    assert.equal(await appExists(a), false);
  });

  test('a volume that Docker no longer has is not a problem', async () => {
    const a = await makeApp(); const v = await vol(a, '/data');
    await mark(a);
    await del(a, fakeDocker({ gone: [v.docker_name] }), { deleteVolumes: true });
    assert.equal((await allRows()).length, 0);
  });

  test('a volume still used by something stops the deletion: the app stays, marked, with the reason, and a retry finishes it', async () => {
    const a = await makeApp(); const v = await vol(a, '/data');
    await mark(a);
    await assert.rejects(del(a, fakeDocker({ inUse: [v.docker_name] }), { deleteVolumes: true }), /still used/i);
    assert.equal(await appExists(a), true);
    assert.equal((await allRows()).length, 1);
    assert.match((await pool.query('SELECT delete_error FROM apps WHERE id = $1', [a])).rows[0].delete_error, /still used/i);
    await del(a, fakeDocker(), { deleteVolumes: true });
    assert.equal(await appExists(a), false);
    assert.equal((await allRows()).length, 0);
  });

  test('a volume that is not Shipdok\'s is refused by the engine and nothing else is lost', async () => {
    const a = await makeApp(); const v = await vol(a, '/data');
    await mark(a);
    await assert.rejects(del(a, fakeDocker({ foreign: [v.docker_name] }), { deleteVolumes: true }), /does not belong/i);
    assert.equal(await appExists(a), true);
  });
});

describe('the delete job', () => {
  const job = (data) => ({ id: '1', data, log: async () => {} });
  test('passes the choice on, and the choice must be a real true or false', async () => {
    const a = await makeApp(); const v = await vol(a, '/data');
    await mark(a);
    const eng = fakeDocker();
    await processDeleteJob(job({ appId: a, deleteVolumes: true }), { eng, db: store, logRoot: root });
    assert.ok(eng.events.includes(`rm volume ${v.docker_name}`));
    const b = await makeApp(); await mark(b);
    for (const bad of ['yes', 1, null]) {
      await assert.rejects(processDeleteJob(job({ appId: b, deleteVolumes: bad }), { eng: fakeDocker(), db: store, logRoot: root }), /deleteVolumes/);
    }
    assert.equal(await appExists(b), true);
  });

  test('a job from before this existed (no choice) keeps the data', async () => {
    const a = await makeApp(); await vol(a, '/data'); await mark(a);
    const eng = fakeDocker();
    await processDeleteJob(job({ appId: a }), { eng, db: store, logRoot: root });
    assert.ok(!eng.events.some((e) => e.startsWith('rm volume')));
    assert.equal((await allRows())[0].state, 'orphaned');
  });
});

describe('deleting one volume', () => {
  const rm = (volumeId, eng) => removeVolume({ volumeId }, { eng, db: store, log: noLog });

  test('a detached volume is removed from Docker and its record goes', async () => {
    const a = await makeApp(); const v = await vol(a, '/old', 'detached');
    const eng = fakeDocker();
    assert.deepEqual(await rm(v.id, eng), { ok: true, removed: true });
    assert.deepEqual(eng.events, [`rm volume ${v.docker_name}`]);
    assert.equal((await allRows()).length, 0);
  });

  test('an orphaned volume (its app is gone) too', async () => {
    const v = await vol(null, '/files', 'orphaned');
    await rm(v.id, fakeDocker());
    assert.equal((await allRows()).length, 0);
  });

  test('a volume that is mounted is NEVER removed, whatever the request says', async () => {
    const a = await makeApp(); const v = await vol(a, '/data');
    const eng = fakeDocker();
    await assert.rejects(rm(v.id, eng), /mounted/i);
    assert.deepEqual(eng.events, []);
    assert.equal((await allRows()).length, 1);
  });

  test('Docker says it is in use: the reason is kept on the record, the record stays, and the job fails', async () => {
    const a = await makeApp(); const v = await vol(a, '/old', 'detached');
    await assert.rejects(rm(v.id, fakeDocker({ inUse: [v.docker_name] })), /still uses/i);
    const [row] = await allRows();
    assert.match(row.remove_error, /still uses/i);
  });

  test('a volume Docker no longer has: the record goes, no error', async () => {
    const a = await makeApp(); const v = await vol(a, '/old', 'detached');
    await rm(v.id, fakeDocker({ gone: [v.docker_name] }));
    assert.equal((await allRows()).length, 0);
  });

  test('a record that is already gone is not an error', async () => {
    assert.deepEqual(await rm(randomUUID(), fakeDocker()), { ok: true, skipped: true });
  });

  test('the job needs a real id', async () => {
    await assert.rejects(processRemoveVolumeJob({ id: '1', data: { volumeId: 'x' }, log: async () => {} }, { eng: fakeDocker(), db: store }), /volume id/i);
  });

  test('a later success clears an earlier failure message', async () => {
    const a = await makeApp(); const v = await vol(a, '/old', 'detached');
    await assert.rejects(rm(v.id, fakeDocker({ inUse: [v.docker_name] })));
    await rm(v.id, fakeDocker());
    assert.equal((await allRows()).length, 0);
  });
});
