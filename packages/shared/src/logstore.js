// Persistent logs on disk: where they live, the one-line format, masking secrets, and reading/removing them safely.
// The worker writes these files and the API reads them, so the rules live here, once.
//
//   <LOG_DIR>/<app-id>/<deployment-id>/build.log   clone + docker build + deployment progress (kept until the deployment is deleted)
//   <LOG_DIR>/<app-id>/runtime.log                 the app's own output, for the CURRENT run of its container (one per app: a
//                                                  new deployment or a restart resets it)
//   <LOG_DIR>/<app-id>/runtime.previous.log        the run before that (one generation), so the output of the run that
//                                                  crashed is still readable after it is restarted
//
// Paths are built only from validated UUIDs and a fixed list of kinds, never from anything a client sends.
import { open, readdir, rm, rmdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export const MAX_LINE_BYTES = 16 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND_FILES = { build: 'build.log' };
const RUNTIME_FILES = { runtime: 'runtime.log', runtime_previous: 'runtime.previous.log' };
/** Every file name a deployment's log directory may hold. Anything else in there is not ours. */
export const LOG_FILE_NAMES = Object.values(KIND_FILES);
/** The app-level runtime files. Older versions kept these inside each deployment's directory too. */
export const RUNTIME_FILE_NAMES = Object.values(RUNTIME_FILES);
const STREAMS = ['stdout', 'stderr', 'shipdok'];

export const logRoot = (env = process.env) => (env.LOG_DIR ? env.LOG_DIR : join(homedir(), '.shipdok', 'logs'));

const assertId = (id) => {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new Error('Invalid id in a log path');
  return id;
};

export function logDirFor(root, appId, deploymentId) {
  return join(root, assertId(appId), assertId(deploymentId));
}

/** A deployment's own log (kind 'build'). */
export function logFilePath(root, appId, deploymentId, kind) {
  if (!Object.hasOwn(KIND_FILES, kind)) throw new Error('Invalid log kind');
  return join(logDirFor(root, appId, deploymentId), KIND_FILES[kind]);
}

/** An app's runtime log (kind 'runtime' or 'runtime_previous'): one of each per app, whatever the deployment. */
export function runtimeLogPath(root, appId, kind) {
  if (!Object.hasOwn(RUNTIME_FILES, kind)) throw new Error('Invalid log kind');
  return join(root, assertId(appId), RUNTIME_FILES[kind]);
}

// ---- Writing: one line per message ----

const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const NEWLINES = /\r\n|\n|\r/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

// Cut at a character boundary: never leaves half of a multi-byte character.
function cutUtf8(buf, max) {
  let end = max;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

/** "<ISO time> <stream> <message>\n". One message is always exactly one line. */
export function formatLine(date, stream, text) {
  if (!STREAMS.includes(stream)) throw new Error('Unknown log stream');
  let msg = String(text).replace(ANSI_OSC, '').replace(ANSI_CSI, '').replace(NEWLINES, ' ↵ ').replace(CONTROL, '·');
  const bytes = Buffer.from(msg, 'utf8');
  if (bytes.length > MAX_LINE_BYTES) msg = `${cutUtf8(bytes, MAX_LINE_BYTES)} …[line cut]`;
  return `${date.toISOString()} ${stream} ${msg}\n`;
}

const MASK = '***';
const MIN_SECRET_LENGTH = 4; // masking "1" would wreck every line

/** Returns a function that replaces every occurrence of every secret. Best effort: it cannot find a secret the app computes itself. */
export function createRedactor(secrets) {
  const list = [...new Set((secrets ?? []).filter((s) => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH))]
    .sort((a, b) => b.length - a.length); // a secret inside a longer one must not leave the rest showing
  if (!list.length) return (text) => text;
  return (text) => list.reduce((t, s) => t.split(s).join(MASK), text);
}

/** The GitHub token as git is given it: the base64 header value AND the token inside it. */
export function secretsFromGitEnv(gitEnv) {
  const out = [];
  for (const [key, value] of Object.entries(gitEnv ?? {})) {
    if (!key.startsWith('GIT_CONFIG_VALUE_')) continue;
    const m = /^Authorization:\s*Basic\s+(\S+)/i.exec(String(value));
    if (!m) continue;
    out.push(m[1]);
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon >= 0) out.push(decoded.slice(colon + 1));
  }
  return out;
}

// ---- Reading ----

const MAX_LIMIT = 1024 * 1024;
const DEFAULT_MIN_LIMIT = 32 * 1024; // always room for the longest line

async function openOrNull(file) {
  try {
    return await open(file, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Whole lines starting at byte `offset`, at most about `limit` bytes. Continue from `next`.
 * A line that is still being written (no newline yet) is not returned. Returns null if there is no such file.
 */
export async function readChunk(file, offset, limit, { minLimit = DEFAULT_MIN_LIMIT } = {}) {
  if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid offset');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error('Invalid limit');
  const want = Math.max(limit, minLimit);
  const fh = await openOrNull(file);
  if (!fh) return null;
  try {
    const { size } = await fh.stat();
    if (offset >= size) return { text: '', start: size, next: size, size };
    const buf = Buffer.alloc(Math.min(want, size - offset));
    const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
    const data = buf.subarray(0, bytesRead);
    const lastNl = data.lastIndexOf(0x0a);
    if (lastNl < 0) {
      if (data.length < want) return { text: '', start: offset, next: offset, size }; // an unfinished line
      const whole = cutUtf8(data, data.length); // a line longer than the chunk: hand over what there is
      return { text: whole, start: offset, next: offset + Buffer.byteLength(whole), size };
    }
    return { text: data.subarray(0, lastNl + 1).toString('utf8'), start: offset, next: offset + lastNl + 1, size };
  } finally {
    await fh.close();
  }
}

/** The last `lines` whole lines, reading at most `maxBytes` from the end of the file. Returns null if there is no such file. */
export async function readTail(file, lines, maxBytes = 256 * 1024) {
  if (!Number.isInteger(lines) || lines < 1) throw new Error('Invalid lines');
  const fh = await openOrNull(file);
  if (!fh) return null;
  try {
    const { size } = await fh.stat();
    if (size === 0) return { text: '', start: 0, next: 0, size };
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    let data = buf.subarray(0, bytesRead);
    let skipped = 0;
    if (start > 0) { // we began mid-file: the first line is probably partial
      const nl = data.indexOf(0x0a);
      skipped = nl < 0 ? data.length : nl + 1;
      data = data.subarray(skipped);
    }
    const lastNl = data.lastIndexOf(0x0a);
    if (lastNl < 0) return { text: '', start: size, next: start + skipped, size };
    const complete = data.subarray(0, lastNl + 1).toString('utf8');
    const all = complete.split('\n');
    all.pop(); // the empty piece after the final newline
    const picked = all.slice(-lines);
    const text = picked.length ? `${picked.join('\n')}\n` : '';
    return { text, start: size - Buffer.byteLength(text), next: start + skipped + lastNl + 1, size };
  } finally {
    await fh.close();
  }
}

// ---- Removing ----

/** Deletes one deployment's logs. Returns the bytes freed. Nothing outside that deployment's own directory is touched. */
export async function removeDeploymentLogs(root, appId, deploymentId) {
  const dir = logDirFor(root, appId, deploymentId);
  if (!resolve(dir).startsWith(resolve(root) + sep)) throw new Error('Invalid log path');
  let freed = 0;
  try {
    for (const name of await readdir(dir)) freed += (await stat(join(dir, name))).size;
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  await rm(dir, { recursive: true, force: true });
  await rmdir(join(root, appId)).catch(() => {}); // the app's directory too, if that was its last file (it fails while runtime logs are in it)
  return freed;
}

/** Deletes an app's two runtime logs (not its deployments' build logs). Returns the bytes freed. */
export async function removeRuntimeLogs(root, appId) {
  let freed = 0;
  for (const kind of Object.keys(RUNTIME_FILES)) {
    const file = runtimeLogPath(root, appId, kind);
    try {
      freed += (await stat(file)).size;
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    await rm(file, { force: true });
  }
  await rmdir(join(root, appId)).catch(() => {});
  return freed;
}

/** Deletes EVERYTHING stored for an app: its runtime logs and every deployment's build log. Returns the bytes freed. */
export async function removeAppLogs(root, appId) {
  const dir = join(root, assertId(appId));
  if (!resolve(dir).startsWith(resolve(root) + sep)) throw new Error('Invalid log path');
  const size = async (d) => {
    let total = 0;
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      total += entry.isDirectory() ? await size(path) : (await stat(path)).size;
    }
    return total;
  };
  let freed = 0;
  try {
    freed = await size(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  await rm(dir, { recursive: true, force: true });
  return freed;
}
