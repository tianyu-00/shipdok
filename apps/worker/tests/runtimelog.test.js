// The collector: follows a running container's output into runtime.log, keeps the run before in runtime.previous.log,
// and survives restarts of the app, of the connection, and of the worker itself.
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../src/db.js';
import { createCollector } from '../src/runtimelog.js';
import { logFilePath } from '@shipdok/shared';
import { pool, ready, reset, makeApp, makeDeployment } from './helpers.js';
import { fakeEngine } from './fake-engine.js';

before(ready);
beforeEach(reset);
after(() => pool.end());

const root = mkdtempSync(join(tmpdir(), 'runtimelog-'));
after(() => rmSync(root, { recursive: true, force: true }));

const T = Date.parse('2026-10-19T12:00:00.000Z');
const at = (s) => T + s * 1000;
const setup = async (over = {}) => {
  const appId = await makeApp();
  const deploymentId = await makeDeployment(appId);
  const eng = fakeEngine({ previous: ['live-1'] });
  eng.facts = { ...eng.facts, status: 'running', startedAt: at(0), deploymentId };
  const collector = createCollector({ root, db: store, eng, loadSecrets: async () => [], log: () => {}, ...over });
  const container = (await eng.findContainers({}))[0];
  container.id = `c-${deploymentId}`;
  const sync = () => collector.sync({ id: appId }, container, { ...eng.facts });
  const file = (kind = 'runtime') => logFilePath(root, appId, deploymentId, kind);
  const text = (kind = 'runtime') => readFileSync(file(kind), 'utf8');
  const messages = (kind = 'runtime') => text(kind).trimEnd().split('\n').map((l) => l.split(' ').slice(2).join(' '));
  const row = (kind = 'runtime') => store.getLogFile(deploymentId, kind);
  const settle = () => new Promise((r) => setTimeout(r, 25)); // let stream events and file writes land
  return { appId, deploymentId, eng, collector, container, sync, file, text, messages, row, settle };
};

describe('collecting a running app\'s output', () => {
  test('writes what the app printed so far, with the time Docker saw each line and the right stream', async () => {
    const t = await setup();
    t.eng.say('stdout', 'listening on 3000', at(1));
    t.eng.say('stderr', 'warning: something', at(2));
    await t.sync(); await t.settle(); await t.collector.stopAll();
    assert.deepEqual(t.text().trimEnd().split('\n'), [
      '2026-10-19T12:00:01.000Z stdout listening on 3000',
      '2026-10-19T12:00:02.000Z stderr warning: something',
    ]);
  });

  test('keeps following: lines printed after the first look arrive too', async () => {
    const t = await setup();
    t.eng.say('stdout', 'one', at(1));
    await t.sync();
    t.eng.say('stdout', 'two', at(2));
    t.eng.say('stdout', 'three', at(3));
    await t.settle(); await t.collector.stopAll();
    assert.deepEqual(t.messages(), ['one', 'two', 'three']);
  });

  test('many lines in the same millisecond are all kept', async () => {
    const t = await setup();
    await t.sync();
    for (let i = 0; i < 20; i++) t.eng.say('stdout', `burst ${i}`, at(5));
    await t.settle(); await t.collector.stopAll();
    assert.equal(t.messages().length, 20);
  });

  test('records the log: which run it holds, not finished yet', async () => {
    const t = await setup();
    await t.sync();
    const r = await t.row();
    assert.deepEqual([r.runStartedAt, r.endedAt, r.truncated], [at(0), null, false]);
    await t.collector.stopAll();
  });

  test('looking again at the same run changes nothing: no second follower, no repeated lines', async () => {
    const t = await setup();
    t.eng.say('stdout', 'only once', at(1));
    await t.sync(); await t.sync(); await t.sync(); await t.settle(); await t.collector.stopAll();
    assert.deepEqual(t.messages(), ['only once']);
    assert.equal(t.eng.events.filter((e) => e.startsWith('follow')).length, 1);
  });

  test('the app\'s secrets are masked', async () => {
    const t = await setup({ loadSecrets: async () => ['hunter2-secret'] });
    t.eng.say('stdout', 'password is hunter2-secret ok', at(1));
    await t.sync(); await t.settle(); await t.collector.stopAll();
    assert.deepEqual(t.messages(), ['password is *** ok']);
  });

  test('if the secrets cannot be loaded nothing is collected (better no log than an unmasked one)', async () => {
    const t = await setup({ loadSecrets: async () => { throw new Error('cannot decrypt'); } });
    t.eng.say('stdout', 'secret stuff', at(1));
    await assert.rejects(t.sync(), /cannot decrypt/);
    assert.ok(!existsSync(t.file()));
    assert.equal(await t.row(), null);
  });

  test('a container without a deployment label is ignored', async () => {
    const t = await setup();
    t.eng.facts = { ...t.eng.facts, deploymentId: null };
    await t.sync();
    assert.ok(!existsSync(t.file()));
    assert.deepEqual(t.eng.events.filter((e) => e.startsWith('follow')), []);
  });

  test('the size is recorded in the database from time to time, not on every line', async () => {
    const t = await setup();
    t.eng.say('stdout', 'a line', at(1));
    await t.sync(); await t.settle();
    await t.sync(); // the next look writes the size
    assert.ok((await t.row()).bytes > 0);
    await t.collector.stopAll();
  });
});

describe('when the app restarts', () => {
  test('the finished run becomes the previous one and a fresh log begins', async () => {
    const t = await setup();
    t.eng.say('stdout', 'run 1 started', at(1));
    t.eng.say('stderr', 'run 1 CRASHED: out of memory', at(5));
    await t.sync(); await t.settle();
    t.eng.dropFollowers(); // Docker ends the follow stream when a container stops
    t.eng.facts = { ...t.eng.facts, startedAt: at(10) }; // restarted at +10 s
    t.eng.say('stdout', 'run 2 started', at(11));
    await t.sync(); await t.settle(); await t.collector.stopAll();
    assert.deepEqual(t.messages('runtime_previous'), ['run 1 started', 'run 1 CRASHED: out of memory']);
    assert.deepEqual(t.messages('runtime'), ['run 2 started']);
    const r = await t.row();
    assert.deepEqual([r.runStartedAt, r.truncated], [at(10), false]);
    assert.ok((await t.row('runtime_previous')).bytes > 0);
  });

  test('lines the old run printed that were not followed yet still land in the OLD log, up to the moment of the restart', async () => {
    const t = await setup();
    await t.sync();
    t.eng.dropFollowers(); // the stream broke just before the app died
    t.eng.say('stderr', 'last words of run 1', at(9));
    t.eng.dropFollowers(); // Docker ends the follow stream when a container stops
    t.eng.facts = { ...t.eng.facts, startedAt: at(10) };
    t.eng.say('stdout', 'run 2 first line', at(10));
    await t.sync(); await t.settle(); await t.collector.stopAll();
    assert.deepEqual(t.messages('runtime_previous'), ['last words of run 1']);
    assert.deepEqual(t.messages('runtime'), ['run 2 first line']);
  });

  test('only ONE earlier run is kept: the third run replaces the first one\'s record', async () => {
    const t = await setup();
    t.eng.say('stdout', 'first run', at(1));
    await t.sync(); await t.settle();
    t.eng.dropFollowers(); // Docker ends the follow stream when a container stops
    t.eng.facts = { ...t.eng.facts, startedAt: at(10) };
    t.eng.say('stdout', 'second run', at(11));
    await t.sync(); await t.settle();
    t.eng.dropFollowers(); // Docker ends the follow stream when a container stops
    t.eng.facts = { ...t.eng.facts, startedAt: at(20) };
    t.eng.say('stdout', 'third run', at(21));
    await t.sync(); await t.settle(); await t.collector.stopAll();
    assert.deepEqual(t.messages('runtime_previous'), ['second run']);
    assert.deepEqual(t.messages('runtime'), ['third run']);
    assert.ok(!t.text('runtime_previous').includes('first run'));
  });

  test('a restart of an app that printed nothing leaves the previous run alone', async () => {
    const t = await setup();
    t.eng.say('stdout', 'real output', at(1));
    await t.sync(); await t.settle();
    t.eng.dropFollowers(); // Docker ends the follow stream when a container stops
    t.eng.facts = { ...t.eng.facts, startedAt: at(10) };
    await t.sync(); await t.settle(); // run 2 prints nothing
    t.eng.dropFollowers(); // Docker ends the follow stream when a container stops
    t.eng.facts = { ...t.eng.facts, startedAt: at(20) };
    await t.sync(); await t.settle(); await t.collector.stopAll();
    assert.deepEqual(t.messages('runtime_previous'), ['real output']);
  });
});

describe('when the app stops', () => {
  test('the last lines are fetched, the log is closed with its real size, and nothing more is done', async () => {
    const t = await setup();
    t.eng.say('stdout', 'running fine', at(1));
    await t.sync(); await t.settle();
    t.eng.dropFollowers();
    t.eng.say('stderr', 'fatal: goodbye', at(8));
    t.eng.facts = { ...t.eng.facts, status: 'exited' };
    await t.sync();
    assert.deepEqual(t.messages(), ['running fine', 'fatal: goodbye']);
    const r = await t.row();
    assert.notEqual(r.endedAt, null);
    assert.equal(r.bytes, Buffer.byteLength(t.text()));
    const fetches = t.eng.events.filter((e) => e.startsWith('fetch')).length;
    await t.sync(); await t.sync();
    assert.equal(t.eng.events.filter((e) => e.startsWith('fetch')).length, fetches, 'a finished log is not touched again');
  });

  test('an app that is started again after that continues in a fresh run', async () => {
    const t = await setup();
    t.eng.say('stdout', 'before', at(1));
    await t.sync(); await t.settle();
    t.eng.facts = { ...t.eng.facts, status: 'exited' };
    await t.sync();
    t.eng.facts = { ...t.eng.facts, status: 'running', startedAt: at(30) };
    t.eng.say('stdout', 'after', at(31));
    await t.sync(); await t.settle(); await t.collector.stopAll();
    assert.deepEqual(t.messages('runtime_previous'), ['before']);
    assert.deepEqual(t.messages('runtime'), ['after']);
  });
});

describe('runs that start and end between two looks (a crash loop)', () => {
  const died = (t, startedAt, finishedAt) => { t.eng.facts = { ...t.eng.facts, status: 'exited', startedAt, finishedAt }; };

  test('a run the monitor only ever sees already exited is collected whole', async () => {
    const t = await setup();
    t.eng.say('stdout', 'run 1 starting', at(1));
    await t.sync(); await t.settle();
    died(t, at(0), at(3)); await t.sync();             // run 1 seen live, then exited
    t.eng.say('stdout', 'run 2 starting', at(21));      // run 2 began at 20 and died at 23, between two looks
    t.eng.say('stderr', 'run 2 FATAL: connection refused', at(22));
    died(t, at(20), at(23)); await t.sync();
    assert.deepEqual(t.messages('runtime_previous'), ['run 1 starting']);
    assert.deepEqual(t.messages('runtime'), ['run 2 starting', 'run 2 FATAL: connection refused']);
    assert.notEqual((await t.row()).endedAt, null);
  });

  test('every such run in a row replaces the previous one, the newest crash is always readable', async () => {
    const t = await setup();
    t.eng.say('stdout', 'run 1', at(1));
    t.eng.say('stdout', 'run 2', at(21));
    t.eng.say('stdout', 'run 3', at(41));
    died(t, at(0), at(3)); await t.sync();
    died(t, at(20), at(23)); await t.sync();
    died(t, at(40), at(43)); await t.sync();
    assert.deepEqual(t.messages('runtime_previous'), ['run 2']);
    assert.deepEqual(t.messages('runtime'), ['run 3']);
  });

  test('the same exited run is not collected again on the next looks', async () => {
    const t = await setup();
    t.eng.say('stdout', 'only run', at(1));
    died(t, at(0), at(3));
    await t.sync(); await t.sync(); await t.sync();
    assert.deepEqual(t.messages(), ['only run']);
    assert.equal(t.eng.events.filter((e) => e.startsWith('fetch')).length, 1);
  });

  test('a container that is first seen already exited (it crashed right after being deployed) is collected whole', async () => {
    const t = await setup();
    t.eng.say('stderr', 'FATAL: cannot start', at(1));
    died(t, at(0), at(2));
    await t.sync();
    assert.deepEqual(t.messages(), ['FATAL: cannot start']);
  });

  test('what a LATER run printed is not mixed into the run that ended (the read stops where this run stopped)', async () => {
    const t = await setup();
    t.eng.say('stdout', 'run 1 line', at(1));
    t.eng.say('stdout', 'run 2 line (a later run, already started)', at(60));
    died(t, at(0), at(3));
    await t.sync();
    assert.deepEqual(t.messages(), ['run 1 line']);
  });

  test('lines printed in the last moments before the exit are still included', async () => {
    const t = await setup();
    t.eng.say('stderr', 'last gasp', at(3) + 400);
    died(t, at(0), at(3));
    await t.sync();
    assert.deepEqual(t.messages(), ['last gasp']);
  });

  test('a run that was being followed also stops where it stopped', async () => {
    const t = await setup();
    t.eng.say('stdout', 'run 1', at(1));
    await t.sync(); await t.settle();
    t.eng.dropFollowers();
    t.eng.say('stdout', 'a later run', at(60));
    died(t, at(0), at(3));
    await t.sync();
    assert.deepEqual(t.messages(), ['run 1']);
  });
});

describe('when the connection to Docker drops', () => {
  test('the next look reconnects and continues exactly where it left off', async () => {
    const t = await setup();
    t.eng.say('stdout', 'one', at(1));
    t.eng.say('stdout', 'two', at(2));
    await t.sync(); await t.settle();
    t.eng.dropFollowers();
    await t.settle();
    t.eng.say('stdout', 'three (printed while disconnected)', at(3));
    await t.sync(); await t.settle();
    t.eng.say('stdout', 'four', at(4));
    await t.settle(); await t.collector.stopAll();
    assert.deepEqual(t.messages(), ['one', 'two', 'three (printed while disconnected)', 'four']);
  });
});

describe('when the worker itself restarts', () => {
  test('a new collector continues the same run from the file: no gaps, no repeats', async () => {
    const t = await setup();
    t.eng.say('stdout', 'before restart', at(1));
    t.eng.say('stdout', 'also before', at(2));
    await t.sync(); await t.settle(); await t.collector.stopAll();

    t.eng.say('stdout', 'printed while the worker was down', at(3));
    const second = createCollector({ root, db: store, eng: t.eng, loadSecrets: async () => [], log: () => {} });
    t.eng.dropFollowers();
    await second.sync({ id: t.appId }, t.container, { ...t.eng.facts });
    await t.settle();
    t.eng.say('stdout', 'after restart', at(4));
    await t.settle(); await second.stopAll();
    assert.deepEqual(t.messages(), ['before restart', 'also before', 'printed while the worker was down', 'after restart']);
    assert.equal((await t.row('runtime_previous')), null, 'the same run is not a restart');
  });

  test('the app ALSO restarted while the worker was away: the old run\'s last lines still end up in the previous log', async () => {
    const t = await setup();
    t.eng.say('stdout', 'old run, seen', at(1));
    await t.sync(); await t.settle(); await t.collector.stopAll();
    t.eng.dropFollowers();
    t.eng.say('stderr', 'old run, printed while nobody watched', at(8));
    t.eng.facts = { ...t.eng.facts, startedAt: at(10) };
    t.eng.say('stdout', 'new run', at(11));
    const second = createCollector({ root, db: store, eng: t.eng, loadSecrets: async () => [], log: () => {} });
    await second.sync({ id: t.appId }, t.container, { ...t.eng.facts });
    await t.settle(); await second.stopAll();
    assert.deepEqual(t.messages('runtime_previous'), ['old run, seen', 'old run, printed while nobody watched']);
    assert.deepEqual(t.messages('runtime'), ['new run']);
  });

  test('it asks Docker only for lines AFTER the last one it wrote', async () => {
    const t = await setup();
    t.eng.say('stdout', 'a', at(1));
    t.eng.say('stdout', 'b', at(2));
    await t.sync(); await t.settle(); await t.collector.stopAll();
    t.eng.dropFollowers();
    const second = createCollector({ root, db: store, eng: t.eng, loadSecrets: async () => [], log: () => {} });
    await second.sync({ id: t.appId }, t.container, { ...t.eng.facts });
    await second.stopAll();
    assert.equal(t.eng.followSince.at(-1), at(2) + 1);
  });

  test('and even if Docker hands back older lines anyway, nothing is written twice', async () => {
    const t = await setup({});
    t.eng.ignoreSince = true;
    t.eng.say('stdout', 'a', at(1));
    t.eng.say('stdout', 'b', at(2));
    await t.sync(); await t.settle(); await t.collector.stopAll();
    t.eng.dropFollowers();
    const second = createCollector({ root, db: store, eng: t.eng, loadSecrets: async () => [], log: () => {} });
    await second.sync({ id: t.appId }, t.container, { ...t.eng.facts });
    t.eng.say('stdout', 'c', at(3));
    await t.settle(); await second.stopAll();
    assert.deepEqual(t.messages(), ['a', 'b', 'c']);
  });

  test('a log that was already cut short stays cut short after the worker restarts: it is not followed again', async () => {
    const t = await setup({ maxBytes: 300 });
    await t.sync();
    for (let i = 0; i < 30; i++) t.eng.say('stdout', `noisy ${i} ${'z'.repeat(30)}`, at(i + 1));
    await t.settle(); await t.sync(); await t.collector.stopAll();
    const sizeBefore = Buffer.byteLength(t.text());
    t.eng.dropFollowers();
    t.eng.events.length = 0;
    const second = createCollector({ root, db: store, eng: t.eng, loadSecrets: async () => [], log: () => {}, maxBytes: 300 });
    t.eng.say('stdout', 'more noise after the restart', at(99));
    await second.sync({ id: t.appId }, t.container, { ...t.eng.facts });
    await t.settle(); await second.stopAll();
    assert.deepEqual(t.eng.events.filter((e) => e.startsWith('follow')), []);
    assert.equal(Buffer.byteLength(t.text()), sizeBefore);
    assert.equal((await t.row()).truncated, true);
  });

  test('the size cap keeps counting the existing file', async () => {
    const t = await setup({ maxBytes: 300 });
    for (let i = 0; i < 3; i++) t.eng.say('stdout', `line ${i} ${'x'.repeat(20)}`, at(i + 1));
    await t.sync(); await t.settle(); await t.collector.stopAll();
    const second = createCollector({ root, db: store, eng: t.eng, loadSecrets: async () => [], log: () => {}, maxBytes: 300 });
    t.eng.dropFollowers();
    for (let i = 3; i < 30; i++) t.eng.say('stdout', `line ${i} ${'x'.repeat(20)}`, at(i + 1));
    await second.sync({ id: t.appId }, t.container, { ...t.eng.facts }); await t.settle(); await second.stopAll();
    assert.ok(Buffer.byteLength(t.text()) < 300 + 160);
    assert.equal((await t.row()).truncated, true);
  });

  test('if the app exited while the worker was down its last lines are still collected and the log is closed', async () => {
    const t = await setup();
    t.eng.say('stdout', 'alive', at(1));
    await t.sync(); await t.settle(); await t.collector.stopAll();
    t.eng.say('stderr', 'died while nobody watched', at(5));
    t.eng.facts = { ...t.eng.facts, status: 'exited' };
    const second = createCollector({ root, db: store, eng: t.eng, loadSecrets: async () => [], log: () => {} });
    await second.sync({ id: t.appId }, t.container, { ...t.eng.facts });
    assert.deepEqual(t.messages(), ['alive', 'died while nobody watched']);
    assert.notEqual((await t.row()).endedAt, null);
  });

  test('run 1 was unfinished when the worker went down, then run 2 started AND died unseen: both end up in the right files', async () => {
    const t = await setup();
    t.eng.say('stdout', 'run 1 seen', at(1));
    await t.sync(); await t.settle(); await t.collector.stopAll();
    t.eng.dropFollowers();
    t.eng.say('stderr', 'run 1 last words (nobody watched)', at(8));
    t.eng.say('stdout', 'run 2 whole life (nobody watched)', at(21));
    t.eng.facts = { ...t.eng.facts, status: 'exited', startedAt: at(20), finishedAt: at(23) };
    const second = createCollector({ root, db: store, eng: t.eng, loadSecrets: async () => [], log: () => {} });
    await second.sync({ id: t.appId }, t.container, { ...t.eng.facts });
    assert.deepEqual(t.messages('runtime_previous'), ['run 1 seen', 'run 1 last words (nobody watched)']);
    assert.deepEqual(t.messages('runtime'), ['run 2 whole life (nobody watched)']);
  });
});

describe('the size cap', () => {
  test('stops collecting, says the log is truncated, drops the connection and does not reconnect', async () => {
    const t = await setup({ maxBytes: 400 });
    await t.sync();
    for (let i = 0; i < 40; i++) t.eng.say('stdout', `noisy line ${i} ${'y'.repeat(30)}`, at(i + 1));
    await t.settle();
    await t.sync();
    assert.equal((await t.row()).truncated, true);
    assert.ok(Buffer.byteLength(t.text()) < 400 + 200);
    const follows = t.eng.events.filter((e) => e.startsWith('follow')).length;
    t.eng.dropFollowers(); await t.sync(); await t.sync();
    assert.equal(t.eng.events.filter((e) => e.startsWith('follow')).length, follows, 'no reconnect once capped');
    await t.collector.stopAll();
  });

  test('a restart gives the new run a fresh allowance', async () => {
    const t = await setup({ maxBytes: 400 });
    await t.sync();
    for (let i = 0; i < 40; i++) t.eng.say('stdout', `noisy ${i} ${'y'.repeat(30)}`, at(i + 1));
    await t.settle(); await t.sync();
    t.eng.dropFollowers(); // Docker ends the follow stream when a container stops
    t.eng.facts = { ...t.eng.facts, startedAt: at(100) };
    t.eng.say('stdout', 'fresh start', at(101));
    await t.sync(); await t.settle(); await t.collector.stopAll();
    assert.deepEqual(t.messages(), ['fresh start']);
    assert.equal((await t.row()).truncated, false);
    assert.equal((await t.row('runtime_previous')).truncated, true);
  });
});

describe('draining before a container is removed (a redeploy)', () => {
  test('a container that was being followed: the rest is fetched and the log is closed', async () => {
    const t = await setup();
    t.eng.say('stdout', 'running', at(1));
    await t.sync(); await t.settle();
    t.eng.dropFollowers();
    t.eng.say('stdout', 'final words', at(6));
    await t.collector.drain(t.container, { appId: t.appId });
    assert.deepEqual(t.messages(), ['running', 'final words']);
    assert.notEqual((await t.row()).endedAt, null);
  });

  test('a container nobody was watching yet (deployed seconds ago) is collected whole', async () => {
    const t = await setup();
    t.eng.say('stdout', 'booting', at(1));
    t.eng.say('stdout', 'ready', at(2));
    t.eng.facts = { ...t.eng.facts, status: 'exited' };
    await t.collector.drain(t.container, { appId: t.appId });
    assert.deepEqual(t.messages(), ['booting', 'ready']);
    assert.notEqual((await t.row()).endedAt, null);
  });

  test('if the container is already gone it still closes the log cleanly', async () => {
    const t = await setup();
    t.eng.say('stdout', 'seen', at(1));
    await t.sync(); await t.settle();
    t.eng.failFetch = true;
    await t.collector.drain(t.container, { appId: t.appId });
    assert.deepEqual(t.messages(), ['seen']);
    assert.notEqual((await t.row()).endedAt, null);
  });

  test('a container that never started has nothing to drain', async () => {
    const t = await setup();
    t.eng.facts = { ...t.eng.facts, status: 'created', startedAt: null };
    await t.collector.drain(t.container, { appId: t.appId });
    assert.ok(!existsSync(t.file()));
  });

  test('two operations on one container are never in flight together (the first is held mid-way to prove it)', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const t = await setup({ loadSecrets: async () => { await gate; return []; } });
    t.eng.say('stdout', 'one', at(1));
    t.eng.say('stdout', 'two', at(2));
    const look = t.sync(); // starts collecting and stalls while loading the secrets
    const drain = t.collector.drain(t.container, { appId: t.appId }); // arrives while the look is still in progress
    await t.settle();
    release();
    await Promise.all([look, drain]);
    await t.settle(); await t.collector.stopAll();
    assert.deepEqual(t.messages(), ['one', 'two']);
  });

  test('a look and a drain at the very same moment are done one after the other, so nothing is collected twice', async () => {
    const t = await setup();
    t.eng.say('stdout', 'one', at(1));
    t.eng.say('stdout', 'two', at(2));
    await Promise.all([t.sync(), t.collector.drain(t.container, { appId: t.appId })]);
    await t.settle(); await t.collector.stopAll();
    assert.deepEqual(t.messages(), ['one', 'two']);
    assert.equal((await t.row()).endedAt !== null, true);
  });

  test('draining while the monitor looks at the same container does not collect twice', async () => {
    const t = await setup();
    t.eng.say('stdout', 'one', at(1));
    t.eng.facts = { ...t.eng.facts, status: 'exited' };
    await Promise.all([t.sync(), t.collector.drain(t.container, { appId: t.appId }), t.sync()]);
    assert.deepEqual(t.messages(), ['one']);
  });
});

describe('shutting down', () => {
  test('stopAll() closes every log with its real size so nothing stays marked as being written', async () => {
    const t = await setup();
    t.eng.say('stdout', 'x', at(1));
    await t.sync(); await t.settle();
    await t.collector.stopAll();
    const r = await t.row();
    assert.notEqual(r.endedAt, null);
    assert.equal(r.bytes, Buffer.byteLength(t.text()));
  });
});
