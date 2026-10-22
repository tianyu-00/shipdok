// Building a static site: the Dockerfile Shipdok writes, and the docker build of it. Against a fake engine; the real build and both web servers are checked
// separately with real Docker.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { buildStatic, shellQuote, staticDockerfile, serverConfig, caddyfile, cleanOutputDir, SERVER_IMAGES, DEFAULT_NODE_VERSION } from '../src/static.js';
import { deploy } from '../src/deploy.js';
import { fakeEngine } from './fake-engine.js';

const BASE_ENV = { PATH: '/usr/bin', HOME: '/home/node', APP_SECRETS_KEY: 'worker-master-key-should-never-reach-a-child', DATABASE_URL: 'postgres://secret' };
const call = (eng, o = {}) => buildStatic(eng, { buildDir: '/work/src', image: 'shipdok/my-site:dep-1', labels: { 'shipdok.managed': 'true', 'shipdok.app-id': 'app-1' }, containerPort: 8080, log: () => {}, baseEnv: BASE_ENV, ...o });
const buildOf = (eng) => eng.runs.find((r) => r.cmd === 'docker' && r.args[0] === 'build');
// The Dockerfile only exists while the build runs: read it then.
const recording = (extra = {}) => {
  const seen = { dockerfile: null, ignore: null, file: null };
  return { seen, eng: fakeEngine({ ...extra, onRun: (cmd, args) => {
    const f = args.indexOf('-f');
    if (cmd === 'docker' && f >= 0) { seen.file = args[f + 1]; seen.dockerfile = readFileSync(args[f + 1], 'utf8'); seen.ignore = existsSync(`${args[f + 1]}.dockerignore`) ? readFileSync(`${args[f + 1]}.dockerignore`, 'utf8') : null; }
  } }) };
};

describe('the output folder', () => {
  test('is cleaned to a plain relative path; empty or "." mean the folder itself', () => {
    for (const [given, want] of [[undefined, '.'], [null, '.'], ['', '.'], ['.', '.'], ['./', '.'], ['dist', 'dist'], ['./dist/', 'dist'], ['build/web', 'build/web'], ['a//b', 'a/b']]) assert.equal(cleanOutputDir(given), want, String(given));
  });
  test('one that leaves the app\'s folder, or has characters a Dockerfile could misread, is refused', () => {
    for (const bad of ['/etc', '..', '../x', 'a/../b', 'a b', 'a;rm', 'a$(x)', "a'b", 'a\nb', 'a"b', 'a`b']) assert.throws(() => cleanOutputDir(bad), /relative path/, bad);
  });
});

describe('the web server configurations', () => {
  test('nginx listens on the port and sends missing addresses to index.html, or answers 404', () => {
    const spa = serverConfig({ port: 8080, spa: true }).join('\n');
    assert.match(spa, /listen 8080;/);
    assert.match(spa, /try_files \$uri \$uri\/ \/index\.html;/);
    assert.match(serverConfig({ port: 8080, spa: false }).join('\n'), /try_files \$uri \$uri\/ =404;/);
  });
  test('both servers refuse dot files and folders (.git, .env), but not .well-known', () => {
    assert.match(serverConfig({ port: 8080, spa: true }).join('\n'), /location ~ \/\\\.\(\?!well-known\/\) \{ return 404; \}/);
    const c = caddyfile({ port: 8080, spa: true }).join('\n');
    assert.match(c, /path_regexp \/\\\./);
    assert.match(c, /not path \/\.well-known\/\*/);
    assert.match(c, /respond @dotfiles 404/);
  });
  test('Caddy runs the dot file rule BEFORE the fallback (its own order would rewrite the address first)', () => {
    const c = caddyfile({ port: 8080, spa: true }).join('\n');
    assert.ok(c.includes('route {'));
    assert.ok(c.indexOf('respond @dotfiles') < c.indexOf('try_files'));
    assert.ok(c.indexOf('try_files') < c.indexOf('file_server'));
  });
  test('Caddy has no fallback when it is off, and no admin port or automatic HTTPS either way', () => {
    assert.ok(!caddyfile({ port: 8080, spa: false }).join('\n').includes('try_files'));
    for (const spa of [true, false]) { const c = caddyfile({ port: 8080, spa }).join('\n'); assert.match(c, /admin off/); assert.match(c, /auto_https off/); }
  });
  test('a port below 1024, or not a whole number, is refused (neither server runs as root)', () => {
    for (const port of [80, 1023, 0, 70000, 8080.5, '8080', undefined, NaN]) {
      assert.throws(() => serverConfig({ port, spa: true }), /from 1024 up/, String(port));
      assert.throws(() => caddyfile({ port, spa: true }), /from 1024 up/, String(port));
    }
  });
});

describe('the Dockerfile', () => {
  const lines = (o) => staticDockerfile({ port: 8080, ...o }).split('\n');

  test('with a build: Node of the chosen version, the commands, a check of the folder, then the web server with the folder copied in', () => {
    const text = staticDockerfile({ installCommand: 'npm ci', buildCommand: 'npm run build', outputDir: 'dist', nodeVersion: '20.11', port: 8080 });
    assert.match(text, /^FROM node:20\.11-bookworm-slim AS build$/m);
    assert.match(text, /^RUN npm ci$/m);
    assert.match(text, /^RUN npm run build$/m);
    assert.match(text, /^RUN test -d 'dist' \|\| /m);
    assert.ok(text.indexOf('npm ci') < text.indexOf('npm run build') && text.indexOf('npm run build') < text.indexOf('FROM nginx'));
    assert.match(text, new RegExp(`^FROM ${SERVER_IMAGES.nginx.replace(/[.]/g, '\\.')}$`, 'm'));
    assert.match(text, /^COPY --from=build \/src\/dist\/ \/usr\/share\/nginx\/html\/$/m);
  });
  test('the default Node version is used when none is given', () => {
    assert.match(staticDockerfile({ buildCommand: 'x', port: 8080 }), new RegExp(`FROM node:${DEFAULT_NODE_VERSION}-bookworm-slim`));
  });
  test('only a build command, or only an install command, still makes the build stage', () => {
    assert.match(staticDockerfile({ buildCommand: 'make', port: 8080 }), /AS build/);
    assert.match(staticDockerfile({ installCommand: 'make', port: 8080 }), /AS build/);
  });
  test('with neither there is NO build stage and the folder is copied from the repository as it is', () => {
    const text = staticDockerfile({ outputDir: 'public', port: 8080 });
    assert.ok(!text.includes('node:') && !text.includes('AS build'));
    assert.match(text, /^COPY public\/ \/usr\/share\/nginx\/html\/$/m);
    assert.match(staticDockerfile({ port: 8080 }), /^COPY \.\/ \/usr\/share\/nginx\/html\/$/m);
  });
  test('Corepack is switched on, so yarn and pnpm commands work', () => assert.match(staticDockerfile({ buildCommand: 'pnpm build', port: 8080 }), /^RUN corepack enable$/m));
  test('each build variable is mounted as a secret for the install and the build step, and only there', () => {
    const l = lines({ installCommand: 'npm ci', buildCommand: 'npm run build', secretNames: ['A', 'B'] });
    const runs = l.filter((x) => x.includes('--mount=type=secret'));
    assert.equal(runs.length, 2);
    for (const r of runs) assert.ok(r.startsWith('RUN --mount=type=secret,id=A,env=A --mount=type=secret,id=B,env=B '), r);
    assert.ok(!l.find((x) => x.startsWith('RUN test -d'))?.includes('secret'));
  });
  test('the web server is nginx by default and does not run as root', () => {
    const l = lines({});
    assert.ok(l.includes(`FROM ${SERVER_IMAGES.nginx}`));
    assert.equal(l.filter((x) => x.startsWith('USER ')).at(-1), 'USER nginx');
    assert.ok(l.includes('EXPOSE 8080'));
  });
  test('Caddy: its image, its configuration, the folder in /srv, a normal user, and writable folders for its state', () => {
    const l = lines({ server: 'caddy', outputDir: 'dist', buildCommand: 'x' });
    assert.ok(l.includes(`FROM ${SERVER_IMAGES.caddy}`));
    assert.ok(l.some((x) => x.includes('/etc/caddy/Caddyfile') && x.includes(':8080 {')));
    assert.ok(l.includes('COPY --from=build /src/dist/ /srv/'));
    assert.equal(l.filter((x) => x.startsWith('USER ')).at(-1), 'USER 1000');
    assert.ok(l.some((x) => x.startsWith('ENV XDG_DATA_HOME=')));
  });
  test('an unknown server is refused', () => assert.throws(() => staticDockerfile({ server: 'apache', port: 8080 }), /nginx or caddy/));
  test('quoting for the shell closes and reopens the quote around a single quote, so nothing can end the string', () => {
    assert.equal(shellQuote('a b'), "'a b'");
    assert.equal(shellQuote("it's"), "'it'\\''s'");
    assert.equal(shellQuote("x'; rm -rf / #"), "'x'\\''; rm -rf / #'");
  });
  test('a node version, a command or a port that could change the Dockerfile is refused', () => {
    for (const bad of ['22; rm', 'latest', '22.0.0.1', '', ' 22', '$(x)', '22\nRUN evil']) if (bad !== '') assert.throws(() => staticDockerfile({ buildCommand: 'x', nodeVersion: bad, port: 8080 }), /Node version/, bad);
    for (const bad of ['a\nRUN evil', 'a\r', 'a\u0000']) {
      assert.throws(() => staticDockerfile({ installCommand: bad, port: 8080 }), /single line/);
      assert.throws(() => staticDockerfile({ buildCommand: bad, port: 8080 }), /single line/);
    }
    assert.throws(() => staticDockerfile({ port: 80 }), /from 1024 up/);
    assert.throws(() => staticDockerfile({ outputDir: '../x', port: 8080 }), /relative path/);
  });
});

describe('the build', () => {
  test('is one docker build of a Dockerfile Shipdok wrote outside the clone, with the labels given to docker directly and the method added', async () => {
    const { eng, seen } = recording();
    await call(eng, { installCommand: 'npm ci', buildCommand: 'npm run build', outputDir: 'dist' });
    const builds = eng.runs.filter((r) => r.cmd === 'docker');
    assert.equal(builds.length, 1, 'no second build: the labels go on the one build');
    const args = builds[0].args;
    assert.deepEqual(args.slice(0, 4), ['build', '--progress=plain', '-t', 'shipdok/my-site:dep-1']);
    assert.ok(args.includes('shipdok.managed=true') && args.includes('shipdok.app-id=app-1') && args.includes('shipdok.build-method=static'));
    assert.equal(args.at(-1), '/work/src', 'the context is the app\'s folder');
    assert.ok(seen.file && !seen.file.startsWith('/work/src'), 'the Dockerfile is not in the clone, so the repository cannot replace it');
    assert.match(seen.dockerfile, /RUN npm ci/);
  });
  test('.git is kept out of the build with a .dockerignore next to the Dockerfile', async () => {
    const { eng, seen } = recording();
    await call(eng, {});
    assert.equal(seen.ignore, '.git\n');
  });
  test('the temporary folder is removed afterwards, also when the build fails', async () => {
    const a = recording();
    await call(a.eng, {});
    assert.equal(existsSync(a.seen.file), false);
    const b = recording({ });
    const failing = fakeEngine({ onRun: (cmd, args) => { b.seen.file = args[args.indexOf('-f') + 1]; throw new Error('docker exited 1'); } });
    await assert.rejects(call(failing, {}), /docker exited 1/);
    assert.equal(existsSync(b.seen.file), false);
  });
  test('--no-cache only when asked', async () => {
    const a = fakeEngine({}); await call(a, { noCache: true }); assert.ok(buildOf(a).args.includes('--no-cache'));
    const b = fakeEngine({}); await call(b, {}); assert.ok(!buildOf(b).args.includes('--no-cache'));
  });
  test('build variables are BuildKit secrets whose values stay in docker\'s environment, never on the command line', async () => {
    const eng = fakeEngine({});
    await call(eng, { buildCommand: 'make', buildEnv: ['API_URL=https://x.example'], buildSecretEnv: ['TOKEN=hunter2'] });
    const b = buildOf(eng);
    assert.ok(b.args.includes('--secret') && b.args.includes('id=API_URL,env=API_URL') && b.args.includes('id=TOKEN,env=TOKEN'));
    assert.ok(!b.args.includes('--build-arg'), 'with a static site every build variable is a secret');
    assert.ok(!b.args.join(' ').includes('hunter2') && !b.args.join(' ').includes('x.example'));
    assert.equal(b.opts.env.TOKEN, 'hunter2');
    assert.equal(b.opts.env.APP_SECRETS_KEY, undefined, 'the worker\'s own secrets never reach docker');
    assert.equal(b.opts.env.DATABASE_URL, undefined);
  });
  test('a variable name that cannot be used at build time fails before anything is built, naming it but never the value', async () => {
    const eng = fakeEngine({});
    await assert.rejects(call(eng, { buildCommand: 'make', buildSecretEnv: ['PATH=/evil'] }), (e) => /"PATH"/.test(e.message) && !e.message.includes('/evil'));
    assert.equal(eng.runs.length, 0);
  });
  test('with no build command the variables are not mounted (there is no step to use them) and the log says so', async () => {
    const logs = [];
    const { eng, seen } = recording();
    await call(eng, { buildSecretEnv: ['TOKEN=x'], log: (m) => logs.push(m) });
    assert.ok(!seen.dockerfile.includes('--mount'));
    assert.ok(logs.some((m) => /not used/.test(m)));
  });
  test('the log says which server, which folder and which Node', async () => {
    const logs = [];
    await call(fakeEngine({}), { buildCommand: 'x', outputDir: 'dist', nodeVersion: '20', server: 'caddy', log: (m) => logs.push(m) });
    assert.ok(logs.some((m) => /Node 20, serving dist with caddy on port 8080/.test(m)), logs.join('|'));
    const plain = [];
    await call(fakeEngine({}), { log: (m) => plain.push(m) });
    assert.ok(plain.some((m) => /serving \. with nginx on port 8080 \(no build command\)/.test(m)), plain.join('|'));
  });
  test('a cancel passes through as it is', async () => {
    const ctl = new AbortController();
    const eng = fakeEngine({ onRun: () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); } });
    await assert.rejects(call(eng, { signal: ctl.signal }), (e) => e.name === 'AbortError');
  });
});

describe('inside a deployment', () => {
  const base = { repo: 'https://github.com/o/r.git', appId: 'app-1', slug: 'my-site', deploymentId: 'dep-1', containerPort: 8080, hostPort: 8081, log: () => {} };
  const go = (opts, eng) => deploy({ ...base, ...opts }, eng);

  test('the static method builds with its own Dockerfile, passing the settings through, and never runs Railpack', async () => {
    const eng = fakeEngine({ previous: [] });
    await go({ buildMethod: 'static', installCommand: 'npm ci', buildCommand: 'npm run build', outputDir: 'dist', nodeVersion: '20', spaFallback: false, staticServer: 'caddy' }, eng);
    assert.ok(!eng.runs.some((r) => r.cmd === 'railpack'));
    const b = buildOf(eng);
    assert.ok(b.args.includes('shipdok.build-method=static'));
    assert.ok(b.args.some((a) => a.endsWith('static.Dockerfile')));
  });
  test('the settings reach the Dockerfile', async () => {
    const { eng, seen } = recording({ previous: [] });
    await go({ buildMethod: 'static', buildCommand: 'npm run build', outputDir: 'dist', nodeVersion: '20', spaFallback: false, staticServer: 'caddy' }, eng);
    assert.match(seen.dockerfile, /FROM node:20-bookworm-slim/);
    assert.match(seen.dockerfile, /FROM caddy/);
    assert.ok(!seen.dockerfile.includes('try_files'), 'the fallback was off');
    assert.match(seen.dockerfile, /:8080 \{/);
  });
  test('the default server is nginx and the fallback is on when the job does not say (a job queued by an older API)', async () => {
    const { eng, seen } = recording({ previous: [] });
    await go({ buildMethod: 'static' }, eng);
    assert.match(seen.dockerfile, /FROM nginxinc\/nginx-unprivileged/);
    assert.match(seen.dockerfile, /index\.html/);
  });
  test('a static site is NOT given PORT (it does not read it), and an app\'s own variables are kept', async () => {
    const eng = fakeEngine({ previous: [] });
    await go({ buildMethod: 'static', env: ['A=1'] }, eng);
    for (const c of eng.created) assert.deepEqual(c.env, ['A=1'], c.name);
  });
  test('a rollback to a static image runs it without PORT whatever the app says now, and a static app\'s old Railpack image still gets PORT', async () => {
    const reuseImage = 'shipdok/my-site:11111111-1111-4111-8111-111111111111';
    const labels = (method) => ({ 'shipdok.managed': 'true', 'shipdok.app-id': 'app-1', 'shipdok.build-method': method });
    const a = fakeEngine({ previous: [], appId: 'app-1', images: { [reuseImage]: { labels: labels('static') } } });
    await go({ reuseImage, buildMethod: 'railpack', env: ['A=1'] }, a);
    for (const c of a.created) assert.deepEqual(c.env, ['A=1'], c.name);
    const b = fakeEngine({ previous: [], appId: 'app-1', images: { [reuseImage]: { labels: labels('railpack') } } });
    await go({ reuseImage, buildMethod: 'static', env: ['A=1'] }, b);
    for (const c of b.created) assert.deepEqual(c.env, ['A=1', 'PORT=8080'], c.name);
  });
  test('the other methods never use the static builder, whatever static settings the app has stored', async () => {
    for (const buildMethod of ['dockerfile', undefined]) {
      const eng = fakeEngine({ previous: [] });
      await go({ buildMethod, outputDir: 'dist', staticServer: 'caddy', nodeVersion: '20' }, eng);
      assert.ok(!buildOf(eng).args.some((a) => a.endsWith('static.Dockerfile')));
      assert.ok(!buildOf(eng).args.includes('shipdok.build-method=static'));
    }
  });
  test('a failed deployment of a static site cleans up its image like any other', async () => {
    const eng = fakeEngine({ previous: ['old'], health: { candidate: async () => { throw new Error('not healthy'); } } });
    await go({ buildMethod: 'static' }, eng);
    assert.ok(eng.events.some((e) => e.startsWith('rmi')));
  });
});
