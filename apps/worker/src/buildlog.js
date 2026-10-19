// Turns the raw output of a deployment (git, docker build, and Shipdok's own progress messages) into its log file:
// whole lines, secrets masked, one size cap. It must never get in the way of the deployment, so a log that cannot be
// written (disk full, bad permissions) is dropped quietly and reported in the result instead of throwing.
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { formatLine } from '@shipdok/shared';

export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const STREAMS = ['stdout', 'stderr', 'shipdok'];

/**
 * @param {object} o
 * @param {string} o.file                   where to append
 * @param {(text: string) => string} [o.redact]   masks secrets; called per line, so it may be swapped out later
 * @param {number} [o.maxBytes]             stop storing after this many bytes (the file is then marked truncated)
 * @param {number} [o.startBytes]           size of the file when continuing it (counts towards the cap)
 * @param {boolean} [o.startTruncated]      the file was already cut short: store nothing more
 */
export function createLogSink({
  file, redact = (t) => t, maxBytes = DEFAULT_MAX_BYTES, now = () => new Date(),
  startBytes = 0, startTruncated = false, // continuing a file that already has content (or was already cut short)
}) {
  let stream = null;
  let bytes = startBytes;
  let truncated = startTruncated;
  let failed = false;
  let closed = false;
  let result = null;
  const partial = Object.fromEntries(STREAMS.map((s) => [s, '']));
  const decoders = Object.fromEntries(STREAMS.map((s) => [s, new StringDecoder('utf8')]));

  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o750 });
    stream = createWriteStream(file, { flags: 'a', mode: 0o640 });
    stream.on('error', () => { failed = true; });
  } catch {
    failed = true;
  }

  const store = (text) => {
    bytes += Buffer.byteLength(text);
    stream.write(text);
  };

  // `at`: the time the line really happened (the app's own output carries the time Docker saw it); default: now.
  function line(name, text, at) {
    if (closed || failed || truncated) return;
    const out = formatLine(at ?? now(), name, redact(String(text)));
    if (bytes + Buffer.byteLength(out) > maxBytes) {
      truncated = true;
      store(formatLine(now(), 'shipdok', `Output cut: log truncated at the size limit of ${Math.round(maxBytes / 1024 / 1024)} MB; later output is not stored`));
      return;
    }
    store(out);
  }

  // Raw bytes from a child process. Lines are only emitted when complete, so a secret split across two chunks is
  // still masked in one piece, and a multi-byte character split across two chunks is rebuilt.
  function write(name, chunk) {
    if (closed || failed) return;
    partial[name] += typeof chunk === 'string' ? chunk : decoders[name].write(chunk);
    const pieces = partial[name].split(/\r?\n/);
    partial[name] = pieces.pop();
    for (const piece of pieces) line(name, piece);
  }

  async function close() {
    if (result) return result;
    for (const name of STREAMS) {
      const rest = partial[name] + decoders[name].end();
      partial[name] = '';
      if (rest) line(name, rest);
    }
    closed = true;
    if (stream && !stream.destroyed) {
      await new Promise((resolve) => {
        stream.once('close', resolve);
        stream.once('error', resolve);
        stream.end();
      });
    }
    result = { bytes, truncated, failed };
    return result;
  }

  return { write, line, close, stats: () => ({ bytes, truncated }) };
}
