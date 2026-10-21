// Building with Railpack: the plan, then docker build of the plan. Against a fake engine; the real programs are checked separately.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { buildWithRailpack, labelDockerfile, parseRailpackVersion, prepareArguments, railpackVariables, FRONTEND_IMAGE, PLACEHOLDER } from '../src/railpack.js';
import { deploy } from '../src/deploy.js';
import { fakeEngine, abortError } from './fake-engine.js';

const BASE_ENV = { PATH: '/usr/bin', HOME: '/home/node', APP_SECRETS_KEY: 'worker-master-key-should-never-reach-a-child', DATABASE_URL: 'postgres://secret' };
const call = (eng, o = {}) => buildWithRailpack(eng, { buildDir: '/work/src', image: 'shipdok/my-app:dep-1', labels: { 'shipdok.managed': 'true', 'shipdok.app-id': 'app-1' }, log: () => {}, baseEnv: BASE_ENV, ...o });
const prepareOf = (eng) => eng.runs.find((r) => r.cmd === 'railpack');
const buildOf = (eng) => eng.runs.find((r) => r.cmd === 'docker' && r.args[0] === 'build');
const labelStepOf = (eng) => eng.runs.filter((r) => r.cmd === 'docker' && r.args[0] === 'build')[1];
// The label step's Dockerfile only exists while the build runs: read it then.
const recordingLabels = (extra = {}) => { const seen = { text: null }; return { seen, eng: fakeEngine({ ...extra, onRun: (cmd, args) => { const f = args.indexOf('-f'); if (cmd === 'docker' && f >= 0 && args[f + 1].endsWith('labels.Dockerfile')) seen.text = readFileSync(args[f + 1], 'utf8'); } }) }; };

describe('the version', () => {
  test('is read from what `railpack --version` prints', () => {
    assert.equal(parseRailpackVersion('railpack version 0.43.0\n'), '0.43.0');
    assert.equal(parseRailpackVersion('railpack version 12.30.456'), '12.30.456');
  });
  test('anything else is an error, because a frontend of the wrong version must never be guessed', () => {
    for (const bad of ['', 'railpack', null, undefined, 'version one']) assert.throws(() => parseRailpackVersion(bad), /which version of Railpack/);
  });
});

describe('the label file', () => {
  test('values are quoted so that nothing in them can end the line or add an instruction', () => {
    assert.equal(labelDockerfile('i:t', { a: 'x" y\\z' }), 'FROM i:t\nLABEL "a"="x\\" y\\\\z"\n');
  });
  test('a line break or other control character is refused', () => {
    for (const bad of ['a\nRUN evil', 'a\r', 'a\u0000', 'a\u007f']) assert.throws(() => labelDockerfile('i:t', { k: bad }), /control character/);
    assert.throws(() => labelDockerfile('i:t', { 'k\n': 'v' }), /control character/);
  });
});

describe('the variables', () => {
  test('RAILPACK_ ones configure Railpack itself and are left out; the rest go on', () => {
    assert.deepEqual(railpackVariables(['A=1', 'RAILPACK_SPA_OUTPUT_DIR=dist', 'B=x=y']), { used: ['A=1', 'B=x=y'], skipped: ['RAILPACK_SPA_OUTPUT_DIR'] });
    assert.deepEqual(railpackVariables([]), { used: [], skipped: [] });
  });
});

describe('the plan', () => {
  test('names of variables get a placeholder, the commands are passed as they are', () => {
    const args = prepareArguments({ dir: '/d', planFile: '/p.json', names: ['API_KEY', 'TOKEN'], installCommand: 'npm ci', buildCommand: 'npm run b', startCommand: 'node s.js' });
    assert.deepEqual(args, [
      'prepare', '/d', '--plan-out', '/p.json', '--error-missing-start',
      '--env', `API_KEY=${PLACEHOLDER}`, '--env', `TOKEN=${PLACEHOLDER}`,
      '--env', 'RAILPACK_INSTALL_CMD=npm ci', '--build-cmd', 'npm run b', '--start-cmd', 'node s.js',
    ]);
  });
  test('a command that is not given is not passed at all (Railpack decides)', () => {
    const args = prepareArguments({ dir: '/d', planFile: '/p.json' });
    assert.deepEqual(args, ['prepare', '/d', '--plan-out', '/p.json', '--error-missing-start']);
  });
});

describe('planning and building', () => {
  test('first the plan, then a docker build of that plan with the frontend of the same version', async () => {
    const eng = fakeEngine({ railpackVersion: '1.2.3' });
    await call(eng);
    assert.deepEqual(eng.runs.map((r) => r.cmd), ['railpack', 'docker', 'docker'], 'the plan, the build, then the labels');
    const p = prepareOf(eng);
    const b = buildOf(eng);
    const planFile = p.args[p.args.indexOf('--plan-out') + 1];
    assert.equal(b.args[b.args.indexOf('-f') + 1], planFile, 'docker builds the plan that was just written');
    assert.equal(b.args[b.args.indexOf('--build-arg') + 1], `BUILDKIT_SYNTAX=${FRONTEND_IMAGE}:v1.2.3`);
    assert.equal(b.args.at(-1), '/work/src', 'the context is the folder of the app');
    assert.deepEqual(labelStepOf(eng).args.slice(labelStepOf(eng).args.indexOf('-t'), labelStepOf(eng).args.indexOf('-t') + 2), ['-t', 'shipdok/my-app:dep-1'], 'the app\'s image ends up under its own tag');
  });

  test('the image gets its ownership labels and says it was made with Railpack, in a second step that keeps the tag', async () => {
    const { seen, eng } = recordingLabels();
    await call(eng);
    assert.ok(!buildOf(eng).args.includes('--label'), 'the Railpack frontend ignores --label, so none is passed to the build itself');
    const step = labelStepOf(eng);
    assert.ok(step, 'a second docker build adds the labels');
    assert.deepEqual(step.args.slice(step.args.indexOf('-t'), step.args.indexOf('-t') + 2), ['-t', 'shipdok/my-app:dep-1']);
    assert.equal(seen.text, 'FROM shipdok/my-app:dep-1-unlabelled\nLABEL "shipdok.managed"="true" "shipdok.app-id"="app-1" "shipdok.build-method"="railpack"\n');
  });

  test('the build is tagged with a temporary name, which is removed afterwards whatever happens, so no unlabelled image is left behind', async () => {
    const ok = fakeEngine();
    await call(ok);
    assert.deepEqual(buildOf(ok).args.slice(buildOf(ok).args.indexOf('-t'), buildOf(ok).args.indexOf('-t') + 2), ['-t', 'shipdok/my-app:dep-1-unlabelled']);
    assert.deepEqual(ok.events.filter((e) => e.startsWith('rmi')), ['rmi shipdok/my-app:dep-1-unlabelled']);
    const failing = fakeEngine({ onRun: (cmd, args) => { if (cmd === 'docker' && args.some((a) => String(a).endsWith('labels.Dockerfile'))) throw new Error('docker exited 1'); } });
    await assert.rejects(call(failing), /docker exited 1/);
    assert.deepEqual(failing.events.filter((e) => e.startsWith('rmi')), ['rmi shipdok/my-app:dep-1-unlabelled']);
  });

  test('the label step does not run when the build failed', async () => {
    const eng = fakeEngine({ onRun: (cmd, args) => { if (cmd === 'docker' && args.includes('-f')) throw new Error('docker exited 1'); } });
    await assert.rejects(call(eng), /docker exited 1/);
    assert.equal(eng.runs.filter((r) => r.cmd === 'docker').length, 1);
  });

  test('the plan is kept outside the folder that is built, and is removed afterwards, also after a failure', async () => {
    const eng = fakeEngine();
    await call(eng);
    const plan = prepareOf(eng).args[prepareOf(eng).args.indexOf('--plan-out') + 1];
    assert.ok(!plan.startsWith('/work/src'));
    assert.ok(!existsSync(plan.replace(/\/[^/]+$/, '')), 'its folder is gone');
    const failing = fakeEngine({ onRun: (cmd) => { if (cmd === 'docker') throw new Error('docker exited 1'); } });
    await assert.rejects(call(failing), /docker exited 1/);
    const plan2 = prepareOf(failing).args[prepareOf(failing).args.indexOf('--plan-out') + 1];
    assert.ok(!existsSync(plan2.replace(/\/[^/]+$/, '')));
  });

  test('a failed plan stops before docker is asked to build anything, and the error points to the log where Railpack explains', async () => {
    const eng = fakeEngine({ onRun: (cmd) => { if (cmd === 'railpack') throw new Error('railpack exited 1'); } });
    await assert.rejects(call(eng), /Railpack could not plan the build \(its reason is in the build log\)/);
    assert.ok(!buildOf(eng));
  });

  test('a cancel while planning stays a cancel (it is not turned into a planning failure)', async () => {
    const stop = new AbortController();
    const eng = fakeEngine({ onRun: (cmd) => { if (cmd === 'railpack') { stop.abort(); throw abortError(); } } });
    await assert.rejects(call(eng, { signal: stop.signal }), (err) => eng.isAbort(err));
    const timedOut = fakeEngine({ onRun: (cmd) => { if (cmd === 'railpack') throw new Error('railpack exited 1'); } });
    const limit = new AbortController(); limit.abort();
    await assert.rejects(call(timedOut, { signal: limit.signal }), /railpack exited 1/, 'whatever stopped it, the caller decides what to call it');
  });

  test('--no-cache is passed on when asked for, and only then', async () => {
    const a = fakeEngine(); await call(a, { noCache: true });
    const b = fakeEngine(); await call(b);
    assert.ok(buildOf(a).args.includes('--no-cache'));
    assert.ok(!buildOf(b).args.includes('--no-cache'));
  });

  test('every build variable is a secret, whichever way it was set, and no value is on any command line', async () => {
    const eng = fakeEngine();
    const lines = [];
    await call(eng, { buildEnv: ['VITE_API=https://api.example.com'], buildSecretEnv: ['NPM_TOKEN=s3cr3t-token'], log: (m) => lines.push(m) });
    const b = buildOf(eng);
    assert.ok(!b.args.includes('--build-arg') || b.args[b.args.indexOf('--build-arg') + 1].startsWith('BUILDKIT_SYNTAX='), 'no variable is a build argument');
    assert.ok(b.args.includes('id=VITE_API,env=VITE_API') && b.args.includes('id=NPM_TOKEN,env=NPM_TOKEN'));
    assert.equal(b.opts.env.NPM_TOKEN, 's3cr3t-token');
    assert.equal(b.opts.env.VITE_API, 'https://api.example.com');
    for (const r of eng.runs) {
      const text = r.args.join(' ');
      assert.ok(!text.includes('s3cr3t-token') && !text.includes('api.example.com'), `${r.cmd}: no value on the command line`);
    }
    const p = prepareOf(eng).args.join(' ');
    assert.ok(p.includes(`NPM_TOKEN=${PLACEHOLDER}`) && p.includes(`VITE_API=${PLACEHOLDER}`), 'the plan is told only that they exist');
    assert.ok(lines.some((l) => /build secrets/.test(l) && l.includes('NPM_TOKEN') && !l.includes('s3cr3t-token')));
  });

  test('the install command is handed to the build as a secret too (Railpack lists it as one), and is not listed as a variable', async () => {
    const eng = fakeEngine();
    const lines = [];
    await call(eng, { installCommand: 'npm ci --ignore-scripts', log: (m) => lines.push(m) });
    const b = buildOf(eng);
    assert.ok(b.args.includes('id=RAILPACK_INSTALL_CMD,env=RAILPACK_INSTALL_CMD'));
    assert.equal(b.opts.env.RAILPACK_INSTALL_CMD, 'npm ci --ignore-scripts');
    assert.ok(prepareOf(eng).args.includes('RAILPACK_INSTALL_CMD=npm ci --ignore-scripts'));
    assert.ok(!lines.some((l) => /build secrets/.test(l)), 'it is a setting, not one of the app\'s variables');
  });

  test('without an install command nothing about it is passed', async () => {
    const eng = fakeEngine();
    await call(eng, { buildCommand: 'npm run build' });
    assert.ok(!buildOf(eng).args.join(' ').includes('RAILPACK_INSTALL_CMD'));
    assert.ok(!prepareOf(eng).args.join(' ').includes('RAILPACK_INSTALL_CMD'));
  });

  test('a variable named RAILPACK_... is not passed on, and the log says why; an install command wins over it', async () => {
    const eng = fakeEngine();
    const lines = [];
    await call(eng, { buildEnv: ['RAILPACK_INSTALL_CMD=evil', 'RAILPACK_SPA_OUTPUT_DIR=dist'], installCommand: 'npm ci', log: (m) => lines.push(m) });
    assert.equal(buildOf(eng).opts.env.RAILPACK_INSTALL_CMD, 'npm ci');
    assert.ok(!prepareOf(eng).args.join(' ').includes('SPA_OUTPUT_DIR'));
    assert.ok(lines.some((l) => /Not passed to the build/.test(l) && l.includes('RAILPACK_SPA_OUTPUT_DIR') && !l.includes('dist')));
  });

  test('neither child program gets the worker\'s own secrets', async () => {
    const eng = fakeEngine();
    await call(eng, { buildSecretEnv: ['A=1'] });
    for (const r of eng.runs) {
      assert.ok(r.opts.env.PATH, `${r.cmd} can find its programs`);
      assert.ok(!('APP_SECRETS_KEY' in r.opts.env) && !('DATABASE_URL' in r.opts.env), `${r.cmd}: nothing of the worker's`);
    }
  });

  test('a variable that may not be used at build time fails before anything runs, naming it', async () => {
    const eng = fakeEngine();
    await assert.rejects(call(eng, { buildSecretEnv: ['DOCKER_HOST=tcp://evil'] }), /DOCKER_HOST/);
    assert.ok(!prepareOf(eng) && !buildOf(eng));
  });

  test('the cancel signal and the log sink reach both commands', async () => {
    const eng = fakeEngine();
    const signal = new AbortController().signal;
    const sink = { write() {} };
    await call(eng, { signal, sink });
    for (const r of eng.runs) assert.ok(r.opts.signal === signal && r.opts.sink === sink, r.cmd);
  });

  test('a worker without Railpack says so, plainly', async () => {
    const eng = fakeEngine();
    eng.capture = async () => { throw Object.assign(new Error('spawn railpack ENOENT'), { code: 'ENOENT' }); };
    await assert.rejects(call(eng), /Railpack is not installed in the worker/);
  });
});

describe('inside a deployment', () => {
  const base = { repo: 'https://github.com/o/r.git', appId: 'app-1', slug: 'my-app', deploymentId: 'dep-1', containerPort: 3000, hostPort: 8080, log: () => {} };
  const go = (opts, eng) => deploy({ ...base, ...opts }, eng);

  test('the Dockerfile method never runs Railpack, whatever commands the app has stored', async () => {
    const eng = fakeEngine({ previous: [] });
    await go({ buildMethod: 'dockerfile', installCommand: 'npm ci', startCommand: 'node x' }, eng);
    assert.ok(!prepareOf(eng));
    assert.ok(!buildOf(eng).args.join(' ').includes('railpack'));
    assert.ok(!buildOf(eng).args.join(' ').includes('build-method'));
  });

  test('no method given counts as the Dockerfile (a job queued before this existed)', async () => {
    const eng = fakeEngine({ previous: [] });
    await go({}, eng);
    assert.ok(!prepareOf(eng));
  });

  test('the Railpack method plans and builds, with the commands of the app', async () => {
    const eng = fakeEngine({ previous: [] });
    const r = await go({ buildMethod: 'railpack', buildCommand: 'npm run build', startCommand: 'node s.js' }, eng);
    assert.equal(r.ok, true);
    const p = prepareOf(eng).args;
    assert.equal(p[p.indexOf('--build-cmd') + 1], 'npm run build');
    assert.equal(p[p.indexOf('--start-cmd') + 1], 'node s.js');
    assert.ok(buildOf(eng).args.some((a) => a.startsWith('BUILDKIT_SYNTAX=')));
  });

  test('the app is told which port to listen on (PORT), the candidate and the live container alike', async () => {
    const eng = fakeEngine({ previous: [] });
    await go({ buildMethod: 'railpack', env: ['A=1'] }, eng);
    assert.ok(eng.created.length >= 2);
    for (const c of eng.created) assert.deepEqual(c.env, ['A=1', 'PORT=3000'], c.name);
  });

  test('a PORT the administrator set themselves is left alone', async () => {
    const eng = fakeEngine({ previous: [] });
    await go({ buildMethod: 'railpack', env: ['PORT=9999'] }, eng);
    for (const c of eng.created) assert.deepEqual(c.env, ['PORT=9999'], c.name);
  });

  test('a Dockerfile app is NOT given a PORT', async () => {
    const eng = fakeEngine({ previous: [] });
    await go({ env: ['A=1'] }, eng);
    for (const c of eng.created) assert.deepEqual(c.env, ['A=1'], c.name);
  });

  test('a rollback goes by how the OLD image was made, not by the app\'s setting now', async () => {
    const reuseImage = 'shipdok/my-app:11111111-1111-4111-8111-111111111111';
    const was = { [reuseImage]: { labels: { 'shipdok.managed': 'true', 'shipdok.app-id': 'app-1', 'shipdok.build-method': 'railpack' } } };
    const a = fakeEngine({ previous: [], appId: 'app-1', images: was });
    await go({ reuseImage, buildMethod: 'dockerfile', env: ['A=1'] }, a); // the app has since gone back to its Dockerfile
    for (const c of a.created) assert.deepEqual(c.env, ['A=1', 'PORT=3000'], c.name);
    const old = { [reuseImage]: { labels: { 'shipdok.managed': 'true', 'shipdok.app-id': 'app-1' } } }; // an image from before the label existed
    const b = fakeEngine({ previous: [], appId: 'app-1', images: old });
    await go({ reuseImage, buildMethod: 'railpack', env: ['A=1'] }, b);
    for (const c of b.created) assert.deepEqual(c.env, ['A=1'], c.name);
  });

  test('a failing plan fails the deployment with Railpack\'s reason in the log, and the running version is untouched', async () => {
    const eng = fakeEngine({ previous: ['old'], onRun: (cmd) => { if (cmd === 'railpack') throw new Error('railpack exited 1'); } });
    const r = await go({ buildMethod: 'railpack' }, eng);
    assert.equal(r.ok, false);
    assert.match(r.error, /Railpack could not plan the build/);
    assert.ok(!eng.events.some((e) => e.startsWith('stop old') || e.startsWith('remove old')));
  });
});
