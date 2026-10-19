// CPU and memory of running apps: turning Docker's numbers into ours, and the sampler that stores them.
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStats } from '../src/docker.js';
import { createSampler } from '../src/stats.js';
import * as store from '../src/db.js';
import { pool, ready, reset, makeApp } from './helpers.js';

const MB = 1024 * 1024;

// The shape Docker returns (cgroup v2 on a 4-cpu host), with the sample before this one in precpu_stats.
const v2 = (over = {}) => ({
  cpu_stats: { cpu_usage: { total_usage: 2_000_000_000 }, system_cpu_usage: 40_000_000_000, online_cpus: 4 },
  precpu_stats: { cpu_usage: { total_usage: 1_900_000_000 }, system_cpu_usage: 39_000_000_000, online_cpus: 4 },
  memory_stats: { usage: 150 * MB, limit: 512 * MB, stats: { inactive_file: 50 * MB, anon: 90 * MB } },
  ...over,
});

describe('normalizeStats', () => {
  test('CPU is the share of one cpu: 100 ms of cpu in 1 s of four cpus is 10%', () => {
    assert.equal(normalizeStats(v2()).cpuPercent, 40); // 0.1e9 / 1e9 * 4 cpus * 100
  });
  test('memory leaves out the file cache the kernel can take back (cgroup v2)', () => {
    const s = normalizeStats(v2());
    assert.deepEqual([s.memoryBytes, s.memoryLimitBytes], [100 * MB, 512 * MB]);
  });
  test('and the same for cgroup v1\'s name for it', () => {
    const s = normalizeStats(v2({ memory_stats: { usage: 150 * MB, limit: 512 * MB, stats: { total_inactive_file: 20 * MB } } }));
    assert.equal(s.memoryBytes, 130 * MB);
  });
  test('no cache figure at all: the usage as it is', () => {
    assert.equal(normalizeStats(v2({ memory_stats: { usage: 77 * MB, limit: 512 * MB } })).memoryBytes, 77 * MB);
  });
  test('the cache can never make the figure negative', () => {
    assert.equal(normalizeStats(v2({ memory_stats: { usage: 10 * MB, limit: 512 * MB, stats: { inactive_file: 50 * MB } } })).memoryBytes, 0);
  });
  test('rounds CPU to one decimal', () => {
    const s = normalizeStats(v2({ cpu_stats: { cpu_usage: { total_usage: 2_023_456_789 }, system_cpu_usage: 40_000_000_000, online_cpus: 4 } }));
    assert.equal(s.cpuPercent, 49.4); // 123456789 / 1e9 * 4 cpus * 100 = 49.38
  });
  test('without an earlier sample there is no CPU figure (not 0, not a guess)', () => {
    assert.equal(normalizeStats(v2({ precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 } })).cpuPercent, null);
    assert.equal(normalizeStats(v2({ precpu_stats: undefined })).cpuPercent, null);
  });
  test('no time passed between the samples: no CPU figure instead of a division by zero', () => {
    const same = v2({ precpu_stats: { cpu_usage: { total_usage: 1_900_000_000 }, system_cpu_usage: 40_000_000_000 } });
    assert.equal(normalizeStats(same).cpuPercent, null);
  });
  test('a counter that went backwards (the container restarted) gives no CPU figure', () => {
    assert.equal(normalizeStats(v2({ precpu_stats: { cpu_usage: { total_usage: 9_000_000_000 }, system_cpu_usage: 39_000_000_000 } })).cpuPercent, null);
  });
  test('uses the number of cpus Docker reports, or the per-cpu list on an older Docker, or one', () => {
    const base = { cpu_usage: { total_usage: 2_000_000_000 }, system_cpu_usage: 40_000_000_000 };
    assert.equal(normalizeStats(v2({ cpu_stats: { ...base, online_cpus: 2 } })).cpuPercent, 20);
    assert.equal(normalizeStats(v2({ cpu_stats: { cpu_usage: { total_usage: 2_000_000_000, percpu_usage: [1, 2, 3] }, system_cpu_usage: 40_000_000_000 } })).cpuPercent, 30);
    assert.equal(normalizeStats(v2({ cpu_stats: base })).cpuPercent, 10);
  });
  test('a missing limit stays missing', () => {
    assert.equal(normalizeStats(v2({ memory_stats: { usage: 5 * MB } })).memoryLimitBytes, null);
    assert.equal(normalizeStats(v2({ memory_stats: { usage: 5 * MB, limit: 0 } })).memoryLimitBytes, null);
  });
  test('an empty answer is zeros and nulls, not an error', () => {
    assert.deepEqual(normalizeStats({}), { cpuPercent: null, memoryBytes: 0, memoryLimitBytes: null });
    assert.deepEqual(normalizeStats(undefined), { cpuPercent: null, memoryBytes: 0, memoryLimitBytes: null });
  });
});

describe('the sampler', () => {
  before(ready);
  beforeEach(reset);
  after(() => pool.end());

  // `running`: app id -> stats of its live container; `stopped`: app ids whose container exists but is not running.
  function fakeDocker({ running = {}, stopped = [], failFor = [] } = {}) {
    return {
      asked: [],
      read: [],
      async findContainers({ appId, role }) {
        this.asked.push([appId, role]);
        return appId in running || stopped.includes(appId) || failFor.includes(appId) ? [{ appId }] : [];
      },
      async isRunning(c) { return !stopped.includes(c.appId); },
      async containerStats(c) {
        this.read.push(c.appId);
        if (failFor.includes(c.appId)) throw new Error('docker said no');
        return running[c.appId];
      },
    };
  }
  const rows = async (appId) => (await pool.query('SELECT * FROM app_stats WHERE app_id = $1 ORDER BY sampled_at', [appId])).rows;
  const sampler = (eng, over = {}) => createSampler({ db: store, eng, log: () => {}, ...over });
  const S = (cpu, mem, limit = 512 * MB) => ({ cpuPercent: cpu, memoryBytes: mem, memoryLimitBytes: limit });

  test('stores one reading per running app, with its own numbers', async () => {
    const a = await makeApp();
    const b = await makeApp();
    await sampler(fakeDocker({ running: { [a]: S(12.5, 100 * MB), [b]: S(null, 5 * MB, null) } })).tick();
    const [ra] = await rows(a);
    const [rb] = await rows(b);
    assert.deepEqual([ra.cpu_percent, Number(ra.memory_bytes), Number(ra.memory_limit_bytes)], [12.5, 100 * MB, 512 * MB]);
    assert.deepEqual([rb.cpu_percent, Number(rb.memory_bytes), rb.memory_limit_bytes], [null, 5 * MB, null]);
  });

  test('asks only for the live container of each app', async () => {
    const a = await makeApp();
    const eng = fakeDocker({ running: { [a]: S(1, MB) } });
    await sampler(eng).tick();
    assert.deepEqual(eng.asked, [[a, 'live']]);
  });

  test('an app that is stopped (by the administrator, or its container is not running), or has nothing deployed, gets no reading', async () => {
    const wantsStopped = await makeApp();
    const exited = await makeApp();
    const nothing = await makeApp();
    await pool.query(`UPDATE apps SET desired_state = 'stopped' WHERE id = $1`, [wantsStopped]);
    const eng = fakeDocker({ running: { [wantsStopped]: S(1, MB) }, stopped: [exited] });
    await sampler(eng).tick();
    for (const id of [wantsStopped, exited, nothing]) assert.equal((await rows(id)).length, 0);
    assert.deepEqual(eng.read, []); // Docker is not even asked for their numbers
  });

  test('an app with nothing deployed yet is quietly skipped (no error in the log)', async () => {
    await makeApp();
    const lines = [];
    await sampler(fakeDocker({}), { log: (l) => lines.push(l) }).tick();
    assert.deepEqual(lines, []);
  });

  test('an app that is being deleted is left alone', async () => {
    const a = await makeApp();
    await pool.query('UPDATE apps SET deleting_at = now() WHERE id = $1', [a]);
    const eng = fakeDocker({ running: { [a]: S(1, MB) } });
    await sampler(eng).tick();
    assert.equal((await rows(a)).length, 0);
    assert.deepEqual(eng.asked, []);
  });

  test('one app failing does not stop the others, and the failure is logged', async () => {
    const bad = await makeApp();
    const good = await makeApp();
    const lines = [];
    await sampler(fakeDocker({ running: { [good]: S(3, MB) }, failFor: [bad] }), { log: (l) => lines.push(l) }).tick();
    assert.equal((await rows(bad)).length, 0);
    assert.equal((await rows(good)).length, 1);
    assert.ok(lines.some((l) => /docker said no/.test(l)));
  });

  test('samples older than the keep time are removed, newer ones stay', async () => {
    const a = await makeApp();
    await pool.query(`INSERT INTO app_stats (app_id, sampled_at, memory_bytes) VALUES ($1, now() - interval '61 minutes', 1), ($1, now() - interval '59 minutes', 2)`, [a]);
    await sampler(fakeDocker({})).tick();
    assert.deepEqual((await rows(a)).map((r) => Number(r.memory_bytes)), [2]);
  });

  test('the keep time is a setting', async () => {
    const a = await makeApp();
    await pool.query(`INSERT INTO app_stats (app_id, sampled_at, memory_bytes) VALUES ($1, now() - interval '5 minutes', 1)`, [a]);
    await sampler(fakeDocker({}), { keepMs: 60_000 }).tick();
    assert.equal((await rows(a)).length, 0);
  });

  test('readings go with the app when it is deleted', async () => {
    const a = await makeApp();
    await sampler(fakeDocker({ running: { [a]: S(1, MB) } })).tick();
    await pool.query('DELETE FROM apps WHERE id = $1', [a]);
    assert.equal((await rows(a)).length, 0);
  });

  test('start() samples straight away and keeps going, stop() ends it', async () => {
    const a = await makeApp();
    const s = sampler(fakeDocker({ running: { [a]: S(1, MB) } }), { intervalMs: 30 });
    s.start();
    await new Promise((r) => setTimeout(r, 120));
    await s.stop();
    const n = (await rows(a)).length;
    assert.ok(n >= 2, `expected several readings, got ${n}`);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal((await rows(a)).length, n); // nothing more after stop
  });

  test('a failing database does not end the loop', async () => {
    const a = await makeApp();
    let calls = 0;
    const flaky = { ...store, listSampleTargets: async () => { calls += 1; if (calls === 1) throw new Error('db hiccup'); return store.listSampleTargets(); } };
    const lines = [];
    const s = createSampler({ db: flaky, eng: fakeDocker({ running: { [a]: S(1, MB) } }), intervalMs: 30, log: (l) => lines.push(l) });
    s.start();
    await new Promise((r) => setTimeout(r, 150));
    await s.stop();
    assert.ok(lines.some((l) => /db hiccup/.test(l)));
    assert.ok((await rows(a)).length >= 1);
  });
});
