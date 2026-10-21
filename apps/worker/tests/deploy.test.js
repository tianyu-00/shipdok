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

describe('build-time variables', () => {
  const buildOf = (eng) => eng.runs.find((r) => r.cmd === 'docker' && r.args[0] === 'build');

  test('each one is a --build-arg NAME with no value, and the value is only in docker\'s environment', async () => {
    const eng = fakeEngine({ previous: [] });
    await run({ buildEnv: ['VITE_API=https://api.example.com', 'NPM_TOKEN=s3cr3t-token'] }, eng);
    const b = buildOf(eng);
    const i = b.args.indexOf('--build-arg');
    assert.deepEqual(b.args.slice(i, i + 4), ['--build-arg', 'VITE_API', '--build-arg', 'NPM_TOKEN']);
    assert.ok(!b.args.join(' ').includes('s3cr3t-token') && !b.args.join(' ').includes('api.example.com'), 'no value on the command line');
    assert.equal(b.opts.env.NPM_TOKEN, 's3cr3t-token');
    assert.equal(b.opts.env.VITE_API, 'https://api.example.com');
  });

  test('a secret is --secret id=NAME,env=NAME with the value only in docker\'s environment, and is not a --build-arg', async () => {
    const eng = fakeEngine({ previous: [] });
    const lines = [];
    await run({ buildSecretEnv: ['NPM_TOKEN=s3cr3t-token'], log: (m) => lines.push(m) }, eng);
    const b = buildOf(eng);
    const i = b.args.indexOf('--secret');
    assert.deepEqual(b.args.slice(i, i + 2), ['--secret', 'id=NPM_TOKEN,env=NPM_TOKEN']);
    assert.ok(!b.args.includes('--build-arg'));
    assert.ok(!b.args.join(' ').includes('s3cr3t-token'), 'no value on the command line');
    assert.equal(b.opts.env.NPM_TOKEN, 's3cr3t-token');
    const line = lines.find((l) => /build secrets/.test(l));
    assert.ok(line && line.includes('NPM_TOKEN') && /RUN --mount=type=secret/.test(line) && !line.includes('s3cr3t-token'));
    assert.ok(!lines.some((l) => /build arguments/.test(l)), 'a secret is not described as an argument');
  });

  test('a secret is NOT given to the containers, and a bad secret name fails before the build', async () => {
    const eng = fakeEngine({ previous: ['old'] });
    await run({ env: ['RUN=1'], buildSecretEnv: ['S=1'] }, eng);
    for (const c of eng.created) assert.deepEqual(c.env, ['RUN=1'], c.name);
    const eng2 = fakeEngine({ previous: ['old'] });
    const r = await run({ buildSecretEnv: ['PATH=/x'] }, eng2);
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /PATH/);
    assert.ok(!buildOf(eng2));
  });

  test('they are NOT given to the containers', async () => {
    const eng = fakeEngine({ previous: [] });
    await run({ env: ['RUN=1'], buildEnv: ['BUILD_ONLY=2'] }, eng);
    for (const c of eng.created) assert.deepEqual(c.env, ['RUN=1'], c.name);
  });

  test('docker\'s environment is the short one: no APP_SECRETS_KEY from the worker', async () => {
    const eng = fakeEngine({ previous: [] });
    process.env.APP_SECRETS_KEY ??= 'a'.repeat(64);
    await run({ buildEnv: ['A=1'] }, eng);
    assert.ok(!('APP_SECRETS_KEY' in buildOf(eng).opts.env));
    assert.equal(buildOf(eng).opts.env.DOCKER_BUILDKIT, '1');
  });

  test('the log names them (never a value) and says the Dockerfile must declare them', async () => {
    const eng = fakeEngine({ previous: [] });
    const lines = [];
    await run({ buildEnv: ['TOKEN=topsecretvalue'], log: (m) => lines.push(m) }, eng);
    const line = lines.find((l) => /build arguments/.test(l));
    assert.ok(line && line.includes('TOKEN') && /ARG/.test(line) && !line.includes('topsecretvalue'));
  });

  test('none: no --build-arg and no extra line', async () => {
    const eng = fakeEngine({ previous: [] });
    const lines = [];
    await run({ log: (m) => lines.push(m) }, eng);
    assert.ok(!buildOf(eng).args.includes('--build-arg'));
    assert.ok(!lines.some((l) => /build arguments/.test(l)));
  });

  test('a name that cannot be used fails the deployment before anything is built, naming it', async () => {
    const eng = fakeEngine({ previous: ['old'] });
    const r = await run({ buildEnv: ['DOCKER_HOST=tcp://evil:2375'] }, eng);
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /DOCKER_HOST/);
    assert.ok(!buildOf(eng), 'docker build never ran');
  });

  test('a rollback builds nothing, so build variables are not looked at', async () => {
    const eng = fakeEngine({ appId: 'app-1', previous: [] });
    const r = await run({ reuseImage: 'shipdok/my-app:11111111-1111-4111-8111-111111111111', buildEnv: ['DOCKER_HOST=x'] }, eng);
    assert.equal(r.ok, true);
    assert.ok(!buildOf(eng));
  });
});

describe('the image carries the ownership labels', () => {
  test('a Dockerfile build is labelled with the app and the deployment (rollback, clean-up and the Storage page find images by them)', async () => {
    const eng = fakeEngine({ previous: [] });
    await run({}, eng);
    const b = eng.runs.find((r) => r.cmd === 'docker' && r.args[0] === 'build');
    const labels = b.args.flatMap((a, i) => (a === '--label' ? [b.args[i + 1]] : []));
    assert.deepEqual(labels, ['shipdok.managed=true', 'shipdok.app-id=app-1', 'shipdok.deployment-id=dep-1']);
  });
});

describe('the build method decides how the app is started', () => {
  const reuseImage = 'shipdok/my-app:11111111-1111-4111-8111-111111111111';
  test('an image whose method label says something this worker does not know is not given a PORT', async () => {
    const images = { [reuseImage]: { labels: { 'shipdok.managed': 'true', 'shipdok.app-id': 'app-1', 'shipdok.build-method': 'something-else' } } };
    const eng = fakeEngine({ previous: [], appId: 'app-1', images });
    await run({ reuseImage, env: ['A=1'] }, eng);
    for (const c of eng.created) assert.deepEqual(c.env, ['A=1'], c.name);
  });
});

describe('building without the cache', () => {
  const buildOf = (eng) => eng.runs.find((r) => r.cmd === 'docker' && r.args[0] === 'build');

  test('noCache adds --no-cache to the build, and the log line says so', async () => {
    const eng = fakeEngine({ previous: [] });
    const lines = [];
    await run({ noCache: true, log: (m) => lines.push(m) }, eng);
    assert.ok(buildOf(eng).args.includes('--no-cache'));
    assert.ok(lines.some((l) => /without the build cache/.test(l)));
  });

  test('by default, and for anything but true, the cache is used', async () => {
    for (const noCache of [undefined, false, 'true', 1]) {
      const eng = fakeEngine({ previous: [] });
      await run({ noCache }, eng);
      assert.ok(!buildOf(eng).args.includes('--no-cache'), `noCache=${String(noCache)}`);
    }
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

describe('a rollback: running an image that already exists', () => {
  const OLD_ID = '11111111-1111-4111-8111-111111111111';
  const OLD_IMAGE = `shipdok/my-app:${OLD_ID}`;
  const eng0 = (cfg = {}) => fakeEngine({ appId: 'app-1', ...cfg });

  test('does not clone or build: the steps are candidate, health, swap, and the old container is retired', async () => {
    const eng = eng0({ previous: ['old'] });
    const r = await run({ reuseImage: OLD_IMAGE }, eng);
    assert.equal(r.ok, true);
    assert.equal(r.image, OLD_IMAGE);
    assert.ok(!eng.events.some((e) => e.startsWith('run ')), 'no git, no docker build');
    assert.deepEqual(eng.events.filter((e) => !e.startsWith('inspect-image')), [
      'create shipdok-my-app-dep-1-candidate port=temp', 'start shipdok-my-app-dep-1-candidate',
      'health shipdok-my-app-dep-1-candidate', 'remove shipdok-my-app-dep-1-candidate',
      'stop old',
      'create shipdok-my-app-dep-1-live port=8080', 'start shipdok-my-app-dep-1-live',
      'health shipdok-my-app-dep-1-live', 'remove old',
    ]);
  });

  test('the containers are made from the reused image', async () => {
    const eng = eng0();
    const made = [];
    const create = eng.createContainer;
    eng.createContainer = async (o) => { made.push(o.image); return create(o); };
    await run({ reuseImage: OLD_IMAGE }, eng);
    assert.deepEqual([...new Set(made)], [OLD_IMAGE]);
  });

  test('reports the image size, for a normal build as well', async () => {
    assert.equal((await run({ reuseImage: OLD_IMAGE }, eng0({ imageSize: 4242 }))).imageBytes, 4242);
    assert.equal((await run({}, eng0({ imageSize: 777 }))).imageBytes, 777);
  });

  test('an image size that cannot be read never fails the deployment', async () => {
    const eng = eng0();
    eng.imageSize = async () => { throw new Error('no such image'); };
    const r = await run({}, eng);
    assert.equal(r.ok, true);
    assert.equal(r.imageBytes, null);
  });

  test('NEVER deletes the reused image, whichever way the deployment ends', async () => {
    const outcomes = {
      'candidate unhealthy': eng0({ previous: ['old'], health: { candidate: async () => { throw new Error('not healthy'); } } }),
      'gate refuses': (() => { return eng0({ previous: ['old'] }); })(),
      'swap fails': eng0({ previous: ['old'], health: { live: async () => { throw new Error('live unhealthy'); } } }),
      'success': eng0({ previous: ['old'] }),
    };
    for (const [label, eng] of Object.entries(outcomes)) {
      await run({ reuseImage: OLD_IMAGE, beforeSwap: label === 'gate refuses' ? async () => ({ proceed: false, outcome: 'cancelled' }) : undefined }, eng);
      assert.ok(!eng.events.some((e) => e.startsWith('rmi')), `${label}: the image must stay`);
    }
  });

  test('a stop on request before the swap keeps the reused image too', async () => {
    const controller = new AbortController();
    const eng = eng0({ previous: ['old'], health: { candidate: async () => { controller.abort(); throw abortError(); } } });
    const r = await run({ reuseImage: OLD_IMAGE, signal: controller.signal }, eng);
    assert.equal(r.stopped, true);
    assert.ok(!eng.events.some((e) => e.startsWith('rmi')));
    assert.ok(!eng.events.includes('stop old'), 'the old container is untouched');
  });

  test('for contrast: a normal build that is stopped DOES delete its own image', async () => {
    const eng = eng0({ previous: ['old'] });
    const r = await run({ beforeSwap: async () => ({ proceed: false, outcome: 'cancelled' }) }, eng);
    assert.equal(r.stopped, true);
    assert.ok(eng.events.includes(`rmi ${IMAGE}`));
  });

  test('an image that no longer exists is a clear failure and nothing is touched', async () => {
    const eng = eng0({ previous: ['old'], images: {} });
    const r = await run({ reuseImage: OLD_IMAGE }, eng);
    assert.equal(r.ok, false);
    assert.match(r.error, /no longer exists/i);
    assert.ok(!eng.events.some((e) => e.startsWith('create') || e.startsWith('stop') || e.startsWith('run ')));
  });

  test('an image that belongs to another app is refused', async () => {
    const eng = eng0({ images: { [OLD_IMAGE]: { labels: { 'shipdok.managed': 'true', 'shipdok.app-id': 'some-other-app' } } } });
    const r = await run({ reuseImage: OLD_IMAGE }, eng);
    assert.equal(r.ok, false);
    assert.match(r.error, /does not belong/i);
    assert.ok(!eng.events.some((e) => e.startsWith('create')));
  });

  test('an image Shipdok did not build is refused', async () => {
    const eng = eng0({ images: { [OLD_IMAGE]: { labels: { 'shipdok.app-id': 'app-1' } } } });
    const r = await run({ reuseImage: OLD_IMAGE }, eng);
    assert.equal(r.ok, false);
    assert.ok(!eng.events.some((e) => e.startsWith('create')));
  });

  for (const [label, image] of [
    ['another app\'s image', `shipdok/other-app:${OLD_ID}`],
    ['another app\'s image whose name is just as long', `shipdok/my-bpp:${OLD_ID}`],
    ['a registry image', 'nginx:latest'],
    ['an image with a path escape', `shipdok/my-app/../x:${OLD_ID}`],
    ['no deployment id', 'shipdok/my-app:latest'],
    ['an option-looking value', `--privileged`],
    ['an empty value', ''],
    ['a tag with extra text', `shipdok/my-app:${OLD_ID} --rm`],
  ]) {
    test(`refuses ${label} before any side effect`, async () => {
      const eng = eng0({ previous: ['old'] });
      const r = await run({ reuseImage: image }, eng);
      assert.equal(r.ok, false);
      assert.match(r.error, /invalid image/i);
      assert.deepEqual(eng.events, []);
    });
  }
});

describe('the build time limit', () => {
  // A command that never finishes by itself: it ends only when the signal it was given fires, like a killed child process.
  const hangs = (which) => (cmd, args, opts) => {
    if (cmd !== which) return undefined;
    return new Promise((_, reject) => {
      if (opts.signal?.aborted) return reject(abortError());
      opts.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
    });
  };
  const MINUTE = 1 / 60_000 * 50; // 50 ms, as minutes

  test('a build that runs past the limit is stopped and fails with a clear message; the running version is untouched', async () => {
    const eng = fakeEngine({ previous: ['old'], onRun: hangs('docker') });
    const logged = [];
    const r = await run({ buildTimeoutMinutes: MINUTE, log: (m) => logged.push(m) }, eng);
    assert.equal(r.ok, false);
    assert.ok(!r.stopped, 'a timeout is a failure, not a cancellation');
    assert.match(r.error, /took longer than .* minutes? and was stopped/i);
    assert.ok(logged.some((m) => /took longer than/.test(m)), 'the build log says so too');
    assert.ok(!eng.events.includes('stop old') && !eng.events.includes('remove old'), 'the running version was never touched');
    assert.ok(!eng.events.some((e) => e.startsWith('create')), 'no container was made for it');
    assert.ok(!existsSync(eng.workDir), 'the clone directory is removed');
  });

  test('the message names the limit in minutes', async () => {
    const r = await run({ buildTimeoutMinutes: 45 * 0 + MINUTE }, fakeEngine({ onRun: hangs('docker') }));
    assert.match(r.error, /longer than \S+ minutes?/);
    const failure = await run({ buildTimeoutMinutes: 5, onStatus: () => {} , signal: undefined, commit: 'bad' }, fakeEngine());
    assert.equal(failure.error, 'Invalid commit id'); // other failures keep their own message
  });

  test('the limit covers the clone as well as the build', async () => {
    const r = await run({ buildTimeoutMinutes: MINUTE }, fakeEngine({ onRun: hangs('git') }));
    assert.equal(r.ok, false);
    assert.match(r.error, /took longer than/i);
  });

  test('with no limit (none given, or null) a slow build is left alone', async () => {
    for (const buildTimeoutMinutes of [undefined, null]) {
      const eng = fakeEngine({ onRun: async (cmd) => { if (cmd === 'docker') await new Promise((r) => setTimeout(r, 120)); } });
      const r = await run({ buildTimeoutMinutes }, eng);
      assert.equal(r.ok, true, String(buildTimeoutMinutes));
    }
  });

  test('a build that finishes inside the limit is not affected, and the limit does not outlive it', async () => {
    const timers = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
    const before = timers();
    const r = await run({ buildTimeoutMinutes: 30 }, fakeEngine({ previous: ['old'] }));
    assert.equal(r.ok, true);
    assert.equal(timers(), before, 'a 30-minute timer left running would keep the worker alive and fire later');
  });

  test('the limit stops counting when the build is done: a LATER failure keeps its own message', async () => {
    // The build is instant; the candidate then needs longer than the limit and turns out unhealthy.
    const eng = fakeEngine({ previous: ['old'], health: { candidate: async () => { await new Promise((r) => setTimeout(r, 150)); throw new Error('not healthy'); } } });
    const r = await run({ buildTimeoutMinutes: MINUTE }, eng);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'not healthy');
    assert.ok(!eng.events.includes('stop old'), 'and the running version is untouched');
  });

  test('a cancel while a limited build is running is still a cancel (stopped), not a timeout failure', async () => {
    const ctl = new AbortController();
    const eng = fakeEngine({ onRun: (cmd, args, opts) => { if (cmd === 'docker') { setTimeout(() => ctl.abort(), 10); return hangs('docker')(cmd, args, opts); } return undefined; } });
    const r = await run({ buildTimeoutMinutes: 30, signal: ctl.signal }, eng);
    assert.equal(r.ok, false);
    assert.equal(r.stopped, true);
  });

  test('a rollback builds nothing, so the limit never applies to it', async () => {
    const OLD = 'shipdok/my-app:0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a';
    const eng = fakeEngine({ previous: ['old'] });
    eng.imageInfo = async () => ({ labels: { 'shipdok.managed': 'true', 'shipdok.app-id': 'app-1' } });
    const r = await run({ buildTimeoutMinutes: MINUTE, reuseImage: OLD, onRun: undefined }, eng);
    assert.equal(r.ok, true);
    assert.ok(!eng.events.includes('run docker build'));
  });
});

describe('persistent storage', () => {
  const VOLUMES = [{ path: '/app/uploads', name: 'shipdok-vol-aaa' }, { path: '/data', name: 'shipdok-vol-bbb' }];
  const made = (eng, role) => eng.created.find((c) => c.name.endsWith(`-${role}`));

  test('the live container mounts the real volumes; the candidate only gets throwaway ones at the same paths', async () => {
    const eng = fakeEngine({ previous: ['old'] });
    const r = await run({ volumes: VOLUMES }, eng);
    assert.equal(r.ok, true);
    assert.deepEqual(made(eng, 'live').volumes, VOLUMES);
    assert.deepEqual(made(eng, 'candidate').volumes, VOLUMES.map(({ path }) => ({ path })), 'no name: the real data is not touched while the old version still runs');
  });

  test('the volumes are created (with ownership labels) after the candidate has passed and before the live container exists', async () => {
    const eng = fakeEngine({ previous: ['old'] });
    await run({ volumes: VOLUMES }, eng);
    const at = (needle) => eng.events.findIndex((e) => e.includes(needle));
    assert.ok(at('health shipdok-my-app-dep-1-candidate') < at('volume shipdok-vol-aaa'));
    assert.ok(at('volume shipdok-vol-bbb') < at('create shipdok-my-app-dep-1-live'));
    assert.ok(at('stop old') < at('create shipdok-my-app-dep-1-live'), 'only one container uses the real volumes at a time');
    assert.deepEqual(eng.volumes.map((v) => v.name), ['shipdok-vol-aaa', 'shipdok-vol-bbb']);
    assert.equal(eng.volumes[0].labels['shipdok.managed'], 'true');
    assert.equal(eng.volumes[0].labels['shipdok.app-id'], 'app-1');
  });

  test('no volumes: no mounts, and no volume is created', async () => {
    const eng = fakeEngine();
    await run({}, eng);
    assert.ok(!eng.events.some((e) => e.startsWith('volume ')));
    assert.deepEqual(made(eng, 'live').volumes ?? [], []);
  });

  test('a build that fails creates no volume at all', async () => {
    const eng = fakeEngine({ onRun: (cmd) => { if (cmd === 'docker') throw new Error('build failed'); } });
    await run({ volumes: VOLUMES }, eng);
    assert.ok(!eng.events.some((e) => e.startsWith('volume ')));
  });

  test('a candidate that is unhealthy touches no real volume, and the running version is untouched', async () => {
    const eng = fakeEngine({ previous: ['old'], health: { candidate: async () => { throw new Error('not healthy'); } } });
    const r = await run({ volumes: VOLUMES }, eng);
    assert.equal(r.ok, false);
    assert.ok(!eng.events.some((e) => e.startsWith('volume ')));
    assert.ok(!eng.events.includes('stop old'));
  });

  test('a swap that fails restores the old version, and the volumes are KEPT (their data is not ours to throw away)', async () => {
    const eng = fakeEngine({ previous: ['old'], failOn: { 'create live': new Error('boom') } });
    const r = await run({ volumes: VOLUMES }, eng);
    assert.equal(r.ok, false);
    assert.ok(eng.events.includes('start old'), 'the old container is started again');
    assert.ok(!eng.events.some((e) => /remove.*vol|rmvol/i.test(e)));
  });

  test('a rollback (an image that already exists) mounts the volumes too', async () => {
    const OLD = 'shipdok/my-app:0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a';
    const eng = fakeEngine({ previous: ['old'] });
    eng.imageInfo = async () => ({ labels: { 'shipdok.managed': 'true', 'shipdok.app-id': 'app-1' } });
    const r = await run({ reuseImage: OLD, volumes: VOLUMES }, eng);
    assert.equal(r.ok, true);
    assert.deepEqual(made(eng, 'live').volumes, VOLUMES);
  });

  test('a stopped app: the new container is created with its mounts but not started', async () => {
    const eng = fakeEngine({ previous: ['old'], stopped: ['old'] });
    const r = await run({ volumes: VOLUMES, beforeSwap: async () => ({ proceed: true, start: false }) }, eng);
    assert.equal(r.ok, true);
    assert.deepEqual(made(eng, 'live').volumes, VOLUMES);
    assert.ok(!eng.events.includes('start shipdok-my-app-dep-1-live'));
  });
});
