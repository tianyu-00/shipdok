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

// A stand-in for Docker: records what it was asked to deploy and behaves as instructed.
function fakeDeploy({ ok = true, error = 'boom', calls: hooks = [] } = {}) {
  const fn = async (opts) => {
    fn.calls.push(opts);
    for (const [name, arg] of hooks) opts[name](arg);
    await new Promise((r) => setImmediate(r)); // let best-effort hook writes land
    return ok
      ? { ok: true, deploymentId: opts.deploymentId, image: `shipdok/${opts.slug}:${opts.deploymentId}` }
      : { ok: false, deploymentId: opts.deploymentId, image: 'x', error };
  };
  fn.calls = [];
  return fn;
}

const fakeJob = (data) => ({ id: '7', data, logs: [], async log(m) { this.logs.push(m); } });
const jobFor = (appId, deploymentId) => fakeJob({
  deploymentId, appId, slug: 'my-app', repo: 'https://github.com/o/r.git', ref: 'main', dir: '.',
  containerPort: 3000, hostPort: 8080,
});

describe('a successful job', () => {
  test('passes the decrypted variables to the deploy step and records success', async () => {
    const appId = await makeApp();
    await addVar(appId, 'DATABASE_URL', 'postgres://u:p@h/db');
    await addVar(appId, 'API_KEY', SECRET);
    const depId = await makeDeployment(appId);
    const deployFn = fakeDeploy({ calls: [['onStatus', 'starting'], ['onCommit', 'abc123']] });

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
    // The API snapshotted an older state: A at an old version, and a variable that has since been deleted.
    const depId = await makeDeployment(appId, { branch: 'main', env: { A: '1', GONE: '2' } });

    await processDeployJob(jobFor(appId, depId), { secretsKey: KEY, deployFn: fakeDeploy() });

    const snap = (await getDeployment(depId)).config_snapshot;
    assert.deepEqual(snap.env, await versionsOf(appId));
    assert.equal(snap.branch, 'main'); // the rest of the snapshot is untouched
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
    assert.ok(!JSON.stringify((await getDeployment(depId))).includes(SECRET));
    assert.ok(![...seen, ...job.logs, JSON.stringify(out), JSON.stringify(job.data)].join('\n').includes(SECRET));
  });
});

describe('failures', () => {
  test('a wrong master key fails the deployment cleanly and never starts a deploy', async () => {
    const appId = await makeApp();
    await addVar(appId, 'DATABASE_URL', SECRET);
    const depId = await makeDeployment(appId);
    const deployFn = fakeDeploy();

    await assert.rejects(
      processDeployJob(jobFor(appId, depId), { secretsKey: OTHER_KEY, deployFn }),
      (err) => {
        assert.match(err.message, /Could not decrypt the variable "DATABASE_URL"/);
        assert.ok(!err.message.includes(SECRET));
        return true;
      },
    );
    assert.equal(deployFn.calls.length, 0);
    const row = await getDeployment(depId);
    assert.equal(row.status, 'failed');
    assert.match(row.error_summary, /APP_SECRETS_KEY/);
    assert.ok(!JSON.stringify(row).includes(SECRET));
    assert.ok(row.finished_at);
  });

  test('an unexpected error while loading variables is reported generically', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    const loadEnv = async () => { throw new Error(`connection to server at "10.0.0.5" failed, password=${SECRET}`); };
    await assert.rejects(
      processDeployJob(jobFor(appId, depId), { secretsKey: KEY, deployFn: fakeDeploy(), loadEnv }),
      (err) => {
        assert.equal(err.message, 'Could not load the app variables');
        return true;
      },
    );
    const row = await getDeployment(depId);
    assert.equal(row.error_summary, 'Could not load the app variables');
    assert.ok(!JSON.stringify(row).includes(SECRET));
  });

  test('a failed deploy is recorded with its reason and the job fails', async () => {
    const appId = await makeApp();
    await addVar(appId, 'A', SECRET);
    const depId = await makeDeployment(appId);
    await assert.rejects(
      processDeployJob(jobFor(appId, depId), { secretsKey: KEY, deployFn: fakeDeploy({ ok: false, error: 'Container exited early (code 1, OOMKilled=false)' }) }),
      /Container exited early/,
    );
    const row = await getDeployment(depId);
    assert.equal(row.status, 'failed');
    assert.equal(row.error_summary, 'Container exited early (code 1, OOMKilled=false)');
    assert.equal(row.image_ref, null);
  });

  test('a job without a deploymentId is refused outright (no more secrets from files on disk)', async () => {
    const appId = await makeApp();
    const deployFn = fakeDeploy();
    await assert.rejects(processDeployJob(fakeJob({ appId, envFile: '/tmp/x.env' }), { secretsKey: KEY, deployFn }), /missing deploymentId/);
    assert.equal(deployFn.calls.length, 0);
  });

  test('a late result cannot overwrite a final status', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    await pool.query(`UPDATE deployments SET status = 'interrupted', finished_at = now() WHERE id = $1`, [depId]);
    await processDeployJob(jobFor(appId, depId), { secretsKey: KEY, deployFn: fakeDeploy() });
    assert.equal((await getDeployment(depId)).status, 'interrupted');
  });
});
