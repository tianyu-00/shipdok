// Measuring the persistent volumes: asked for by the administrator (a row the API writes), answered by the worker with one look at Docker.
// The database is real; Docker is a stand-in.
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/db.js';
import { volumeSizes } from '../src/docker.js';
import { measureVolumes, createVolumeMeasurer } from '../src/volumesize.js';
import { pool, ready } from './helpers.js';

before(ready);
beforeEach(() => pool.query('TRUNCATE app_volumes, volume_sizing'));
after(() => pool.end());

const noLog = () => {};
const addVolume = (name, path = '/data', state = 'in_use') =>
  pool.query(`INSERT INTO app_volumes (app_name, container_path, docker_name, state) VALUES ('shop', $1, $2, $3)`, [path, name, state]);
const volumes = async () => Object.fromEntries((await pool.query('SELECT docker_name, size_bytes, measured_at FROM app_volumes')).rows.map((r) => [r.docker_name, { bytes: r.size_bytes === null ? null : Number(r.size_bytes), measured: r.measured_at instanceof Date }]));
const sizing = async () => (await pool.query('SELECT * FROM volume_sizing WHERE id = 1')).rows[0];
const ask = () => pool.query(`INSERT INTO volume_sizing (id, requested_at) VALUES (1, now()) ON CONFLICT (id) DO UPDATE SET requested_at = now()`);
const fakeEngine = ({ sizes = new Map(), fail = null } = {}) => ({
  calls: 0,
  async volumeSizes() { this.calls += 1; if (fail) throw new Error(fail); return sizes; },
});

describe('asking Docker', () => {
  const docker = (reply) => ({ modem: { calls: [], dial(opts, cb) { this.calls.push(opts); cb(null, reply); } } });

  test('one call for volumes only, and a Map of name to bytes', async () => {
    const d = docker({ Volumes: [{ Name: 'shipdok-vol-a', UsageData: { Size: 1200, RefCount: 1 } }, { Name: 'other', UsageData: { Size: 5 } }] });
    const sizes = await volumeSizes({ docker: d });
    assert.deepEqual([...sizes], [['shipdok-vol-a', 1200], ['other', 5]]);
    assert.equal(d.modem.calls.length, 1);
    assert.deepEqual([d.modem.calls[0].path, d.modem.calls[0].method, d.modem.calls[0].options], ['/system/df?', 'GET', { type: 'volume' }]);
  });

  test('a size Docker could not work out (-1), a missing size and a nameless entry are left out, zero is kept', async () => {
    const sizes = await volumeSizes({ docker: docker({ Volumes: [
      { Name: 'unknown', UsageData: { Size: -1 } }, { Name: 'none', UsageData: {} }, { Name: 'nodata' }, { UsageData: { Size: 9 } }, { Name: 'empty', UsageData: { Size: 0 } }, { Name: 'text', UsageData: { Size: '42' } },
    ] }) });
    assert.deepEqual([...sizes], [['empty', 0], ['text', 42]]);
  });

  test('no volumes, or an answer without the list, is an empty Map, not an error', async () => {
    assert.equal((await volumeSizes({ docker: docker({ Volumes: null }) })).size, 0);
    assert.equal((await volumeSizes({ docker: docker({}) })).size, 0);
    assert.equal((await volumeSizes({ docker: docker(undefined) })).size, 0);
  });

  test('Docker refusing is an error to the caller', async () => {
    const d = { modem: { dial: (_o, cb) => cb(new Error('docker down')) } };
    await assert.rejects(volumeSizes({ docker: d }), /docker down/);
  });
});

describe('recording the sizes', () => {
  test('each volume Shipdok keeps gets its size and the time; Docker volumes that are not Shipdok\'s are ignored', async () => {
    await addVolume('shipdok-vol-1', '/data');
    await addVolume('shipdok-vol-2', '/uploads', 'detached');
    await store.recordVolumeSizes(new Map([['shipdok-vol-1', 1000], ['shipdok-vol-2', 0], ['somebody-elses', 99]]));
    assert.deepEqual(await volumes(), { 'shipdok-vol-1': { bytes: 1000, measured: true }, 'shipdok-vol-2': { bytes: 0, measured: true } });
  });

  test('a volume Docker has not created yet (a new path, before its first deployment) is measured as "no size", not left looking unmeasured forever', async () => {
    await addVolume('shipdok-vol-1');
    await store.recordVolumeSizes(new Map());
    assert.deepEqual(await volumes(), { 'shipdok-vol-1': { bytes: null, measured: true } });
  });

  test('a new measurement replaces the old figure', async () => {
    await addVolume('shipdok-vol-1');
    await store.recordVolumeSizes(new Map([['shipdok-vol-1', 10]]));
    await store.recordVolumeSizes(new Map([['shipdok-vol-1', 20]]));
    assert.equal((await volumes())['shipdok-vol-1'].bytes, 20);
  });

  test('a volume whose app is gone (kept on purpose) is measured too', async () => {
    await addVolume('shipdok-vol-9', '/data', 'orphaned');
    await store.recordVolumeSizes(new Map([['shipdok-vol-9', 7]]));
    assert.equal((await volumes())['shipdok-vol-9'].bytes, 7);
  });

  test('nothing to measure is fine', async () => {
    await store.recordVolumeSizes(new Map([['x', 1]]));
    assert.deepEqual(await volumes(), {});
  });
});

describe('a measurement', () => {
  test('records the sizes, ends the request and clears an earlier error', async () => {
    await addVolume('shipdok-vol-1');
    await pool.query(`INSERT INTO volume_sizing (id, requested_at, last_error) VALUES (1, now(), 'old problem')`);
    const r = await measureVolumes({ eng: fakeEngine({ sizes: new Map([['shipdok-vol-1', 123]]) }), db: store, log: noLog });
    assert.deepEqual(r, { ok: true, volumes: 1 });
    assert.equal((await volumes())['shipdok-vol-1'].bytes, 123);
    const s = await sizing();
    assert.equal(s.requested_at, null);
    assert.equal(s.last_error, null);
    assert.ok(s.finished_at instanceof Date);
  });

  test('a Docker that fails: the request ends with a plain reason (never Docker\'s own words), the old sizes stay, and nothing is thrown', async () => {
    await addVolume('shipdok-vol-1');
    await store.recordVolumeSizes(new Map([['shipdok-vol-1', 55]]));
    await ask();
    const lines = [];
    const r = await measureVolumes({ eng: fakeEngine({ fail: 'secret path /var/lib/docker/xyz' }), db: store, log: (l) => lines.push(l) });
    assert.deepEqual(r, { ok: false });
    assert.equal((await volumes())['shipdok-vol-1'].bytes, 55);
    const s = await sizing();
    assert.equal(s.requested_at, null);
    assert.equal(s.last_error, 'Docker could not measure the volumes');
    assert.ok(!s.last_error.includes('/var/lib'));
    assert.ok(lines.some((l) => /failed/.test(l)), 'the worker log has the reason');
  });
});

describe('noticing the request', () => {
  test('no request: Docker is not asked', async () => {
    const eng = fakeEngine();
    const m = createVolumeMeasurer({ eng, db: store, log: noLog });
    assert.equal(await m.tick(), false);
    assert.equal(eng.calls, 0);
  });

  test('a request is answered once, and then it is not asked again', async () => {
    await addVolume('shipdok-vol-1');
    await ask();
    const eng = fakeEngine({ sizes: new Map([['shipdok-vol-1', 5]]) });
    const m = createVolumeMeasurer({ eng, db: store, log: noLog });
    assert.equal(await m.tick(), true);
    assert.equal(await m.tick(), false);
    assert.equal(eng.calls, 1);
    assert.equal((await volumes())['shipdok-vol-1'].bytes, 5);
  });

  test('running: it answers a request that arrives later, and keeps going after a failed look', async () => {
    await addVolume('shipdok-vol-1');
    const eng = fakeEngine({ sizes: new Map([['shipdok-vol-1', 8]]) });
    const m = createVolumeMeasurer({ eng, db: store, intervalMs: 15, log: noLog });
    m.start();
    try {
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(eng.calls, 0);
      await ask();
      for (let i = 0; i < 100 && eng.calls === 0; i += 1) await new Promise((r) => setTimeout(r, 15));
      assert.equal(eng.calls, 1);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(eng.calls, 1, 'one request, one look');
      eng.sizes = undefined;
      eng.volumeSizes = async function () { this.calls += 1; throw new Error('boom'); };
      await ask();
      for (let i = 0; i < 100 && eng.calls < 2; i += 1) await new Promise((r) => setTimeout(r, 15));
      assert.equal(eng.calls, 2);
      assert.equal((await sizing()).last_error, 'Docker could not measure the volumes');
      await ask();
      eng.volumeSizes = async function () { this.calls += 1; return new Map([['shipdok-vol-1', 9]]); };
      for (let i = 0; i < 100 && eng.calls < 3; i += 1) await new Promise((r) => setTimeout(r, 15));
      assert.equal(eng.calls, 3, 'still listening after a failure');
    } finally {
      await m.stop();
    }
  });

  test('stop ends the loop, and start twice does not run two', async () => {
    const eng = fakeEngine();
    const m = createVolumeMeasurer({ eng, db: store, intervalMs: 10, log: noLog });
    m.start();
    m.start();
    await new Promise((r) => setTimeout(r, 30));
    await m.stop();
    await ask();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(eng.calls, 0, 'stopped: the request is left alone');
  });
});
