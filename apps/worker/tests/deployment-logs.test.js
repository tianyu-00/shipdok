// A deployment's log file: created when the job starts, filled while it runs, closed when it ends, secrets masked.
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../src/db.js';
import { processDeployJob } from '../src/process-job.js';
import { logFilePath, gitAuthEnv } from '@shipdok/shared';
import { pool, KEY, SECRET, ready, reset, makeApp, addVar, makeDeployment, getDeployment } from './helpers.js';

before(ready);
beforeEach(reset);
after(() => pool.end());

const root = mkdtempSync(join(tmpdir(), 'deplogs-'));
after(() => rmSync(root, { recursive: true, force: true }));

const TOKEN = 'ghs_TheInstallationTokenForLogs42';
const fakeJob = (data) => ({ id: '7', data, async log() {} });
const jobFor = (appId, deploymentId, over = {}) => fakeJob({
  deploymentId, appId, slug: 'my-app', repoFullName: 'o/r', repo: 'https://github.com/o/r.git', ref: 'main', dir: '.',
  containerPort: 3000, hostPort: 8080, ...over,
});
const done = (opts) => ({ ok: true, deploymentId: opts.deploymentId, image: 'img', started: true });
const deps = (deployFn, over = {}) => ({ secretsKey: KEY, deployFn, logRoot: root, ...over });
const fileOf = (appId, depId) => logFilePath(root, appId, depId, 'build');
const text = (appId, depId) => readFileSync(fileOf(appId, depId), 'utf8');
const row = async (depId) => (await pool.query(`SELECT * FROM log_files WHERE deployment_id = $1 AND kind = 'build'`, [depId])).rows[0];
const github = { findInstallationForRepo: async () => 9, getInstallationToken: async () => TOKEN };

describe('the log file of a successful deployment', () => {
  test('holds the progress messages and whatever the build wrote, and is recorded as finished', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    await processDeployJob(jobFor(appId, depId), deps(async (opts) => {
      opts.log('Cloning o/r@main');
      opts.logSink.write('stdout', '#5 [2/3] COPY . .\n');
      opts.logSink.write('stderr', 'npm warn deprecated something\n');
      return done(opts);
    }));
    const t = text(appId, depId);
    assert.match(t, / shipdok Cloning o\/r@main\n/);
    assert.match(t, / stdout #5 \[2\/3\] COPY \. \.\n/);
    assert.match(t, / stderr npm warn deprecated something\n/);
    const r = await row(depId);
    assert.deepEqual([r.app_id, r.truncated, r.ended_at !== null], [appId, false, true]);
    assert.equal(Number(r.bytes), Buffer.byteLength(t));
  });

  test('the record exists while the deployment runs, marked as not finished', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    let during;
    await processDeployJob(jobFor(appId, depId), deps(async (opts) => { during = await row(depId); return done(opts); }));
    assert.ok(during, 'created at the start');
    assert.equal(during.ended_at, null);
  });

  test('a multi-line message (container output on a failure) becomes one log line per line', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    await processDeployJob(jobFor(appId, depId), deps(async (opts) => {
      opts.log('--- last container output (candidate) ---\nlistening on 3000\nsecond line\n--- end ---');
      return done(opts);
    }));
    const messages = text(appId, depId).trimEnd().split('\n').map((l) => l.split(' ').slice(2).join(' '));
    assert.deepEqual(messages.slice(0, 4), ['--- last container output (candidate) ---', 'listening on 3000', 'second line', '--- end ---']);
  });

  test('another deployment gets its own file', async () => {
    const appId = await makeApp();
    const d1 = await makeDeployment(appId);
    const d2 = await makeDeployment(appId);
    await processDeployJob(jobFor(appId, d1), deps(async (o) => { o.log('one'); return done(o); }));
    await processDeployJob(jobFor(appId, d2), deps(async (o) => { o.log('two'); return done(o); }));
    assert.match(text(appId, d1), /one\n/);
    assert.ok(!text(appId, d1).includes('two'));
    assert.match(text(appId, d2), /two\n/);
  });
});

describe('deployments that do not succeed still leave a readable log', () => {
  test('a failed deployment: the reason is in the file', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    await assert.rejects(processDeployJob(jobFor(appId, depId), deps(async (opts) => {
      opts.logSink.write('stderr', 'ERROR: failed to solve: dockerfile parse error\n');
      return { ok: false, deploymentId: opts.deploymentId, image: 'x', error: 'docker exited 1' };
    })));
    const t = text(appId, depId);
    assert.match(t, /dockerfile parse error/);
    assert.match(t, /shipdok Deployment failed: docker exited 1/);
    assert.notEqual((await row(depId)).ended_at, null);
  });

  test('a cancelled deployment is closed and says why', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    await pool.query(`UPDATE deployments SET cancel_status = 'cancelled' WHERE id = $1`, [depId]);
    await processDeployJob(jobFor(appId, depId), deps(async (opts) => {
      const gate = await opts.beforeSwap();
      return { ok: false, stopped: true, outcome: gate.outcome, deploymentId: opts.deploymentId, image: 'x' };
    }));
    assert.match(text(appId, depId), /shipdok Deployment stopped: cancelled/);
    assert.notEqual((await row(depId)).ended_at, null);
  });

  test('a crash inside the deploy step is closed too, without leaking the error text', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    await assert.rejects(processDeployJob(jobFor(appId, depId), deps(async () => { throw new Error('internal boom'); })));
    assert.notEqual((await row(depId)).ended_at, null);
    assert.ok(!text(appId, depId).includes('internal boom'));
  });

  test('a failure before the build even starts (the variables cannot be read) is logged', async () => {
    const appId = await makeApp();
    await addVar(appId, 'X', 'value-1234', KEY);
    const depId = await makeDeployment(appId);
    await assert.rejects(processDeployJob(jobFor(appId, depId), { ...deps(async (o) => done(o)), secretsKey: Buffer.alloc(32, 7) }));
    assert.match(text(appId, depId), /shipdok .*variable/i);
    assert.notEqual((await row(depId)).ended_at, null);
  });

  test('a job that was never claimed (cancelled while queued) creates no log at all', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    await pool.query(`UPDATE deployments SET status = 'cancelled' WHERE id = $1`, [depId]);
    await processDeployJob(jobFor(appId, depId), deps(async (o) => done(o)));
    assert.ok(!existsSync(fileOf(appId, depId)));
    assert.equal(await row(depId), undefined);
  });
});

describe('secrets', () => {
  test('the app\'s variable values are masked everywhere in the file', async () => {
    const appId = await makeApp();
    await addVar(appId, 'API_KEY', SECRET);
    const depId = await makeDeployment(appId);
    await processDeployJob(jobFor(appId, depId), deps(async (opts) => {
      opts.log(`the key is ${SECRET}`);
      opts.logSink.write('stderr', `leaked ${SECRET} in output\n`);
      return done(opts);
    }));
    const t = text(appId, depId);
    assert.ok(!t.includes(SECRET));
    assert.match(t, /the key is \*\*\*/);
    assert.match(t, /leaked \*\*\* in output/);
  });

  test('a build-time variable\'s value is masked in the file too, and never reaches the container\'s environment', async () => {
    const appId = await makeApp();
    await addVar(appId, 'NPM_TOKEN', SECRET, KEY, 'build');
    await addVar(appId, 'PUBLIC_URL_X', 'https://shop.example.com', KEY, 'both');
    const depId = await makeDeployment(appId);
    let given;
    await processDeployJob(jobFor(appId, depId), deps(async (opts) => {
      given = opts;
      opts.log(`npm login with ${SECRET}`);
      opts.logSink.write('stderr', `#7 RUN echo ${SECRET} https://shop.example.com\n`);
      return done(opts);
    }));
    const t = text(appId, depId);
    assert.ok(!t.includes(SECRET) && !t.includes('shop.example.com'));
    assert.ok(t.includes('***'));
    assert.deepEqual(given.buildEnv, ['NPM_TOKEN=' + SECRET, 'PUBLIC_URL_X=https://shop.example.com']);
    assert.deepEqual(given.env, ['PUBLIC_URL_X=https://shop.example.com']); // the build-only variable is not in the container
  });

  test('the GitHub installation token is masked, in both forms git may print it', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    const header = gitAuthEnv(TOKEN).GIT_CONFIG_VALUE_0;
    await processDeployJob(jobFor(appId, depId), { ...deps(async (opts) => {
      opts.logSink.write('stderr', `fatal: unable to access (${header})\n`);
      opts.log(`using ${TOKEN}`);
      return done(opts);
    }), github });
    const t = text(appId, depId);
    assert.ok(!t.includes(TOKEN));
    assert.ok(!t.includes(Buffer.from(`x-access-token:${TOKEN}`).toString('base64')));
    assert.match(t, /Authorization: Basic \*\*\*/);
  });
});

describe('handing the old container\'s output to the collector', () => {
  test('the deploy step gets a hook that drains a container for THIS app', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    const calls = [];
    const collector = { drain: async (container, info) => { calls.push([container.name, info.appId]); } };
    await processDeployJob(jobFor(appId, depId), { ...deps(async (opts) => {
      await opts.onRetire({ name: 'old-container' });
      return done(opts);
    }), collector });
    assert.deepEqual(calls, [['old-container', appId]]);
  });

  test('without a collector there is no hook', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    let given;
    await processDeployJob(jobFor(appId, depId), deps(async (opts) => { given = opts.onRetire; return done(opts); }));
    assert.equal(given, undefined);
  });
});

describe('the log never gets in the way', () => {
  test('if it cannot be written the deployment still succeeds', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    const blocker = join(root, 'a-file');
    writeFileSync(blocker, 'x');
    const out = await processDeployJob(jobFor(appId, depId), deps(async (o) => { o.log('hello'); return done(o); }, { logRoot: blocker }));
    assert.ok(out.image);
    assert.equal((await getDeployment(depId)).status, 'successful');
  });

  test('a database error while recording the log does not fail the deployment either', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    const broken = { ...store, openLogFile: async () => { throw new Error('db down'); }, closeLogFile: async () => { throw new Error('db down'); } };
    const out = await processDeployJob(jobFor(appId, depId), { ...deps(async (o) => done(o)), db: broken });
    assert.ok(out.image);
  });

  test('the size cap is passed on, and reaching it is recorded', async () => {
    const appId = await makeApp();
    const depId = await makeDeployment(appId);
    await processDeployJob(jobFor(appId, depId), deps(async (opts) => {
      for (let i = 0; i < 200; i++) opts.logSink.line('stdout', `padding line ${i} ${'x'.repeat(40)}`);
      return done(opts);
    }, { logMaxBytes: 2000 }));
    const r = await row(depId);
    assert.equal(r.truncated, true);
    assert.ok(Number(r.bytes) < 2500);
  });
});
