// The container paths an app keeps (persistent storage). Checked by the API and the worker (this file) and, the same way, in the dashboard (apps/web/src/lib/volumes.js).
export const MAX_VOLUMES = 10;
const MAX_PATH = 200;
const SAFE = /^[A-Za-z0-9._/-]+$/;
// Mounting over these would break the container itself.
const FORBIDDEN = ['/proc', '/sys', '/dev'];

/** One path, tidied (doubled and trailing slashes removed), or { error }. */
export function normalizeVolumePath(input) {
  if (typeof input !== 'string') return { error: 'Each path must be text' };
  const raw = input.trim();
  if (!raw.startsWith('/')) return { error: `"${raw}" is not an absolute path (it must start with /)` };
  const path = `/${raw.split('/').filter(Boolean).join('/')}`;
  if (path === '/') return { error: 'The root directory cannot be a persistent path' };
  if (path.length > MAX_PATH) return { error: 'A path can be at most 200 characters' };
  if (!SAFE.test(path)) return { error: `"${path}": use only letters, digits, dot, dash, underscore and slash` };
  if (path.split('/').some((seg) => seg === '.' || seg === '..')) return { error: `"${path}" must not contain . or .. parts` };
  if (FORBIDDEN.some((f) => path === f || path.startsWith(`${f}/`))) return { error: `${path} cannot be used: mounting over it would break the container` };
  return { path };
}

/** The whole list: tidied, sorted, without duplicates or nested pairs, at most 10. Returns { paths } or { error }. */
export function normalizeVolumePaths(input) {
  if (!Array.isArray(input)) return { error: 'paths must be a list of container paths' };
  if (input.length > MAX_VOLUMES) return { error: `An app can have at most ${MAX_VOLUMES} persistent paths` };
  const paths = [];
  for (const item of input) {
    const one = normalizeVolumePath(item);
    if (one.error) return { error: one.error };
    if (paths.includes(one.path)) return { error: `${one.path} is listed twice` };
    paths.push(one.path);
  }
  paths.sort();
  for (const a of paths) {
    for (const b of paths) {
      if (a !== b && b.startsWith(`${a}/`)) return { error: `${b} is inside ${a}: keep one or the other` };
    }
  }
  return { paths };
}
