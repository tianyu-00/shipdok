// Platform secrets in files, so that `docker compose up` works without a hand-made .env.
//
//   ensureSecrets   the first-run service: writes every secret that is neither given in the environment nor already in the volume
//   loadSecretFiles every process at start: a secret NOT given in the environment is read from the file named by <NAME>_FILE
//
// An environment value always wins (the administrator's choice); an existing file is never overwritten. Nothing here prints, logs or
// puts a secret value into an error or a summary.
import { randomBytes, randomInt } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const SETUP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1: it is typed by hand from a log line
const hex = (bytes) => () => randomBytes(bytes).toString('hex');
const setupToken = () => Array.from({ length: 4 }, () => Array.from({ length: 5 }, () => SETUP_ALPHABET[randomInt(SETUP_ALPHABET.length)]).join('')).join('-');

/** name -> { file, make }. The environment variable is <name>, the path variable <name>_FILE. */
export const SECRET_FILES = {
  APP_SECRETS_KEY: { file: 'app_secrets_key', make: hex(32) }, // 64 hex: the AES-256 key for stored secrets
  SESSION_SECRET: { file: 'session_secret', make: hex(32) },
  POSTGRES_PASSWORD: { file: 'postgres_password', make: hex(24) },
  REDIS_PASSWORD: { file: 'redis_password', make: hex(24) },
  SETUP_TOKEN: { file: 'setup_token', make: setupToken },
};

const MAX_BYTES = 4096;
const given = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * For each known secret that is not set in `env` but has <NAME>_FILE: read the file into env[NAME]. Returns the names it loaded.
 * Throws a clear error (the setting and the path, never a value) when a named file is missing, empty, too large or not an absolute path.
 */
export function loadSecretFiles(env = process.env) {
  const loaded = [];
  for (const name of Object.keys(SECRET_FILES)) {
    if (given(env[name])) continue; // the environment wins, and its file is not even read
    const path = env[`${name}_FILE`];
    if (!given(path)) continue;
    if (!isAbsolute(path)) throw new Error(`${name}_FILE must be an absolute path (${path})`);
    let text;
    try {
      if (statSync(path).size > MAX_BYTES) throw Object.assign(new Error('too large'), { tooLarge: true });
      text = readFileSync(path, 'utf8');
    } catch (err) {
      if (err.tooLarge) throw new Error(`${name}_FILE is too large to be a secret (${path})`);
      throw new Error(`${name}_FILE points to a file that cannot be read (${path})`);
    }
    if (!text.trim()) throw new Error(`${name}_FILE points to an empty file (${path})`);
    env[name] = text.trim();
    loaded.push(name);
  }
  return loaded;
}

function writeNew(path, value) {
  // Write beside it and rename, so a crash never leaves a half-written secret under the real name.
  const temp = `${path}.tmp-${process.pid}`;
  const fd = openSync(temp, 'wx', 0o444);
  try {
    writeSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temp, 0o444);
  renameSync(temp, path);
}

/**
 * The first-run step. For every secret: skip it if the environment gives it; keep the file if there is one; otherwise generate it.
 * @returns {{ created: string[], kept: string[], fromEnvironment: string[] }} names only
 */
export function ensureSecrets({ dir, env = process.env }) {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const out = { created: [], kept: [], fromEnvironment: [] };
  for (const [name, spec] of Object.entries(SECRET_FILES)) {
    if (given(env[name])) { out.fromEnvironment.push(name); continue; }
    const path = join(dir, spec.file);
    if (existsSync(path) && readFileSync(path, 'utf8').trim() !== '') { out.kept.push(name); continue; }
    writeNew(path, spec.make());
    out.created.push(name);
  }
  return out;
}

/**
 * Settings that have a sensible default so that none has to be written anywhere: the database user and name are labels, not secrets.
 * (Docker Compose uses the same defaults.) An unset or empty value becomes the default; a value you set is left alone.
 */
export function applyPlatformDefaults(env = process.env) {
  for (const [name, value] of Object.entries({ POSTGRES_USER: 'shipdok', POSTGRES_DB: 'shipdok' })) {
    if (!given(env[name])) env[name] = value;
  }
  return env;
}
