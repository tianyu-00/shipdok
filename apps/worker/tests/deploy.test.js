// deploy()'s orchestration against a fake engine: order of steps, cleanup, swap, rollback and cancellation.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { deploy } from '../src/deploy.js';
import { fakeEngine, abortError } from './fake-engine.js';

const BASE = { repo: 'https://github.com/o/r.git', appId: 'app-1', slug: 'my-app', deploymentId: 'dep-1', containerPort: 3000, hostPort: 8080, log: () => {} };
const IMAGE = 'shipdok/my-app:dep-1';
const run = (opts, eng) => deploy({ ...BASE, ...opts }, eng);

describe('a normal deployment', () => {
  test('runs the steps in order and replaces the old container only after the candidate is healthy', async () => {
    const eng = fakeEngine({ previous: ['old'] });
    const r = await run({}, eng);
    assert.equal(r.ok, true);
    assert.deepEqual(eng.events, [
      'run git clone', 'run docker build',
      'create shipdok-my-app-dep-1-candidate port=temp', 'start shipdok-my-app-dep-1-candidate',
      'health shipdok-my-app-dep-1-candidate', 'remove shipdok-my-app-dep-1-candidate',
      'stop old',
      'create shipdok-my-app-dep-1-live port=8080', 'start shipdok-my-app-dep-1-live',
      'health shipdok-my-app-dep-1-live', 'remove old',
    ]);
  });

  test('reports progress and the resolved commit through its hooks, and cleans up the temp directory', async () => {
    const eng = fakeEngine();
    const seen = [];
    await run({ onStatus: (s) => seen.push(s), onCommit: (c) => seen.push(`commit:${c}`) }, eng);
    assert.deepEqual(seen, ['commit:abc123def', 'starting', 'validating']);
    assert.ok(eng.workDir && !existsSync(eng.workDir), 'the clone directory must be removed');
  });

  test('a hook that throws cannot break the deployment', async () => {
    const r = await run({ onStatus: () => { throw new Error('boom'); } }, fakeEngine());
    assert.equal(r.ok, true);
  });
});

describe('building an exact commit (webhook pushes)', () => {
  const COMMIT = 'c'.repeat(40);

  test('fetches that commit instead of cloning the branch head', async () => {
    const eng = fakeEngine({ head: COMMIT });
    const r = await run({ commit: COMMIT }, eng);
    assert.equal(r.ok, true);
    assert.deepEqual(eng.events.slice(0, 5), ['run git init', 'run git remote', 'run git fetch', 'run git checkout', 'run docker build']);
    assert.ok(!eng.events.includes('run git clone'));
    const fetch = eng.runs.find((x) => x.args.includes('fetch'));
    assert.ok(fetch.args.includes(COMMIT), 'the exact commit is what gets fetched');
    assert.equal(fetch.args.at(-2), '--', 'the commit must come after -- so git can never read it as an option');
    assert.equal(fetch.args.at(-1), COMMIT);
    assert.deepEqual(eng.runs.find((x) => x.args.includes('remote')).args.slice(-3), ['add', 'origin', BASE.repo]);
    assert.ok(!existsSync(eng.workDir));
  });

  test('records the commit that was really checked out', async () => {
    const seen = [];
    await run({ commit: COMMIT, onCommit: (c) => seen.push(c) }, fakeEngine({ head: COMMIT }));
    assert.deepEqual(seen, [COMMIT]);
  });

  test('refuses to build if git ends up on a different commit, before anything is built or started', async () => {
    const eng = fakeEngine({ previous: ['old'], head: 'd'.repeat(40) });
    const r = await run({ commit: COMMIT }, eng);
    assert.equal(r.ok, false);
    assert.match(r.error, /does not match the requested one/);
    assert.ok(!eng.events.includes('run docker build'));
    assert.ok(!eng.events.some((e) => e.includes('old') || e.startsWith('create')));
    assert.ok(!existsSync(eng.workDir));
  });

  for (const [label, commit] of [
    ['a git option', '--upload-pack=evil'],
    ['a branch name', 'main'],
    ['an abbreviated commit', 'abc1234'],
    ['uppercase hex', 'C'.repeat(40)],
    ['a commit with a trailing newline', `${'c'.repeat(40)}\n`],
    ['a commit with a space', `${'c'.repeat(39)} `],
    ['an empty string', ''],
    ['a number', 12345],
  ]) {
    test(`rejects ${label} before any side effect`, async () => {
      const eng = fakeEngine();
      const r = await run({ commit }, eng);
      assert.deepEqual([r.ok, r.error], [false, 'Invalid commit id']);
      assert.deepEqual(eng.events, []);
    });
  }

  test('a 64-character (SHA-256) commit id is accepted', async () => {
    const sha256 = 'e'.repeat(64);
    assert.equal((await run({ commit: sha256 }, fakeEngine({ head: sha256 }))).ok, true);
  });

  test('without a commit the old clone behaviour is unchanged', async () => {
    const eng = fakeEngine();
    await run({}, eng);
    assert.equal(eng.events[0], 'run git clone');
  });

  test('a stop during the fetch is clean, like any other stage', async () => {
    const ctl = new AbortController();
    const eng = fakeEngine({ onRun: (cmd, args) => { if (args.includes('fetch')) { ctl.abort(); throw abortError(); } } });
    const r = await run({ commit: COMMIT, signal: ctl.signal }, eng);
    assert.deepEqual([r.ok, r.stopped], [false, true]);
    assert.ok(!existsSync(eng.workDir));
  });
});

describe('failures leave the running version alone', () => {
  test('a failed build never touches the live container', async () => {
    const eng = fakeEngine({ previous: ['old'], onRun: (cmd) => { if (cmd === 'docker') throw new Error('build failed'); } });
    const r = await run({}, eng);
    assert.deepEqual([r.ok, r.error], [false, 'build failed']);
    assert.ok(!eng.events.some((e) => e.includes('old')));
    assert.ok(!existsSync(eng.workDir));
  });

  test('an unhealthy candidate is removed and the old container is never stopped', async () => {
    const eng = fakeEngine({ previous: ['old'], health: { candidate: async () => { throw new Error('Health check timed out'); } } });
    const r = await run({}, eng);
    assert.equal(r.ok, false);
    assert.match(r.error, /timed out/);
    assert.ok(eng.events.includes('remove shipdok-my-app-dep-1-candidate'));
    assert.ok(!eng.events.includes('stop old'));
    assert.ok(!existsSync(eng.workDir));
  });

  test('if the new live container is unhealthy, it is removed and the old one is restarted', async () => {
    const eng = fakeEngine({ previous: ['old'], health: { live: async () => { throw new Error('Container exited early'); } } });
    const r = await run({}, eng);
    assert.equal(r.ok, false);
    const tail = eng.events.slice(eng.events.indexOf('stop old'));
    assert.deepEqual(tail, [
      'stop old',
      'create shipdok-my-app-dep-1-live port=8080', 'start shipdok-my-app-dep-1-live', 'health shipdok-my-app-dep-1-live',
      'remove shipdok-my-app-dep-1-live', 'start old',
    ]);
    assert.ok(!eng.events.includes('remove old'));
  });

  test('an escaping root directory is refused before anything happens', async () => {
    const eng = fakeEngine();
    const r = await run({ dir: '../x' }, eng);
    assert.equal(r.ok, false);
    assert.match(r.error, /inside the repository/);
    assert.deepEqual(eng.events, []);
  });
});

describe('cancellation before the swap', () => {
  test('aborting during the build stops cleanly: unused image removed, old container untouched', async () => {
    const ctl = new AbortController();
    const eng = fakeEngine({
      previous: ['old'],
      onRun: (cmd) => { if (cmd === 'docker') { ctl.abort(); throw abortError(); } },
    });
    const r = await run({ signal: ctl.signal }, eng);
    assert.deepEqual([r.ok, r.stopped], [false, true]);
    assert.ok(eng.events.includes(`rmi ${IMAGE}`));
    assert.ok(!eng.events.some((e) => e.includes('old') || e.includes('candidate')));
    assert.ok(!existsSync(eng.workDir));
  });

  test('aborting while the candidate is starting removes the candidate and the image', async () => {
    const ctl = new AbortController();
    const eng = fakeEngine({
      previous: ['old'],
      health: { candidate: async () => { ctl.abort(); throw abortError(); } },
    });
    const r = await run({ signal: ctl.signal }, eng);
    assert.deepEqual([r.ok, r.stopped], [false, true]);
    assert.ok(eng.events.includes('remove shipdok-my-app-dep-1-candidate'));
    assert.ok(eng.events.includes(`rmi ${IMAGE}`), `the image must really be removed: ${eng.events.filter((e) => e.startsWith('rmi'))}`);
    assert.ok(eng.events.indexOf('remove shipdok-my-app-dep-1-candidate') < eng.events.indexOf(`rmi ${IMAGE}`), 'candidate must go first');
    assert.ok(!eng.events.some((e) => e.startsWith('rmi-BLOCKED')));
    assert.ok(!eng.events.includes('stop old'));
    assert.ok(!existsSync(eng.workDir));
  });

  test('an abort that arrives between steps is noticed before the candidate starts', async () => {
    const ctl = new AbortController();
    const eng = fakeEngine({ onRun: (cmd) => { if (cmd === 'docker') ctl.abort(); } }); // build "finishes" but the signal fired
    const r = await run({ signal: ctl.signal }, eng);
    assert.equal(r.stopped, true);
    assert.ok(!eng.events.some((e) => e.startsWith('create')));
  });

  test('a stop is not reported as a failure', async () => {
    const ctl = new AbortController();
    const eng = fakeEngine({ health: { candidate: async () => { ctl.abort(); throw abortError(); } } });
    const r = await run({ signal: ctl.signal }, eng);
    assert.equal(r.error, undefined);
  });

  test('the gate can refuse the swap: candidate gone, image removed, old container untouched', async () => {
    const eng = fakeEngine({ previous: ['old'] });
    const r = await run({ beforeSwap: async () => ({ proceed: false, outcome: 'superseded', by: 'newer-id' }) }, eng);
    assert.deepEqual([r.ok, r.stopped, r.outcome, r.by], [false, true, 'superseded', 'newer-id']);
    assert.ok(eng.events.includes('remove shipdok-my-app-dep-1-candidate'));
    assert.ok(eng.events.includes(`rmi ${IMAGE}`), 'the image must really be removed');
    assert.ok(!eng.events.some((e) => e.startsWith('rmi-BLOCKED')));
    assert.ok(!eng.events.includes('stop old'));
    assert.ok(!eng.events.some((e) => e.includes('-live')));
    assert.ok(!existsSync(eng.workDir));
  });

  test('the gate runs after the candidate is healthy and before the old container is stopped', async () => {
    const eng = fakeEngine({ previous: ['old'] });
    await run({ beforeSwap: async () => { eng.events.push('GATE'); return { proceed: true }; } }, eng);
    const i = (e) => eng.events.indexOf(e);
    assert.ok(i('health shipdok-my-app-dep-1-candidate') < i('GATE'));
    assert.ok(i('GATE') < i('stop old'));
  });
});

describe('the swap is the point of no return', () => {
  test('an abort during the swap is ignored and the deployment completes', async () => {
    const ctl = new AbortController();
    const eng = fakeEngine({ previous: ['old'] });
    const r = await run({
      signal: ctl.signal,
      beforeSwap: async () => { setImmediate(() => ctl.abort()); return { proceed: true }; }, // cancel lands right after the gate
    }, eng);
    assert.equal(r.ok, true);
    assert.ok(eng.events.includes('remove old'));
    assert.ok(!eng.events.includes('rmi shipdok/my-app:dep-1'));
  });

  test('a failure after the gate is a normal failure (with rollback), even if a stop was requested', async () => {
    const ctl = new AbortController();
    const eng = fakeEngine({
      previous: ['old'],
      health: { live: async () => { ctl.abort(); throw new Error('Container exited early'); } },
    });
    const r = await run({ signal: ctl.signal, beforeSwap: async () => ({ proceed: true }) }, eng);
    assert.equal(r.ok, false);
    assert.equal(r.stopped, undefined);
    assert.match(r.error, /exited early/);
    assert.ok(eng.events.includes('start old'));
    assert.ok(!eng.events.includes(`rmi ${IMAGE}`)); // a failed swap does not delete the image
  });
});

describe('GitHub access token handling', () => {
  const gitEnv = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: 'Authorization: Basic c2VjcmV0' };

  test('only git commands receive the token; docker builds never do', async () => {
    const eng = fakeEngine();
    process.env.APP_SECRETS_KEY ??= 'x'.repeat(64);
    const r = await run({ gitEnv }, eng);
    assert.equal(r.ok, true);
    const gits = eng.runs.filter((x) => x.cmd === 'git');
    assert.ok(gits.length > 0);
    for (const g of gits) assert.equal(g.opts.env.GIT_CONFIG_VALUE_0, gitEnv.GIT_CONFIG_VALUE_0);
    for (const d of eng.runs.filter((x) => x.cmd !== 'git')) {
      assert.ok(!JSON.stringify(d).includes('c2VjcmV0'), 'token must not reach docker');
    }
  });

  test('git does not inherit the worker secrets', async () => {
    const eng = fakeEngine();
    process.env.APP_SECRETS_KEY = 'a1'.repeat(32);
    await run({ gitEnv }, eng);
    for (const g of eng.runs.filter((x) => x.cmd === 'git')) {
      assert.equal(g.opts.env.APP_SECRETS_KEY, undefined);
      assert.equal(g.opts.env.GIT_TERMINAL_PROMPT, '0');
    }
  });

  test('a failure message never contains the token', async () => {
    const eng = fakeEngine({ onRun: (cmd) => { if (cmd === 'git') throw new Error('git exited 128'); } });
    const r = await run({ gitEnv }, eng);
    assert.equal(r.ok, false);
    assert.ok(!JSON.stringify(r).includes('c2VjcmV0'));
  });
});

describe('deploying an app that is stopped', () => {
  const LIVE = 'shipdok-my-app-dep-1-live';
  const stopped = { beforeSwap: async () => ({ proceed: true, start: false }) };

  test('still builds and validates a candidate, then swaps the containers but leaves the new one NOT started', async () => {
    const eng = fakeEngine({ previous: ['old'], stopped: ['old'] });
    const r = await run(stopped, eng);
    assert.equal(r.ok, true);
    assert.equal(r.started, false);
    assert.ok(eng.events.includes('health shipdok-my-app-dep-1-candidate'), 'the new version is still proven to work');
    assert.ok(eng.events.includes(`create ${LIVE} port=8080`), 'the new live container exists so Start can run it later');
    assert.ok(!eng.events.includes(`start ${LIVE}`));
    assert.ok(!eng.events.includes(`health ${LIVE}`));
    assert.ok(eng.events.includes('remove old'), 'the previous version is replaced');
  });

  test('a stopped app with no previous container still ends up with a created, not started, container', async () => {
    const eng = fakeEngine({ previous: [] });
    const r = await run(stopped, eng);
    assert.equal(r.ok, true);
    assert.ok(eng.events.includes(`create ${LIVE} port=8080`));
    assert.ok(!eng.events.includes(`start ${LIVE}`));
  });

  test('the same unchanged behaviour for a normal deployment: started, and it says so', async () => {
    const eng = fakeEngine({ previous: ['old'] });
    const r = await run({ beforeSwap: async () => ({ proceed: true }) }, eng);
    assert.equal(r.started, true);
    assert.ok(eng.events.includes(`start ${LIVE}`));
  });

  test('without a gate (the command line) the app is started', async () => {
    const r = await run({}, fakeEngine({ previous: [] }));
    assert.equal(r.started, true);
  });

  test('if creating the new container fails, only containers that WERE running are restarted', async () => {
    const eng = fakeEngine({
      previous: ['old-running', 'old-stopped'], stopped: ['old-stopped'],
      failOn: { 'create live': new Error('no space left') },
    });
    const r = await run({}, eng);
    assert.equal(r.ok, false);
    assert.ok(eng.events.includes('start old-running'), 'what was serving traffic comes back');
    assert.ok(!eng.events.includes('start old-stopped'), 'a failed deployment must not start an app that was stopped');
  });

  test('a failed swap of a stopped app never starts it', async () => {
    const eng = fakeEngine({ previous: ['old'], stopped: ['old'], health: { live: async () => { throw new Error('unhealthy'); } } });
    const r = await run({ beforeSwap: async () => ({ proceed: true, start: true }) }, eng);
    assert.equal(r.ok, false);
    assert.ok(!eng.events.includes('start old'));
  });
});

describe('the deployment log', () => {
  const sink = { write() {}, line() {} };

  test('git and docker build both write to the deployment\'s log sink', async () => {
    const eng = fakeEngine({ previous: [] });
    await run({ logSink: sink }, eng);
    const withSink = eng.runs.filter((r) => r.opts.sink === sink).map((r) => r.cmd);
    assert.ok(withSink.includes('git'), 'git output is logged');
    assert.ok(withSink.includes('docker'), 'the build output is logged');
    assert.ok(eng.runs.every((r) => r.opts.sink === sink), 'every command that talks to the outside world is');
  });

  test('without a sink (the command line) nothing changes', async () => {
    const eng = fakeEngine({ previous: [] });
    await run({}, eng);
    assert.ok(eng.runs.every((r) => r.opts.sink === undefined));
  });

  test('the build asks for plain progress, so the file is readable and not full of terminal redrawing', async () => {
    const eng = fakeEngine({ previous: [] });
    await run({}, eng);
    const build = eng.runs.find((r) => r.cmd === 'docker');
    assert.ok(build.args.includes('--progress=plain'));
  });
});

describe('saving the old version\'s output before it is removed', () => {
  const OLD = 'old';
  test('the old container is handed over AFTER the new one is live and BEFORE it is removed', async () => {
    const eng = fakeEngine({ previous: [OLD] });
    await run({ onRetire: async (c) => { eng.events.push(`RETIRE ${c.name}`); } }, eng);
    const i = (e) => eng.events.indexOf(e);
    assert.ok(i('health shipdok-my-app-dep-1-live') < i('RETIRE old'), 'the new version is already serving');
    assert.ok(i('stop old') < i('RETIRE old'), 'the old one has stopped, so its output is complete');
    assert.ok(i('RETIRE old') < i('remove old'));
  });

  test('every old container is handed over', async () => {
    const eng = fakeEngine({ previous: ['old-a', 'old-b'] });
    const seen = [];
    await run({ onRetire: async (c) => { seen.push(c.name); } }, eng);
    assert.deepEqual(seen, ['old-a', 'old-b']);
  });

  test('nothing to hand over on a first deployment', async () => {
    let called = false;
    await run({ onRetire: async () => { called = true; } }, fakeEngine({ previous: [] }));
    assert.equal(called, false);
  });

  test('not handed over when the swap fails and the old version is restored', async () => {
    const eng = fakeEngine({ previous: [OLD], health: { live: async () => { throw new Error('unhealthy'); } } });
    let called = false;
    const r = await run({ onRetire: async () => { called = true; } }, eng);
    assert.equal(r.ok, false);
    assert.equal(called, false);
    assert.ok(eng.events.includes('start old'));
  });

  test('a hook that fails cannot stop the deployment or the removal', async () => {
    const eng = fakeEngine({ previous: [OLD] });
    const r = await run({ onRetire: async () => { throw new Error('disk full'); } }, eng);
    assert.equal(r.ok, true);
    assert.ok(eng.events.includes('remove old'));
  });

  test('a hook that hangs is given up on after a while, and the removal still happens', async () => {
    const eng = fakeEngine({ previous: [OLD] });
    const t = Date.now();
    const r = await run({ onRetire: () => new Promise(() => {}), retireTimeoutMs: 40 }, eng);
    assert.equal(r.ok, true);
    assert.ok(eng.events.includes('remove old'));
    assert.ok(Date.now() - t < 3000);
  });

  test('without a hook nothing changes', async () => {
    const eng = fakeEngine({ previous: [OLD] });
    assert.equal((await run({}, eng)).ok, true);
  });
});
