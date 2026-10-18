// Real git against a real (local) HTTP git server that demands the same Basic auth header GitHub uses.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitAuthEnv } from '@shipdok/shared';
import * as realEngine from '../src/docker.js';
import { checkoutSource, gitEnvironment } from '../src/git.js';

const TOKEN = 'ghs_TESTTOKEN_abcdef0123456789';
const ROOT = mkdtempSync(join(tmpdir(), 'gittest-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
let server, port, c1, c2;

before(async () => {
  const work = join(ROOT, 'work'); mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  execFileSync('sh', ['-c', 'echo one > f.txt'], { cwd: work }); git(work, 'add', '.'); git(work, 'commit', '-qm', 'one'); c1 = git(work, 'rev-parse', 'HEAD');
  execFileSync('sh', ['-c', 'echo two > f.txt'], { cwd: work }); git(work, 'commit', '-qam', 'two'); c2 = git(work, 'rev-parse', 'HEAD');
  const bare = join(ROOT, 'srv', 'o', 'r.git'); mkdirSync(bare, { recursive: true });
  git(ROOT, 'clone', '-q', '--bare', work, bare);
  git(bare, 'config', 'http.receivepack', 'false');
  git(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true');

  const want = 'Basic ' + Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
  server = http.createServer((req, res) => {
    if (req.headers.authorization !== want) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' }); return res.end('no'); }
    const url = new URL(req.url, 'http://x');
    const cgi = spawn('/usr/lib/git-core/git-http-backend', [], { env: {
      GIT_PROJECT_ROOT: join(ROOT, 'srv'), GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname, REQUEST_METHOD: req.method,
      QUERY_STRING: url.search.slice(1), CONTENT_TYPE: req.headers['content-type'] ?? '', REMOTE_USER: 'x-access-token',
      REMOTE_ADDR: '127.0.0.1', GIT_PROTOCOL: req.headers['git-protocol'] ?? '', PATH: process.env.PATH,
      ...(req.headers['content-length'] ? { CONTENT_LENGTH: req.headers['content-length'] } : {}) } });
    req.pipe(cgi.stdin);
    let buf = Buffer.alloc(0), sent = false;
    cgi.stdout.on('data', (d) => {
      if (sent) return res.write(d);
      buf = Buffer.concat([buf, d]); const i = buf.indexOf('\r\n\r\n'); if (i < 0) return;
      const headers = {}; let status = 200;
      for (const line of buf.subarray(0, i).toString().split('\r\n')) {
        const [k, ...v] = line.split(': '); if (k.toLowerCase() === 'status') status = parseInt(v[0], 10); else headers[k] = v.join(': ');
      }
      res.writeHead(status, headers); res.write(buf.subarray(i + 4)); sent = true;
    });
    cgi.on('close', () => res.end());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => { server?.close(); rmSync(ROOT, { recursive: true, force: true }); });

const filesUnder = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? filesUnder(join(d, e.name)) : [join(d, e.name)]);
const repoUrl = () => `http://127.0.0.1:${port}/o/r.git`;
// The real engine, recording every command line so we can prove the token is never in one.
function recording() {
  const argvs = [];
  return { argvs,
    run: (cmd, args, opts) => { argvs.push([cmd, ...args]); return realEngine.run(cmd, args, { ...opts, stdio: process.env.GITDBG ? 'inherit' : 'ignore' }); },
    capture: (cmd, args, opts) => { argvs.push([cmd, ...args]); return realEngine.capture(cmd, args, opts); } };
}
const fresh = () => mkdtempSync(join(tmpdir(), 'gitwd-')); // like deploy(): an existing empty directory
const authed = () => gitEnvironment(gitAuthEnv(TOKEN));

describe('checkoutSource against a server that requires the GitHub token header', () => {
  test('clones a branch with the token', { timeout: 30000 }, async () => {
    const dir = fresh(); const eng = recording();
    const head = await checkoutSource(eng, { workDir: dir, repo: repoUrl(), ref: 'main', env: authed() });
    assert.equal(head, c2);
    assert.equal(readFileSync(join(dir, 'f.txt'), 'utf8').trim(), 'two');
  });

  test('without the token the same clone fails', { timeout: 30000 }, async () => {
    await assert.rejects(checkoutSource(recording(), { workDir: fresh(), repo: repoUrl(), ref: 'main', env: gitEnvironment() }));
  });

  test('a wrong token fails too', { timeout: 30000 }, async () => {
    await assert.rejects(checkoutSource(recording(), { workDir: fresh(), repo: repoUrl(), ref: 'main', env: gitEnvironment(gitAuthEnv('wrong')) }));
  });

  // An admin's own credential helper (Git Credential Manager, a keychain...) must never be consulted: on a 401 it can
  // open a window or block, and a deploy would hang. This one only records that it was called, so nothing can pop up.
  test('a credential helper in the user\'s git config is never called, even on a 401', { timeout: 30000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), 'githome-'));
    const marker = join(home, 'helper-was-called');
    const helper = join(home, 'helper.sh');
    writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    writeFileSync(join(home, '.gitconfig'), `[credential]\n\thelper = ${helper}\n`);
    const env = gitEnvironment({}, { PATH: process.env.PATH, HOME: home });
    await assert.rejects(checkoutSource(recording(), { workDir: fresh(), repo: repoUrl(), ref: 'main', env }));
    assert.equal(existsSync(marker), false, 'git called the credential helper from the user\'s ~/.gitconfig');
  });

  test('fetches an EXACT older commit, not the branch head', { timeout: 30000 }, async () => {
    const dir = fresh();
    const head = await checkoutSource(recording(), { workDir: dir, repo: repoUrl(), ref: 'main', commit: c1, env: authed() });
    assert.equal(head, c1);
    assert.equal(readFileSync(join(dir, 'f.txt'), 'utf8').trim(), 'one');
  });

  test('the token is never in any command line, in .git/config, or in the checkout', { timeout: 30000 }, async () => {
    const dir = fresh(); const eng = recording();
    await checkoutSource(eng, { workDir: dir, repo: repoUrl(), ref: 'main', commit: c2, env: authed() });
    const b64 = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    assert.ok(eng.argvs.length >= 4);
    for (const secret of [TOKEN, b64]) {
      assert.ok(!JSON.stringify(eng.argvs).includes(secret), 'secret in argv');
      assert.ok(!readFileSync(join(dir, '.git', 'config'), 'utf8').includes(secret), 'secret in .git/config');
      assert.ok(!filesUnder(join(dir, '.git')).some((f) => readFileSync(f).includes(secret)), 'secret somewhere in .git');
    }
  });

  test('a commit that looks like an option is never interpreted as one', { timeout: 30000 }, async () => {
    const eng = recording();
    await assert.rejects(checkoutSource(eng, { workDir: fresh(), repo: repoUrl(), ref: 'main', commit: '--upload-pack=touch /tmp/pwned', env: authed() }));
    assert.ok(!existsSync('/tmp/pwned'));
    const fetchArgs = eng.argvs.find((a) => a.includes('fetch'));
    assert.ok(fetchArgs.includes('--'), 'no -- separator');
    assert.ok(fetchArgs.indexOf('--') < fetchArgs.indexOf('--upload-pack=touch /tmp/pwned'));
  });
});

describe('gitEnvironment', () => {
  test('does not pass the worker secrets to git', () => {
    const env = gitEnvironment({}, { PATH: '/bin', HOME: '/h', APP_SECRETS_KEY: 'k'.repeat(64), POSTGRES_PASSWORD: 'p',
      REDIS_PASSWORD: 'r', GITHUB_APP_PRIVATE_KEY: 'pem', GITHUB_WEBHOOK_SECRET: 's' });
    assert.deepEqual(Object.keys(env).sort(), ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'HOME', 'PATH']);
  });
  test('ignores the system and user git config', () => {
    const env = gitEnvironment({}, { PATH: '/bin' });
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  });
  test('extra (token) variables are included; prompting is always disabled', () => {
    const env = gitEnvironment(gitAuthEnv(TOKEN), { PATH: '/bin' });
    assert.equal(env.GIT_CONFIG_KEY_0, 'http.extraHeader');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  });
});
