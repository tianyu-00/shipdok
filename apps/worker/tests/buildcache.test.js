// The build cache: measuring it, cleaning it on request, and what is recorded. The database is real; Docker is a stand-in.
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/db.js';
import { buildCacheUsage, pruneBuildCache } from '../src/docker.js';
import { cleanBuildCache, sampleBuildCache, processCleanCacheJob, createCacheSampler, UNUSED_FOR_HOURS } from '../src/buildcache.js';
import { pool, ready } from './helpers.js';

before(ready);
beforeEach(() => pool.query('TRUNCATE build_cache'));
after(() => pool.end());

const noLog = () => {};
const row = async () => (await pool.query('SELECT * FROM build_cache WHERE id = 1')).rows[0];

// A Docker whose build cache is `records` and which frees `frees` bytes when asked.
function fakeEngine({ records = [], frees = 0, fail = null, noReport = false } = {}) {
  const eng = {
    pruned: [],
    async buildCacheUsage() { return noReport ? null : buildCacheUsage({ docker: { df: async () => ({ BuildCache: records }) } }); },
    async pruneBuildCache(opts) {
      eng.pruned.push(opts);
      if (fail) throw new Error(fail);
      records.splice(0, records.length, ...records.filter((r) => r.InUse)); // what is in use stays
      return { freedBytes: frees };
    },
  };
  return eng;
}

describe('the size', () => {
  test('adds up the cache and counts what no build is using as reclaimable', async () => {
    const usage = await buildCacheUsage({ docker: { df: async () => ({ BuildCache: [{ Size: 100, InUse: false }, { Size: 50, InUse: true }, { Size: '25', InUse: false }] }) } });
    assert.deepEqual(usage, { totalBytes: 175, reclaimableBytes: 125 });
  });

  test('a Docker that does not report build cache gives null, not zero', async () => {
    assert.equal(await buildCacheUsage({ docker: { df: async () => ({ LayersSize: 1 }) } }), null);
  });

  test('a measurement is stored, and a Docker that cannot report stores nothing', async () => {
    assert.equal(await sampleBuildCache({ eng: fakeEngine({ records: [{ Size: 10, InUse: false }] }), db: store, log: noLog }), true);
    const r = await row();
    assert.deepEqual([Number(r.total_bytes), Number(r.reclaimable_bytes), r.sampled_at instanceof Date], [10, 10, true]);
    await pool.query('TRUNCATE build_cache');
    assert.equal(await sampleBuildCache({ eng: fakeEngine({ noReport: true }), db: store, log: noLog }), false);
    assert.equal(await row(), undefined);
  });

  test('the sampler takes one look when it starts, and keeps going after a failure', async () => {
    let calls = 0;
    const eng = { buildCacheUsage: async () => { calls++; if (calls === 1) throw new Error('docker busy'); return { totalBytes: 1, reclaimableBytes: 1 }; } };
    const sampler = createCacheSampler({ eng, db: store, intervalMs: 5, log: noLog });
    sampler.start();
    for (let i = 0; i < 100 && calls < 2; i++) await new Promise((r) => setTimeout(r, 10));
    await sampler.stop();
    assert.ok(calls >= 2, 'a failed look does not end the loop');
    assert.equal(Number((await row()).total_bytes), 1);
  });
});

describe('cleaning', () => {
  test('the default keeps what was used in the last day', async () => {
    const eng = fakeEngine({ frees: 5 });
    await cleanBuildCache({}, { eng, db: store, log: noLog });
    assert.deepEqual(eng.pruned, [{ olderThanHours: UNUSED_FOR_HOURS }]);
    assert.equal(UNUSED_FOR_HOURS, 24);
  });

  test('"all" removes every unused entry (no age)', async () => {
    const eng = fakeEngine();
    await cleanBuildCache({ all: true }, { eng, db: store, log: noLog });
    assert.deepEqual(eng.pruned, [{ olderThanHours: null }]);
  });

  test('the result is recorded, the request ends, and the size is measured again', async () => {
    await pool.query(`INSERT INTO build_cache (id, requested_at, requested_all) VALUES (1, now(), true)`);
    const records = [{ Size: 100, InUse: false }, { Size: 40, InUse: true }];
    const result = await cleanBuildCache({ all: true }, { eng: fakeEngine({ records, frees: 100 }), db: store, log: noLog });
    assert.deepEqual(result, { ok: true, freedBytes: 100 });
    const r = await row();
    assert.equal(r.requested_at, null);
    assert.deepEqual([r.last_all, Number(r.last_freed_bytes), r.last_error], [true, 100, null]);
    assert.ok(r.last_run_at instanceof Date);
    assert.deepEqual([Number(r.total_bytes), Number(r.reclaimable_bytes)], [40, 0]); // only what a build holds is left
  });

  test('a failure is recorded with its reason, ends the request, and the job fails', async () => {
    await pool.query(`INSERT INTO build_cache (id, requested_at) VALUES (1, now())`);
    await assert.rejects(cleanBuildCache({}, { eng: fakeEngine({ fail: 'daemon said no' }), db: store, log: noLog }), /daemon said no/);
    const r = await row();
    assert.deepEqual([r.requested_at, r.last_error, Number(r.last_freed_bytes)], [null, 'daemon said no', 0]);
  });

  test('a failed measurement afterwards does not turn a good clean-up into a failure', async () => {
    const eng = fakeEngine({ frees: 7 });
    eng.buildCacheUsage = async () => { throw new Error('df failed'); };
    assert.deepEqual(await cleanBuildCache({}, { eng, db: store, log: noLog }), { ok: true, freedBytes: 7 });
    assert.equal((await row()).last_error, null);
  });

  test('the job reads "all" strictly: only true means everything', async () => {
    for (const [all, expected] of [[true, null], [false, UNUSED_FOR_HOURS], ['true', UNUSED_FOR_HOURS], [undefined, UNUSED_FOR_HOURS]]) {
      const eng = fakeEngine();
      await processCleanCacheJob({ id: '1', data: { all } }, { eng, db: store });
      assert.deepEqual(eng.pruned, [{ olderThanHours: expected }], `all=${String(all)}`);
    }
  });
});

describe('the Docker call', () => {
  const fakeDocker = (answer = { SpaceReclaimed: 1234 }) => {
    const dials = [];
    return { dials, modem: { dial: (opts, cb) => { dials.push(opts); cb(null, answer); } } };
  };

  test('asks for all unused entries and, for the default, only those older than the age', async () => {
    const d = fakeDocker();
    assert.deepEqual(await pruneBuildCache({ olderThanHours: 24 }, { docker: d }), { freedBytes: 1234 });
    assert.equal(d.dials[0].path, '/build/prune?');
    assert.equal(d.dials[0].method, 'POST');
    assert.deepEqual(d.dials[0].options, { all: 1, filters: JSON.stringify({ until: ['24h'] }) });
  });

  test('without an age there is no filter', async () => {
    const d = fakeDocker({});
    assert.deepEqual(await pruneBuildCache({}, { docker: d }), { freedBytes: 0 });
    assert.deepEqual(d.dials[0].options, { all: 1 });
  });

  test('a bad age is refused before Docker is asked', async () => {
    const d = fakeDocker();
    for (const bad of [0, -1, 1.5, '24', NaN]) await assert.rejects(pruneBuildCache({ olderThanHours: bad }, { docker: d }), /whole number of hours/);
    assert.equal(d.dials.length, 0);
  });

  test('an error from Docker comes through', async () => {
    const d = { modem: { dial: (opts, cb) => cb(new Error('no buildkit')) } };
    await assert.rejects(pruneBuildCache({}, { docker: d }), /no buildkit/);
  });
});
