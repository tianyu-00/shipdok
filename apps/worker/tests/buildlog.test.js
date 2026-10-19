// The sink that turns raw process output into a deployment's log file: line splitting, masking, the size cap.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogSink } from '../src/buildlog.js';
import { createRedactor } from '@shipdok/shared';

const base = mkdtempSync(join(tmpdir(), 'buildlog-'));
after(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
let file;
beforeEach(() => { n += 1; file = join(base, `d${n}`, 'sub', 'build.log'); });

const FIXED = () => new Date('2026-10-19T12:00:00.000Z');
const open = (over = {}) => createLogSink({ file, now: FIXED, ...over });
const lines = () => readFileSync(file, 'utf8').trimEnd().split('\n');
const msgs = () => lines().map((l) => l.split(' ').slice(2).join(' '));

describe('writing lines', () => {
  test('creates the directories and writes one formatted line per line of output', async () => {
    const s = open();
    s.write('stdout', 'first\nsecond\n');
    await s.close();
    assert.deepEqual(lines(), ['2026-10-19T12:00:00.000Z stdout first', '2026-10-19T12:00:00.000Z stdout second']);
  });

  test('a line split across chunks is joined; a final line without a newline is kept on close', async () => {
    const s = open();
    s.write('stdout', Buffer.from('hel'));
    s.write('stdout', Buffer.from('lo wor'));
    s.write('stdout', Buffer.from('ld\nlast, no newline'));
    await s.close();
    assert.deepEqual(msgs(), ['hello world', 'last, no newline']);
  });

  test('a multi-byte character split across two chunks survives', async () => {
    const bytes = Buffer.from('naïve ✓ ok\n');
    const s = open();
    s.write('stdout', bytes.subarray(0, 3)); // "na" + the first byte of the two-byte "ï"
    s.write('stdout', bytes.subarray(3));
    await s.close();
    assert.deepEqual(msgs(), ['naïve ✓ ok']);
  });

  test('stdout and stderr keep their own partial lines and are labelled', async () => {
    const s = open();
    s.write('stdout', 'out-part-');
    s.write('stderr', 'err one\n');
    s.write('stdout', 'finished\n');
    await s.close();
    assert.deepEqual(lines().map((l) => l.split(' ').slice(1, 3).join(' ')), ['stderr err', 'stdout out-part-finished']);
  });

  test('line() writes a message from Shipdok itself', async () => {
    const s = open();
    s.line('shipdok', 'Cloning x');
    await s.close();
    assert.equal(lines()[0], '2026-10-19T12:00:00.000Z shipdok Cloning x');
  });

  test('empty chunks and blank lines are harmless', async () => {
    const s = open();
    s.write('stdout', '');
    s.write('stdout', '\n\n');
    await s.close();
    assert.equal(lines().length, 2);
  });

  test('windows line endings do not leave a carriage return behind', async () => {
    const s = open();
    s.write('stdout', 'a\r\nb\r\n');
    await s.close();
    assert.deepEqual(msgs(), ['a', 'b']);
  });
});

describe('secrets', () => {
  test('are masked, including one that arrives split across two chunks', async () => {
    const s = open({ redact: createRedactor(['ghs_SuperSecretToken']) });
    s.write('stderr', 'fatal: auth ghs_SuperSe');
    s.write('stderr', 'cretToken failed\n');
    s.line('shipdok', 'token is ghs_SuperSecretToken');
    await s.close();
    assert.ok(!readFileSync(file, 'utf8').includes('ghs_Super'));
    assert.deepEqual(msgs(), ['fatal: auth *** failed', 'token is ***']);
  });

  test('the timestamp is never touched, even if a secret looks like part of it', async () => {
    const s = open({ redact: createRedactor(['2026']) });
    s.write('stdout', 'year 2026\n');
    await s.close();
    assert.equal(lines()[0], '2026-10-19T12:00:00.000Z stdout year ***');
  });

  test('the masking can be extended while the sink is open (secrets become known after it starts)', async () => {
    let redact = createRedactor([]);
    const s = open({ redact: (t) => redact(t) });
    s.line('shipdok', 'before secret-value-1 known');
    redact = createRedactor(['secret-value-1']);
    s.line('shipdok', 'after secret-value-1 known');
    await s.close();
    assert.deepEqual(msgs(), ['before secret-value-1 known', 'after *** known']);
  });
});

describe('the size cap', () => {
  test('stops storing once the cap is reached, says so once, and reports it', async () => {
    const s = open({ maxBytes: 600 });
    for (let i = 0; i < 100; i++) s.line('stdout', `line number ${i} with some padding`);
    const result = await s.close();
    assert.equal(result.truncated, true);
    const all = readFileSync(file, 'utf8');
    assert.equal(all.split('log truncated').length - 1, 1, 'announced exactly once');
    assert.ok(statSync(file).size < 600 + 200, 'a little over the cap at most: the note itself');
    assert.ok(!all.includes('line number 99'));
    assert.match(lines().at(-1), /shipdok .*truncated/i);
  });

  test('output under the cap is not truncated', async () => {
    const s = open({ maxBytes: 100_000 });
    s.line('stdout', 'small');
    assert.equal((await s.close()).truncated, false);
  });

  test('reports the real size of what was written', async () => {
    const s = open();
    s.write('stdout', 'abc\ndef\n');
    const r = await s.close();
    assert.equal(r.bytes, statSync(file).size);
  });
});

describe('never getting in the way of a deployment', () => {
  test('a write failure is swallowed (the deployment must not fail because a log could not be written)', async () => {
    const blocker = join(base, 'a-file-where-a-directory-should-be');
    writeFileSync(blocker, 'x');
    const s = createLogSink({ file: join(blocker, 'sub', 'build.log'), now: FIXED });
    s.line('stdout', 'x');
    s.write('stdout', 'y\n');
    const r = await s.close();
    assert.equal(r.failed, true);
  });

  test('an error that only shows up when the file is opened (here: the path is a directory) is also swallowed', async () => {
    const dir = join(base, 'a-directory');
    mkdirSync(dir);
    const s = createLogSink({ file: dir, now: FIXED });
    s.line('stdout', 'x');
    s.write('stdout', 'y\n');
    const r = await s.close();
    assert.equal(r.failed, true);
  });

  test('close() can be called twice', async () => {
    const s = open();
    s.line('stdout', 'x');
    await s.close();
    await s.close();
    assert.equal(lines().length, 1);
  });

  test('anything written after close is ignored', async () => {
    const s = open();
    await s.close();
    s.line('stdout', 'late');
    assert.ok(!existsSync(file) || !readFileSync(file, 'utf8').includes('late'));
  });
});
