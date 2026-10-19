// Docker's log stream for a container without a terminal: frames of [type, 0, 0, 0, length (4 bytes, big endian), payload],
// where each payload is "<RFC3339Nano timestamp> <text>\n". Parsing it must survive any way the bytes are chunked.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createDemuxer, parsePayload } from '../src/dockerlogs.js';

const frame = (type, text) => {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
};
const collect = () => { const got = []; return { got, d: createDemuxer((stream, payload) => got.push([stream, payload.toString()])) }; };

describe('createDemuxer', () => {
  test('one frame', () => {
    const { got, d } = collect();
    d.push(frame(1, 'hello\n'));
    assert.deepEqual(got, [['stdout', 'hello\n']]);
  });

  test('stdout is type 1 and stderr is type 2', () => {
    const { got, d } = collect();
    d.push(Buffer.concat([frame(1, 'out\n'), frame(2, 'err\n')]));
    assert.deepEqual(got, [['stdout', 'out\n'], ['stderr', 'err\n']]);
  });

  test('several frames in one chunk', () => {
    const { got, d } = collect();
    d.push(Buffer.concat([frame(1, 'a\n'), frame(1, 'b\n'), frame(2, 'c\n')]));
    assert.equal(got.length, 3);
  });

  test('the same result however the bytes are split, even one byte at a time', () => {
    const whole = Buffer.concat([frame(1, 'first line\n'), frame(2, 'second ✓ line\n'), frame(1, 'x\n')]);
    for (const size of [1, 2, 3, 5, 7, 8, 9, 13, whole.length]) {
      const { got, d } = collect();
      for (let i = 0; i < whole.length; i += size) d.push(whole.subarray(i, i + size));
      assert.deepEqual(got, [['stdout', 'first line\n'], ['stderr', 'second ✓ line\n'], ['stdout', 'x\n']], `chunks of ${size}`);
    }
  });

  test('a frame whose payload has not fully arrived is not delivered early', () => {
    const { got, d } = collect();
    const f = frame(1, 'complete line\n');
    d.push(f.subarray(0, f.length - 3));
    assert.deepEqual(got, []);
    d.push(f.subarray(f.length - 3));
    assert.equal(got.length, 1);
  });

  test('empty frames are skipped, and frames of an unknown type are ignored', () => {
    const { got, d } = collect();
    d.push(Buffer.concat([frame(1, ''), frame(0, 'stdin?\n'), frame(3, 'weird\n'), frame(1, 'kept\n')]));
    assert.deepEqual(got, [['stdout', 'kept\n']]);
  });

  test('a corrupt, absurdly large length stops parsing instead of exhausting memory', () => {
    const { got, d } = collect();
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(0xffffffff, 4);
    assert.throws(() => d.push(header), /frame/i);
    assert.deepEqual(got, []);
  });
});

describe('parsePayload', () => {
  test('splits the timestamp from the text', () => {
    const [l] = parsePayload('2026-10-19T01:00:50.123456789Z listening on 3000\n');
    assert.equal(l.date.toISOString(), '2026-10-19T01:00:50.123Z');
    assert.equal(l.text, 'listening on 3000');
  });

  test('keeps the text exactly, including leading spaces and an empty message', () => {
    assert.equal(parsePayload('2026-10-19T01:00:50.000000000Z   indented\n')[0].text, '  indented');
    assert.equal(parsePayload('2026-10-19T01:00:50.000000000Z \n')[0].text, '');
    assert.equal(parsePayload('2026-10-19T01:00:50.000000000Z\n')[0].text, '');
  });

  test('a payload with several lines gives one entry per line, all with the same timestamp', () => {
    const lines = parsePayload('2026-10-19T01:00:50.500000000Z one\ntwo\nthree\n');
    assert.deepEqual(lines.map((l) => l.text), ['one', 'two', 'three']);
    assert.ok(lines.every((l) => l.date.getTime() === lines[0].date.getTime()));
  });

  test('a payload without a trailing newline is still a line', () => {
    assert.equal(parsePayload('2026-10-19T01:00:50.000000000Z partial')[0].text, 'partial');
  });

  test('carriage returns are dropped', () => {
    assert.equal(parsePayload('2026-10-19T01:00:50.000000000Z windows\r\n')[0].text, 'windows');
  });

  test('a payload without a recognisable timestamp falls back to the given time and keeps the whole text', () => {
    const at = new Date('2026-01-01T00:00:00Z');
    const [l] = parsePayload('no timestamp here\n', at);
    assert.equal(l.date, at);
    assert.equal(l.text, 'no timestamp here');
  });

  test('multi-byte text is intact', () => {
    assert.equal(parsePayload('2026-10-19T01:00:50.000000000Z naïve ✓\n')[0].text, 'naïve ✓');
  });
});
