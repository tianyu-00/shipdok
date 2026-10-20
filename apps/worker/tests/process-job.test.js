import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/db.js';
import { processDeployJob } from '../src/process-job.js';
import {
  pool, KEY, OTHER_KEY, SECRET, ready, reset, makeApp, addVar, makeDeployment, getDeployment, versionsOf,
} from './helpers.js';

before(ready);
beforeEach(reset);
after(() => pool.end());

// ---- stand-ins for the Docker-backed deploy step ----
const done = (opts, extra = {}) => ({ ok: true, deploymentId: opts.deploymentId, image: `shipdok/${opts.slug}:${opts.deploymentId}`, ...extra });

function fakeDeploy({ ok = true, error = 'boom', hooks = [] } = {}) {
  const fn = async (opts) => {
    fn.calls.push(opts);
    for (const [name, arg] of hooks) opts[name](arg);
    await new Promise((r) => setImmediate(r)); // let best-effort hook writes land
    return ok ? done(opts) : { ok: false, deploymentId: opts.deploymentId, image: 'x', error };
  };
  fn.calls = [];
  return fn;
}

// Behaves like deploy(): runs until the signal fires, then reports a stop.
const hangUntilAbort = (opts, onStart) => new Promise((resolve) => {
  onStart?.();
  opts.signal.addEventListener('abort', () => resolve({ ok: false, stopped: true, deploymentId: opts.deploymentId, image: 'x' }), { once: true });
});

// Behaves like deploy() at the gate: asks beforeSwap, then stops or completes.
const gated = (after) => async (opts) => {
  const gate = await opts.beforeSwap();
  if (!gate.proceed) return { ok: false, stopped: true, outcome: gate.outcome, by: gate.by, deploymentId: opts.deploymentId, image: 'x' };
  await after?.(opts);
  return done(opts);
};

const fakeJob = (data) => ({ id: '7', data, logs: [], async log(m) { this.logs.push(m); } });
const jobFor = (appId, deploymentId) => fakeJob({
  deploymentId, appId, slug: 'my-app', repo: 'https://github.com/o/r.git', ref: 'main', dir: '.',
  containerPort: 3000, hostPort: 8080,
});
const dbWith = (over) => ({ ...store, ...over });
const flag = (id, status, by = null) =>
  pool.query('UPDATE deployments SET cancel_status = $2, superseded_by = $3 WHERE id = $1', [id, status, by]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = { timeout: 15000 };

describe('the build time limit reaches the deploy step', () => {
  test('the limit in the job is handed on, and its absence means no limit', async () => {
    const appId = await makeApp();
    const withLimit = fakeDeploy();
    await processDeployJob(fakeJob({ ...jobFor(appId, await makeDeployment(appId)).data, buildTimeoutMinutes: 45 }), { secretsKey: KEY, deployFn: withLimit });
    assert.equal(withLimit.calls[0].buildTimeoutMinutes, 45);
    const without = fakeDeploy();
    await processDeployJob(jobFor(appId, await makeDeployment(appId)), { secretsKey: KEY, deployFn: without });
    assert.equal(without.calls[0].buildTimeoutMinutes, undefined);
  });

  test('a build that ran out of time is recorded as a failed deployment with the reason', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    const msg = 'The build took longer than 5 minutes and was stopped (the limit is a setting of the app)';
    await assert.rejects(processDeployJob(jobFor(appId, depId), { secretsKey: KEY, deployFn: fakeDeploy({ ok: false, error: msg }) }));
    const d = await getDeployment(depId);
    assert.equal(d.status, 'failed');
    assert.equal(d.error_summary, msg);
  });
});

describe('a successful job', () => {
  test('passes the decrypted variables to the deploy step and records success', async () => {
    const appId = await makeApp();
    await addVar(appId, 'DATABASE_URL', 'postgres://u:p@h/db');
    await addVar(appId, 'API_KEY', SECRET);
    const depId = await makeDeployment(appId);
    const deployFn = fakeDeploy({ hooks: [['onStatus', 'starting'], ['onCommit', 'abc123']] });

    const out = await processDeployJob(jobFor(appId, depId), { secretsKey: KEY, deployFn });

    assert.deepEqual(deployFn.calls[0].env, ['API_KEY=' + SECRET, 'DATABASE_URL=postgres://u:p@h/db']);
    assert.equal(out.deploymentId, depId);
    const row = await getDeployment(depId);
    assert.equal(row.status, 'successful');
    assert.equal(row.image_ref, `shipdok/my-app:${depId}`);
    assert.equal(row.commit_sha, 'abc123');
    assert.ok(row.started_at && row.finished_at);
  });

  test('records the variable versions actually used, replacing a stale queue-time snapshot', async () => {
    const appId = await makeApp();
    await addVar(appId, 'A', '1');
    await addVar(appId, 'B', '2');
    const depId = await makeDeployment(appId, { branch: 'main', env: { A: '1', GONE: '2' } });
    await processDeployJob(jobFor(appId, depId), { secretsKey: KEY, deployFn: fakeDeploy() });
    const snap = (await getDeployment(depId)).config_snapshot;
    assert.deepEqual(snap.env, await versionsOf(appId));
    assert.equal(snap.branch, 'main');
  });

  test('an app with no variables deploys with an empty environment', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    const deployFn = fakeDeploy();
    await processDeployJob(jobFor(appId, depId), { secretsKey: KEY, deployFn });
    assert.deepEqual(deployFn.calls[0].env, []);
    assert.deepEqual((await getDeployment(depId)).config_snapshot.env, {});
  });

  test('values never appear in the snapshot, the logs or the job result', async () => {
    const appId = await makeApp();
    await addVar(appId, 'API_KEY', SECRET);
    const depId = await makeDeployment(appId);
    const seen = [];
    const original = console.log;
    console.log = (...a) => seen.push(a.join(' '));
    const job = jobFor(appId, depId);
    let out;
    try {
      out = await processDeployJob(job, { secretsKey: KEY, deployFn: fakeDeploy() });
    } finally {
      console.log = original;
    }
    assert.ok(!JSON.stringify(await getDeployment(depId)).includes(SECRET));
    assert.ok(![...seen, ...job.logs, JSON.stringify(out), JSON.stringify(job.data)].join('\n').includes(SECRET));
  });
});

describe('progress reporting', () => {
  test('progress writes are applied in order and finish before the final status, even when the database is slow and uneven', T, async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    const order = [];
    const jitter = () => sleep(Math.random() * 40);
    const db = dbWith({
      setStatus: async (id, s) => { await jitter(); order.push(`status:${s}`); return store.setStatus(id, s); },
      setCommit: async (id, sha) => { await jitter(); order.push(`commit:${sha}`); return store.setCommit(id, sha); },
      markSucceeded: async (id, img) => { order.push('final'); return store.markSucceeded(id, img); },
    });
    const deployFn = fakeDeploy({ hooks: [['onCommit', 'abc123'], ['onStatus', 'starting'], ['onStatus', 'validating']] });
    await processDeployJob(jobFor(appId, depId), { secretsKey: KEY, deployFn, db });

    assert.deepEqual(order, ['commit:abc123', 'status:starting', 'status:validating', 'final']);
    const row = await getDeployment(depId);
    assert.deepEqual([row.status, row.commit_sha], ['successful', 'abc123']);
  });

  test('a failing progress write is tolerated and later ones still run', T, async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    let calls = 0;
    const db = dbWith({ setStatus: async (id, s) => { if (++calls === 1) throw new Error('blip'); return store.setStatus(id, s); } });
    const deployFn = fakeDeploy({ hooks: [['onStatus', 'starting'], ['onCommit', 'abc123']] });
    const original = console.error;
    console.error = () => {};
    try { await processDeployJob(jobFor(appId, depId), { secretsKey: KEY, deployFn, db }); } finally { console.error = original; }
    const row = await getDeployment(depId);
    assert.deepEqual([row.status, row.commit_sha], ['successful', 'abc123']);
  });
});

describe('exact commits', () => {
  test('the commit in the job reaches the deploy step', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    const deployFn = fakeDeploy();
    const job = jobFor(appId, depId);
    job.data.commit = 'f'.repeat(40);
    await processDeployJob(job, { secretsKey: KEY, deployFn });
    assert.equal(deployFn.calls[0].commit, 'f'.repeat(40));
  });

  test('a job without a commit still builds the branch head', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    const deployFn = fakeDeploy();
    await processDeployJob(jobFor(appId, depId), { secretsKey: KEY, deployFn });
    assert.equal(deployFn.calls[0].commit, undefined);
  });
});

describe('failures', () => {
  test('a wrong master key fails the deployment cleanly and never starts a deploy', async () => {
    const appId = await makeApp();
    await addVar(appId, 'DATABASE_URL', SECRET);
    const depId = await makeDeployment(appId);
    const deployFn = fakeDeploy();
    await assert.rejects(processDeployJob(jobFor(appId, depId), { secretsKey: OTHER_KEY, deployFn }), (err) => {
      assert.match(err.message, /Could not decrypt the variable "DATABASE_URL"/);
      assert.ok(!err.message.includes(SECRET));
      return true;
    });
    assert.equal(deployFn.calls.length, 0);
    const row = await getDeployment(depId);
    assert.equal(row.status, 'failed');
    assert.match(row.error_summary, /APP_SECRETS_KEY/);
    assert.ok(!JSON.stringify(row).includes(SECRET));
  });

  test('an unexpected error while loading variables is reported generically', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    const loadEnv = async () => { throw new Error(`connection to server at "10.0.0.5" failed, password=${SECRET}`); };
    await assert.rejects(
      processDeployJob(jobFor(appId, depId), { secretsKey: KEY, deployFn: fakeDeploy(), loadEnv }),
      (err) => { assert.equal(err.message, 'Could not load the app variables'); return true; },
    );
    const row = await getDeployment(depId);
    assert.equal(row.error_summary, 'Could not load the app variables');
    assert.ok(!JSON.stringify(row).includes(SECRET));
  });

  test('a failed deploy is recorded with its reason and the job fails', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    await assert.rejects(
      processDeployJob(jobFor(appId, depId), { secretsKey: KEY, deployFn: fakeDeploy({ ok: false, error: 'Container exited early (code 1, OOMKilled=false)' }) }),
      /Container exited early/,
    );
    const row = await getDeployment(depId);
    assert.deepEqual([row.status, row.error_summary, row.image_ref], ['failed', 'Container exited early (code 1, OOMKilled=false)', null]);
  });

  test('if the deploy step itself blows up, the row fails with a generic message (nothing internal is stored)', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    const deployFn = async () => { throw new Error(`internal detail ${SECRET}`); };
    await assert.rejects(processDeployJob(jobFor(appId, depId), { secretsKey: KEY, deployFn }), /Unexpected error while deploying/);
    const row = await getDeployment(depId);
    assert.equal(row.status, 'failed');
    assert.ok(!JSON.stringify(row).includes(SECRET));
  });

  test('a job without a deploymentId is refused outright', async () => {
    const appId = await makeApp();
    const deployFn = fakeDeploy();
    await assert.rejects(processDeployJob(fakeJob({ appId, envFile: '/tmp/x.env' }), { secretsKey: KEY, deployFn }), /missing deploymentId/);
    assert.equal(deployFn.calls.length, 0);
  });
});

describe('claiming: nothing is built for a deployment that is no longer queued', () => {
  for (const status of ['cancelled', 'superseded', 'interrupted', 'successful', 'failed']) {
    test(`a ${status} deployment is skipped without deploying`, async () => {
      const appId = await makeApp();
      const depId = await makeDeployment(appId);
      await pool.query(`UPDATE deployments SET status = $2, finished_at = now() WHERE id = $1`, [depId, status]);
      const before = await getDeployment(depId);
      const deployFn = fakeDeploy();
      const out = await processDeployJob(jobFor(appId, depId), { secretsKey: KEY, deployFn });
      assert.deepEqual(out, { deploymentId: depId, skipped: true });
      assert.equal(deployFn.calls.length, 0);
      assert.deepEqual(await getDeployment(depId), before);
    });
  }

  test('a skipped job does not even decrypt the app variables', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    await pool.query(`UPDATE deployments SET status = 'cancelled' WHERE id = $1`, [depId]);
    let loaded = false;
    await processDeployJob(jobFor(appId, depId), { secretsKey: KEY, deployFn: fakeDeploy(), loadEnv: async () => { loaded = true; return { env: [], versions: {} }; } });
    assert.equal(loaded, false);
  });

  test('a database error while claiming propagates instead of deploying blind', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    const deployFn = fakeDeploy();
    const db = dbWith({ claim: async () => { throw new Error('db down'); } });
    await assert.rejects(processDeployJob(jobFor(appId, depId), { secretsKey: KEY, deployFn, db }), /db down/);
    assert.equal(deployFn.calls.length, 0);
  });
});

describe('stopping a running deployment', () => {
  test('a cancel request aborts the work and the row ends as cancelled', T, async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    let started;
    const startedP = new Promise((r) => { started = r; });
    const jobP = processDeployJob(jobFor(appId, depId), { secretsKey: KEY, pollMs: 20, deployFn: (o) => hangUntilAbort(o, started) });
    await startedP;
    await flag(depId, 'cancelled');
    const out = await jobP;

    assert.deepEqual(out, { deploymentId: depId, outcome: 'cancelled' });
    const row = await getDeployment(depId);
    assert.deepEqual([row.status, row.cancel_status, row.error_summary], ['cancelled', 'cancelled', 'Cancelled by the administrator']);
    assert.ok(row.finished_at);
  });

  test('a supersede request ends as superseded and keeps the link to the newer deployment', T, async () => {
    const appId = await makeApp();
    const older = await makeDeployment(appId);
    const newer = await makeDeployment(appId);
    let started;
    const startedP = new Promise((r) => { started = r; });
    const jobP = processDeployJob(jobFor(appId, older), { secretsKey: KEY, pollMs: 20, deployFn: (o) => hangUntilAbort(o, started) });
    await startedP;
    await flag(older, 'superseded', newer);
    const out = await jobP;

    assert.equal(out.outcome, 'superseded');
    const row = await getDeployment(older);
    assert.deepEqual([row.status, row.superseded_by, row.error_summary], ['superseded', newer, 'Superseded by a newer deployment']);
  });

  test('a stopped job is not a failure: the queue job completes normally', T, async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    let started;
    const startedP = new Promise((r) => { started = r; });
    const jobP = processDeployJob(jobFor(appId, depId), { secretsKey: KEY, pollMs: 20, deployFn: (o) => hangUntilAbort(o, started) });
    await startedP;
    await flag(depId, 'cancelled');
    await assert.doesNotReject(jobP);
  });

  test('the watcher stops polling once the job is over', T, async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    let calls = 0;
    const db = dbWith({ getCancelStatus: async (id) => { calls += 1; return store.getCancelStatus(id); } });
    await processDeployJob(jobFor(appId, depId), { secretsKey: KEY, pollMs: 15, db, deployFn: async (o) => { await sleep(80); return done(o); } });
    const after = calls;
    assert.ok(after >= 2, 'it should have polled while the job ran');
    await sleep(120);
    assert.equal(calls, after, 'it must not poll after the job ends');
  });

  test('a failed poll is ignored and the deployment carries on', T, async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    let n = 0;
    const db = dbWith({ getCancelStatus: async () => { if (++n <= 2) throw new Error('blip'); return null; } });
    const out = await processDeployJob(jobFor(appId, depId), { secretsKey: KEY, pollMs: 15, db, deployFn: async (o) => { await sleep(120); return done(o); } });
    assert.equal(out.deploymentId, depId);
    assert.equal((await getDeployment(depId)).status, 'successful');
  });

  test('a cancel that already ended the row is not overwritten by a late stop', T, async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    const deployFn = async (o) => { await pool.query(`UPDATE deployments SET status = 'interrupted', finished_at = now() WHERE id = $1`, [depId]); return { ok: false, stopped: true, outcome: 'cancelled', deploymentId: o.deploymentId, image: 'x' }; };
    await processDeployJob(jobFor(appId, depId), { secretsKey: KEY, deployFn });
    assert.equal((await getDeployment(depId)).status, 'interrupted');
  });
});

describe('the gate right before the swap', () => {
  test('a cancel flag set before the gate refuses the swap', T, async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    const deployFn = gated();
    // slow watcher so only the gate itself can notice
    const wrapped = async (o) => { await flag(depId, 'cancelled'); return deployFn(o); };
    const out = await processDeployJob(jobFor(appId, depId), { secretsKey: KEY, pollMs: 60_000, deployFn: wrapped });
    assert.equal(out.outcome, 'cancelled');
    assert.equal((await getDeployment(depId)).status, 'cancelled');
  });

  test('a cancel after the gate is too late: the deployment completes, and the row says so honestly', T, async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    let abortedAfterGate = null;
    const deployFn = gated(async (o) => {
      await flag(depId, 'cancelled'); // lands after the point of no return
      await sleep(150);               // several watcher ticks pass
      abortedAfterGate = o.signal.aborted;
    });
    const out = await processDeployJob(jobFor(appId, depId), { secretsKey: KEY, pollMs: 20, deployFn });

    assert.equal(abortedAfterGate, false, 'the watcher must be off after the gate');
    assert.equal(out.deploymentId, depId);
    const row = await getDeployment(depId);
    assert.equal(row.status, 'successful');
    assert.equal(row.cancel_status, null);
    assert.match(row.error_summary, /too late/i);
  });

  test('a supersede flag after the gate is also recorded as too late', T, async () => {
    const appId = await makeApp();
    const older = await makeDeployment(appId);
    const newer = await makeDeployment(appId);
    const deployFn = gated(async () => { await flag(older, 'superseded', newer); });
    await processDeployJob(jobFor(appId, older), { secretsKey: KEY, pollMs: 20, deployFn });
    const row = await getDeployment(older);
    assert.equal(row.status, 'successful');
    assert.match(row.error_summary, /Superseded too late/);
  });

  test('a database error at the gate fails safely with a generic message', T, async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    const db = dbWith({ getCancelStatus: async () => { throw new Error(`pg: password authentication failed ${SECRET}`); } });
    const deployFn = async (o) => {
      try { await o.beforeSwap(); } catch (err) { return { ok: false, error: err.message, deploymentId: o.deploymentId, image: 'x' }; }
      return done(o);
    };
    await assert.rejects(processDeployJob(jobFor(appId, depId), { secretsKey: KEY, pollMs: 60_000, db, deployFn }), /Could not check for a cancel request/);
    const row = await getDeployment(depId);
    assert.equal(row.status, 'failed');
    assert.ok(!JSON.stringify(row).includes(SECRET));
  });
});

describe('the stale-commit guard: an older deployment never replaces a newer one that is already live', () => {
  test('is superseded instead of swapping when a NEWER deployment of the same app already succeeded', T, async () => {
    const appId = await makeApp();
    const older = await makeDeployment(appId);
    const newer = await makeDeployment(appId);
    await pool.query(`UPDATE deployments SET status = 'successful', finished_at = now() WHERE id = $1`, [newer]);

    const out = await processDeployJob(jobFor(appId, older), { secretsKey: KEY, pollMs: 60_000, deployFn: gated() });

    assert.equal(out.outcome, 'superseded');
    const row = await getDeployment(older);
    assert.deepEqual([row.status, row.superseded_by], ['superseded', newer]);
  });

  test('an OLDER successful deployment does not block a newer one', T, async () => {
    const appId = await makeApp();
    const older = await makeDeployment(appId);
    const newer = await makeDeployment(appId);
    await pool.query(`UPDATE deployments SET status = 'successful', finished_at = now() WHERE id = $1`, [older]);
    await processDeployJob(jobFor(appId, newer), { secretsKey: KEY, pollMs: 60_000, deployFn: gated() });
    assert.equal((await getDeployment(newer)).status, 'successful');
  });

  test('a newer deployment that merely failed does not block', T, async () => {
    const appId = await makeApp();
    const older = await makeDeployment(appId);
    const newer = await makeDeployment(appId);
    await pool.query(`UPDATE deployments SET status = 'failed', finished_at = now() WHERE id = $1`, [newer]);
    await processDeployJob(jobFor(appId, older), { secretsKey: KEY, pollMs: 60_000, deployFn: gated() });
    assert.equal((await getDeployment(older)).status, 'successful');
  });

  test("another app's newer success does not block", T, async () => {
    const appA = await makeApp();
    const appB = await makeApp();
    const a = await makeDeployment(appA);
    const b = await makeDeployment(appB); // newer seq, different app
    await pool.query(`UPDATE deployments SET status = 'successful', finished_at = now() WHERE id = $1`, [b]);
    await processDeployJob(jobFor(appA, a), { secretsKey: KEY, pollMs: 60_000, deployFn: gated() });
    assert.equal((await getDeployment(a)).status, 'successful');
  });
});

describe('GitHub authentication in the job', () => {
  const TOKEN = 'ghs_JOBTOKEN_123456';
  const gh = (over = {}) => ({
    async findInstallationForRepo() { return 9; },
    async getInstallationToken() { return TOKEN; },
    ...over,
  });
  const jobWith = (appId, depId, extra) => fakeJob({ ...jobFor(appId, depId).data, repoFullName: 'o/r', ...extra });

  test('passes a token-bearing git environment to the deploy step and remembers the installation', async () => {
    const appId = await makeApp(); const depId = await makeDeployment(appId);
    const deployFn = fakeDeploy();
    await processDeployJob(jobWith(appId, depId), { secretsKey: KEY, deployFn, github: gh() });
    assert.equal(deployFn.calls[0].gitEnv.GIT_CONFIG_KEY_0, 'http.extraHeader');
    const { rows } = await pool.query('SELECT github_installation_id FROM apps WHERE id = $1', [appId]);
    assert.equal(Number(rows[0].github_installation_id), 9);
  });

  test('without the GitHub App configured, the deploy step gets no gitEnv', async () => {
    const appId = await makeApp(); const depId = await makeDeployment(appId);
    const deployFn = fakeDeploy();
    await processDeployJob(jobWith(appId, depId), { secretsKey: KEY, deployFn });
    assert.equal(deployFn.calls[0].gitEnv, undefined);
  });

  test('a client given as a function is asked at the time of the job (the app can be connected in the dashboard while the worker runs)', async () => {
    const appId = await makeApp(); const depId = await makeDeployment(appId);
    const deployFn = fakeDeploy();
    let asked = 0;
    await processDeployJob(jobWith(appId, depId), { secretsKey: KEY, deployFn, github: async () => { asked += 1; return gh(); } });
    assert.equal(asked, 1);
    assert.equal(deployFn.calls[0].gitEnv.GIT_CONFIG_KEY_0, 'http.extraHeader');
  });

  test('the function is asked for the GitHub app the project is assigned to (the job says which)', async () => {
    const appId = await makeApp(); const depId = await makeDeployment(appId);
    const asked = [];
    const mine = gh({ async getInstallationToken() { return 'ghs_MINE_123456'; } });
    const theirs = gh({ async getInstallationToken() { return 'ghs_THEIRS_123456'; } });
    const deployFn = fakeDeploy();
    await processDeployJob(jobWith(appId, depId, { githubAppId: 'app-two' }), {
      secretsKey: KEY, deployFn, github: async (id) => { asked.push(id); return id === 'app-two' ? theirs : mine; },
    });
    assert.deepEqual(asked, ['app-two']);
    const header = Buffer.from(deployFn.calls[0].gitEnv.GIT_CONFIG_VALUE_0.split(' ').at(-1), 'base64').toString(); // the token travels as Basic auth
    assert.match(header, /ghs_THEIRS_123456/);
    assert.doesNotMatch(header, /ghs_MINE/);
  });

  test('a job with no GitHub app asks for none (public repositories only, whatever apps are connected)', async () => {
    const appId = await makeApp(); const depId = await makeDeployment(appId);
    const asked = [];
    const deployFn = fakeDeploy();
    await processDeployJob(jobWith(appId, depId), { secretsKey: KEY, deployFn, github: async (id) => { asked.push(id); return id ? gh() : null; } });
    assert.deepEqual(asked, [undefined]);
    assert.equal(deployFn.calls[0].gitEnv, undefined);
  });

  test('a function that finds no app means public repositories only', async () => {
    const appId = await makeApp(); const depId = await makeDeployment(appId);
    const deployFn = fakeDeploy();
    await processDeployJob(jobWith(appId, depId), { secretsKey: KEY, deployFn, github: async () => null });
    assert.equal(deployFn.calls[0].gitEnv, undefined);
  });

  test('a function that fails fails the deployment with a safe message and never runs the build', async () => {
    const appId = await makeApp(); const depId = await makeDeployment(appId);
    const deployFn = fakeDeploy();
    await assert.rejects(processDeployJob(jobWith(appId, depId), { secretsKey: KEY, deployFn, github: async () => { throw new Error(`boom ${TOKEN}`); } }));
    assert.equal(deployFn.calls.length, 0);
    const d = await getDeployment(depId);
    assert.equal(d.status, 'failed');
    assert.match(d.error_summary, /Could not prepare GitHub access/);
    assert.ok(!JSON.stringify(d).includes(TOKEN));
  });

  test('a token failure fails the deployment with a safe message and never runs the build', async () => {
    const appId = await makeApp(); const depId = await makeDeployment(appId);
    const deployFn = fakeDeploy();
    const github = gh({ async getInstallationToken() { const e = new Error(`leak ${TOKEN}`); e.status = 401; throw e; } });
    await assert.rejects(processDeployJob(jobWith(appId, depId, { installationId: 9 }), { secretsKey: KEY, deployFn, github }));
    assert.equal(deployFn.calls.length, 0);
    const d = await getDeployment(depId);
    assert.equal(d.status, 'failed');
    assert.match(d.error_summary, /GitHub access token/);
    assert.ok(!JSON.stringify(d).includes(TOKEN));
  });
});

describe('stopped apps and the swap', () => {
  const setDesired = (appId, state) => pool.query('UPDATE apps SET desired_state = $2 WHERE id = $1', [appId, state]);
  const desired = async (appId) => (await pool.query('SELECT desired_state FROM apps WHERE id = $1', [appId])).rows[0].desired_state;
  const runtimeOf = async (appId) => (await pool.query('SELECT * FROM app_runtime WHERE app_id = $1', [appId])).rows[0];
  // Like deploy(): asks the gate, and reports whether the app was started.
  const gatedStart = async (opts) => {
    const gate = await opts.beforeSwap();
    return done(opts, { started: gate.start !== false });
  };
  const withFlag = (job, startAfterDeploy) => { job.data.startAfterDeploy = startAfterDeploy; return job; };

  test('a running app is started by its deployment', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    const out = await processDeployJob(jobFor(appId, depId), { secretsKey: KEY, deployFn: gatedStart });
    assert.ok(out.image);
    assert.deepEqual([(await runtimeOf(appId)).state, (await runtimeOf(appId)).last_action], ['running', 'deploy']);
  });

  test('a new version going live forgives the old version\'s crashes; a deployment that leaves the app stopped does not', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    await processDeployJob(jobFor(appId, depId), { secretsKey: KEY, deployFn: gatedStart });
    assert.ok((await runtimeOf(appId)).crash_reset_at);

    const other = await makeApp();
    await setDesired(other, 'stopped');
    const dep2 = await makeDeployment(other);
    await processDeployJob(jobFor(other, dep2), { secretsKey: KEY, deployFn: gatedStart });
    assert.equal((await runtimeOf(other)).crash_reset_at, null);
  });

  test('a stopped app is told NOT to start, and stays stopped', async () => {
    const appId = await makeApp();
    await setDesired(appId, 'stopped');
    const depId = await makeDeployment(appId);
    let seen;
    await processDeployJob(jobFor(appId, depId), {
      secretsKey: KEY, deployFn: async (opts) => { const g = await opts.beforeSwap(); seen = g; return done(opts, { started: g.start !== false }); },
    });
    assert.deepEqual([seen.proceed, seen.start], [true, false]);
    assert.equal(await desired(appId), 'stopped');
    assert.equal((await runtimeOf(appId)).state, 'stopped');
    assert.equal((await getDeployment(depId)).status, 'successful', 'the deployment itself succeeded');
  });

  test('an explicit start request starts it, and only then does the desired state become running', async () => {
    const appId = await makeApp();
    await setDesired(appId, 'stopped');
    const depId = await makeDeployment(appId);
    await processDeployJob(withFlag(jobFor(appId, depId), true), { secretsKey: KEY, deployFn: gatedStart });
    assert.equal(await desired(appId), 'running');
    assert.equal((await runtimeOf(appId)).state, 'running');
  });

  test('an explicit start on a deployment that FAILS leaves the app stopped and wanting to be stopped', async () => {
    const appId = await makeApp();
    await setDesired(appId, 'stopped');
    const depId = await makeDeployment(appId);
    await assert.rejects(processDeployJob(withFlag(jobFor(appId, depId), true), { secretsKey: KEY, deployFn: fakeDeploy({ ok: false }) }));
    assert.equal(await desired(appId), 'stopped');
    assert.equal(await runtimeOf(appId), undefined, 'nothing about the live container changed, so nothing is recorded');
  });

  test('a stop that arrives while the build is running is honoured at the swap', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    let started;
    await processDeployJob(jobFor(appId, depId), {
      secretsKey: KEY,
      deployFn: async (opts) => {
        await setDesired(appId, 'stopped'); // the administrator presses Stop while the image is being built
        const g = await opts.beforeSwap();
        started = g.start !== false;
        return done(opts, { started });
      },
    });
    assert.equal(started, false);
    assert.equal((await runtimeOf(appId)).state, 'stopped');
  });

  test('a cancelled deployment does not touch the desired state or the runtime record', async () => {
    const appId = await makeApp();
    await setDesired(appId, 'stopped');
    const depId = await makeDeployment(appId);
    await flag(depId, 'cancelled');
    await processDeployJob(withFlag(jobFor(appId, depId), true), { secretsKey: KEY, deployFn: gated() });
    assert.equal(await desired(appId), 'stopped');
    assert.equal(await runtimeOf(appId), undefined);
  });
});

describe('image size and clean-up after a deployment', () => {
  const setAuto = (appId, on) => pool.query('UPDATE apps SET auto_prune = $2 WHERE id = $1', [appId, on]);

  test('the size of the image is stored with the deployment', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    const deployFn = async (opts) => done(opts, { imageBytes: 123_456_789 });
    await processDeployJob(jobFor(appId, depId), { secretsKey: KEY, deployFn });
    assert.equal(Number((await getDeployment(depId)).image_bytes), 123_456_789);
  });

  test('an app with auto_prune off is not cleaned up (the default)', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    const calls = [];
    await processDeployJob(jobFor(appId, depId), { secretsKey: KEY, deployFn: fakeDeploy(), pruneFn: async (o) => { calls.push(o); } });
    assert.deepEqual(calls, []);
  });

  test('an app with auto_prune on is cleaned up after a SUCCESSFUL deployment, saying it was automatic', async () => {
    const appId = await makeApp();
    await setAuto(appId, true);
    const depId = await makeDeployment(appId);
    const calls = [];
    await processDeployJob(jobFor(appId, depId), { secretsKey: KEY, deployFn: fakeDeploy(), pruneFn: async (o) => { calls.push(o); } });
    assert.deepEqual(calls, [{ appId, trigger: 'auto' }]);
  });

  test('the clean-up runs after the new version is recorded as successful', async () => {
    const appId = await makeApp();
    await setAuto(appId, true);
    const depId = await makeDeployment(appId);
    let statusAtPrune;
    await processDeployJob(jobFor(appId, depId), {
      secretsKey: KEY, deployFn: fakeDeploy(),
      pruneFn: async () => { statusAtPrune = (await getDeployment(depId)).status; },
    });
    assert.equal(statusAtPrune, 'successful');
  });

  test('a failed deployment is never followed by a clean-up', async () => {
    const appId = await makeApp();
    await setAuto(appId, true);
    const depId = await makeDeployment(appId);
    const calls = [];
    await assert.rejects(processDeployJob(jobFor(appId, depId), { secretsKey: KEY, deployFn: fakeDeploy({ ok: false }), pruneFn: async (o) => { calls.push(o); } }));
    assert.deepEqual(calls, []);
  });

  test('a clean-up that fails cannot turn a successful deployment into a failed one', async () => {
    const appId = await makeApp();
    await setAuto(appId, true);
    const depId = await makeDeployment(appId);
    const out = await processDeployJob(jobFor(appId, depId), { secretsKey: KEY, deployFn: fakeDeploy(), pruneFn: async () => { throw new Error('docker down'); } });
    assert.equal(out.deploymentId, depId);
    assert.equal((await getDeployment(depId)).status, 'successful');
  });

  test('a rollback\'s reused image is handed to the deploy step', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    const deployFn = fakeDeploy();
    const job = jobFor(appId, depId);
    job.data.reuseImage = 'shipdok/my-app:11111111-1111-4111-8111-111111111111';
    await processDeployJob(job, { secretsKey: KEY, deployFn });
    assert.equal(deployFn.calls[0].reuseImage, job.data.reuseImage);
  });
});
