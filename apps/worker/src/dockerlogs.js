// Reading Docker's log stream for a container that has no terminal (ours never do). The stream is a series of frames:
//   byte 0      1 = stdout, 2 = stderr
//   bytes 1-3   zero
//   bytes 4-7   payload length, big endian
//   then        the payload: "<RFC3339Nano timestamp> <text>\n"  (timestamps are asked for)
// Chunks can end anywhere, so the demuxer keeps what it has not finished.

const STREAMS = { 1: 'stdout', 2: 'stderr' };
const MAX_FRAME_BYTES = 1024 * 1024; // a real frame is a line (a few KB); anything bigger means the stream is corrupt

/** @param {(stream: 'stdout'|'stderr', payload: Buffer) => void} onFrame */
export function createDemuxer(onFrame) {
  let pending = Buffer.alloc(0);
  return {
    push(chunk) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= 8) {
        const length = pending.readUInt32BE(4);
        if (length > MAX_FRAME_BYTES) {
          pending = Buffer.alloc(0);
          throw new Error('Corrupt frame in the container log stream');
        }
        if (pending.length < 8 + length) return; // wait for the rest
        const stream = STREAMS[pending[0]];
        const payload = pending.subarray(8, 8 + length);
        pending = pending.subarray(8 + length);
        if (stream && payload.length) onFrame(stream, payload);
      }
    },
  };
}

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)(?: |(?=\r?\n)|$)/;

/**
 * One frame's text as lines with their time. A payload with no readable timestamp gets `fallback` for all its lines.
 * @returns {{date: Date, text: string}[]}
 */
export function parsePayload(payload, fallback = new Date()) {
  let text = String(payload);
  let date = fallback;
  const m = TIMESTAMP.exec(text);
  if (m) {
    const parsed = new Date(m[1]);
    if (!Number.isNaN(parsed.getTime())) date = parsed;
    text = text.slice(m[0].length);
  }
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop(); // the newline that ends the payload
  if (!lines.length) lines.push('');
  return lines.map((l) => ({ date, text: l }));
}
