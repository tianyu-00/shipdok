// The log file format, masking, and safe reading/removal. Used by the worker (writes) and the API (reads).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_LINE_BYTES, logRoot, logFilePath, formatLine, createRedactor, secretsFromGitEnv,
  readChunk, readTail, removeDeploymentLogs, gitAuthEnv,
} from '../src/index.js';

const APP = '11111111-1111-4111-8111-111111111111';
const DEP = '22222222-2222-4222-8222-222222222222';
const T = new Date('2026-10-19T12:34:56.789Z');
let root;
before(() => { root = mkdtempSync(join(tmpdir(), 'logstore-')); });
after(() => rmSync(root, { recursive: true, force: true }));

const fileWith = (name, content) => { const p = join(root, name); writeFileSync(p, content); return p; };

describe('where logs live', () => {
  test('LOG_DIR decides, with a per-user default outside the repository', () => {
    assert.equal(logRoot({ LOG_DIR: '/var/lib/shipdok/logs' }), '/var/lib/shipdok/logs');
    assert.match(logRoot({}), /\.shipdok[\\/]logs$/);
    assert.match(logRoot({ LOG_DIR: '' }), /\.shipdok[\\/]logs$/);
  });

  test('the path is built only from the two ids and the kind', () => {
    assert.equal(logFilePath('/r', APP, DEP, 'build'), `/r/${APP}/${DEP}/build.log`);
    assert.equal(logFilePath('/r', APP, DEP, 'runtime'), `/r/${APP}/${DEP}/runtime.log`);
  });

  for (const [label, app, dep, kind] of [
    ['a traversal in the app id', '../../etc', DEP, 'build'],
    ['a traversal in the deployment id', APP, '../x', 'build'],
    ['a slash in the id', `${APP}/..`, DEP, 'build'],
    ['an empty id', '', DEP, 'build'],
    ['an id that is not a UUID', 'my-app', DEP, 'build'],
    ['an unknown kind', APP, DEP, '../passwd'],
    ['a non-string id', null, DEP, 'build'],
  ]) {
    test(`refuses ${label}`, () => assert.throws(() => logFilePath('/r', app, dep, kind), /invalid/i));
  }
});

describe('formatLine', () => {
  test('is "timestamp stream message" and ends in exactly one newline', () => {
    assert.equal(formatLine(T, 'stdout', 'hello'), '2026-10-19T12:34:56.789Z stdout hello\n');
    assert.equal(formatLine(T, 'shipdok', 'Cloning'), '2026-10-19T12:34:56.789Z shipdok Cloning\n');
  });
  test('a message can never forge a second log line or carry a carriage return', () => {
    const out = formatLine(T, 'stdout', 'a\nFAKE 2099 stderr injected\r\nb\rc');
    assert.equal(out.split('\n').length, 2, 'one line plus the final newline');
    assert.ok(!out.includes('\r'));
  });
  test('terminal colour codes are removed, other text is untouched', () => {
    assert.equal(formatLine(T, 'stdout', '\u001b[31mred\u001b[0m and \u001b[1;32mgreen\u001b[0m'), '2026-10-19T12:34:56.789Z stdout red and green\n');
    assert.match(formatLine(T, 'stdout', 'tab\there – naïve ✓'), /tab\there – naïve ✓\n$/);
  });
  test('other control characters and NUL bytes become a visible placeholder', () => {
    assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(formatLine(T, 'stdout', 'a\u0000b\u0007c\u001bd')));
  });
  test('a very long line is cut, on a character boundary, and says so', () => {
    // the leading "a" shifts every é by one byte, so the cut lands in the MIDDLE of a character
    const out = formatLine(T, 'stdout', 'a' + 'é'.repeat(MAX_LINE_BYTES));
    assert.ok(Buffer.byteLength(out) < MAX_LINE_BYTES + 100);
    assert.match(out, /\[line cut\]\n$/);
    assert.ok(!out.includes('�'), 'no half character');
  });
  test('an unknown stream name is refused', () => {
    assert.throws(() => formatLine(T, 'stdin', 'x'), /stream/i);
  });
  test('an empty message is still a line', () => {
    assert.equal(formatLine(T, 'stdout', ''), '2026-10-19T12:34:56.789Z stdout \n');
  });
});

describe('createRedactor', () => {
  test('replaces every occurrence of every secret', () => {
    const redact = createRedactor(['hunter2-secret', 'TOKEN-ABCDEF']);
    assert.equal(redact('x hunter2-secret y TOKEN-ABCDEF z hunter2-secret'), 'x *** y *** z ***');
  });
  test('longer secrets win over a shorter one inside them', () => {
    assert.equal(createRedactor(['abcd', 'abcdefgh']).call(null, 'abcdefgh'), '***');
  });
  test('very short values are left alone (masking "1" would wreck every line)', () => {
    assert.equal(createRedactor(['1', 'ab', 'abc']).call(null, '1 ab abc 123'), '1 ab abc 123');
  });
  test('empty, undefined and duplicate secrets are fine', () => {
    assert.equal(createRedactor(['', undefined, null, 'secret-1', 'secret-1']).call(null, 'a secret-1 b'), 'a *** b');
  });
  test('with no secrets the text is returned as it is', () => {
    assert.equal(createRedactor([]).call(null, 'plain'), 'plain');
  });
  test('regex characters in a secret are taken literally', () => {
    assert.equal(createRedactor(['a.b*c(d)']).call(null, 'x a.b*c(d) y aXbbbcd'), 'x *** y aXbbbcd');
  });
});

describe('secretsFromGitEnv (the GitHub token that git is given)', () => {
  test('yields both the token and the base64 header value', () => {
    const secrets = secretsFromGitEnv(gitAuthEnv('ghs_TheInstallationToken123'));
    assert.ok(secrets.includes('ghs_TheInstallationToken123'));
    assert.ok(secrets.includes(Buffer.from('x-access-token:ghs_TheInstallationToken123').toString('base64')));
  });
  test('masks both forms in a line that leaks either', () => {
    const env = gitAuthEnv('ghs_TheInstallationToken123');
    const redact = createRedactor(secretsFromGitEnv(env));
    assert.equal(redact(`header ${env.GIT_CONFIG_VALUE_0} and ghs_TheInstallationToken123`), 'header Authorization: Basic *** and ***');
  });
  test('nothing for an anonymous clone, and no crash on odd input', () => {
    assert.deepEqual(secretsFromGitEnv({}), []);
    assert.deepEqual(secretsFromGitEnv(undefined), []);
    assert.deepEqual(secretsFromGitEnv({ GIT_CONFIG_VALUE_0: 'not an auth header' }), []);
  });
});

describe('readChunk (paging by byte offset)', () => {
  const lines = (n) => Array.from({ length: n }, (_, i) => formatLine(T, 'stdout', `line ${i}`)).join('');

  test('reads from an offset and says where to continue', async () => {
    const p = fileWith('a.log', lines(10));
    const first = await readChunk(p, 0, 100_000);
    assert.equal(first.text, lines(10));
    assert.equal(first.next, first.size);
  });

  test('paging in small steps reproduces the whole file with nothing cut or repeated', async () => {
    const content = lines(200);
    const p = fileWith('b.log', content);
    let offset = 0; let text = '';
    for (let i = 0; i < 1000 && offset < Buffer.byteLength(content); i++) {
      const c = await readChunk(p, offset, 200, { minLimit: 1 });
      assert.ok(c.text === '' || c.text.endsWith('\n'), 'always whole lines');
      text += c.text;
      assert.ok(c.next >= offset);
      offset = c.next;
    }
    assert.equal(text, content);
  });

  test('never returns half a line or half a character', async () => {
    const content = formatLine(T, 'stdout', 'héllo wörld ✓ ünïcode').repeat(50);
    const p = fileWith('c.log', content);
    const c = await readChunk(p, 0, 333, { minLimit: 1 });
    assert.ok(c.text.endsWith('\n'));
    assert.ok(!c.text.includes('�'));
  });

  test('a line that is still being written is not returned until it ends', async () => {
    const p = fileWith('d.log', formatLine(T, 'stdout', 'done') + '2026-10-19T12:34:56.789Z stdout half-writ');
    const c = await readChunk(p, 0, 100_000);
    assert.equal(c.text, formatLine(T, 'stdout', 'done'));
    assert.equal(c.next, Buffer.byteLength(formatLine(T, 'stdout', 'done')));
  });

  test('a file that holds only an unfinished line yields nothing yet', async () => {
    const p = fileWith('d2.log', '2026-10-19T12:34:56.789Z stdout half-writ');
    const c = await readChunk(p, 0, 100_000);
    assert.deepEqual([c.text, c.next], ['', 0]);
  });

  test('at the end it returns nothing and keeps the offset', async () => {
    const p = fileWith('e.log', lines(2));
    const size = Buffer.byteLength(lines(2));
    const c = await readChunk(p, size, 100_000);
    assert.deepEqual([c.text, c.next, c.size], ['', size, size]);
  });

  test('an offset beyond the end is treated as the end', async () => {
    const p = fileWith('f.log', lines(2));
    const c = await readChunk(p, 10_000_000, 100);
    assert.equal(c.text, '');
    assert.equal(c.next, c.size);
  });

  test('a missing file reads as null, not an exception', async () => {
    assert.equal(await readChunk(join(root, 'nope.log'), 0, 100), null);
  });

  test('negative or fractional offsets and limits are refused', async () => {
    const p = fileWith('g.log', lines(2));
    await assert.rejects(readChunk(p, -1, 100), /offset/i);
    await assert.rejects(readChunk(p, 1.5, 100), /offset/i);
    await assert.rejects(readChunk(p, 0, 0), /limit/i);
    await assert.rejects(readChunk(p, 0, 1e12), /limit/i);
  });
});

describe('readTail', () => {
  const content = Array.from({ length: 500 }, (_, i) => formatLine(T, 'stdout', `line ${i}`)).join('');

  test('returns the last N whole lines', async () => {
    const p = fileWith('t1.log', content);
    const t = await readTail(p, 3);
    assert.deepEqual(t.text.trimEnd().split('\n').map((l) => l.split(' ').slice(2).join(' ')), ['line 497', 'line 498', 'line 499']);
    assert.equal(t.next, t.size);
  });
  test('a short file is returned whole', async () => {
    const p = fileWith('t2.log', formatLine(T, 'stdout', 'only'));
    assert.equal((await readTail(p, 50)).text, formatLine(T, 'stdout', 'only'));
  });
  test('a huge file is only read from its end (the byte budget), never loaded whole, and starts on a line boundary', async () => {
    const p = fileWith('t3.log', content);
    const t = await readTail(p, 10_000, 2_000);
    assert.ok(Buffer.byteLength(t.text) <= 2_000);
    assert.match(t.text, /^2026-/, 'does not start in the middle of a line');
    assert.ok(t.text.endsWith('line 499\n'));
  });
  test('an empty file and a missing file', async () => {
    const p = fileWith('t4.log', '');
    assert.deepEqual([(await readTail(p, 5)).text, (await readTail(p, 5)).next], ['', 0]);
    assert.equal(await readTail(join(root, 'missing.log'), 5), null);
  });
  test('a line count of zero or nonsense is refused', async () => {
    const p = fileWith('t5.log', content);
    await assert.rejects(readTail(p, 0), /lines/i);
    await assert.rejects(readTail(p, -2), /lines/i);
  });
});

describe('removeDeploymentLogs', () => {
  test('removes that deployment\'s directory and reports the bytes freed', async () => {
    const dir = join(root, APP, DEP);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'build.log'), 'x'.repeat(1000));
    writeFileSync(join(dir, 'runtime.log'), 'y'.repeat(234));
    assert.equal(await removeDeploymentLogs(root, APP, DEP), 1234);
    assert.ok(!existsSync(dir));
  });
  test('leaves other deployments and other apps alone', async () => {
    const other = '33333333-3333-4333-8333-333333333333';
    mkdirSync(join(root, APP, other), { recursive: true });
    writeFileSync(join(root, APP, other, 'build.log'), 'keep');
    mkdirSync(join(root, APP, DEP), { recursive: true });
    await removeDeploymentLogs(root, APP, DEP);
    assert.equal(readFileSync(join(root, APP, other, 'build.log'), 'utf8'), 'keep');
  });
  test('removing something that is not there is fine and frees nothing', async () => {
    assert.equal(await removeDeploymentLogs(root, APP, '44444444-4444-4444-8444-444444444444'), 0);
  });
  test('refuses ids that could point elsewhere, and touches nothing', async () => {
    await assert.rejects(removeDeploymentLogs(root, '..', DEP), /invalid/i);
    await assert.rejects(removeDeploymentLogs(root, APP, '../..'), /invalid/i);
    await assert.rejects(removeDeploymentLogs(root, APP, ''), /invalid/i);
    assert.ok(existsSync(root));
  });
});
