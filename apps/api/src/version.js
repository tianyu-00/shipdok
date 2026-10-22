// Which Shipdok this is, and whether a newer one has been published. The version is the VERSION file (copied into the API image; a checkout has it at
// the repository root). "Newer" comes from the tags of the published image on ghcr.io: that registry answers anyone for a public image, which the
// GitHub Releases of a private repository do not. Looked up only when somebody asks, kept for an hour; nothing runs in the background.
import { readFileSync } from 'node:fs';

export const IMAGE_REPOSITORY = 'tianyu-00/shipdok-api';
const REGISTRY = 'https://ghcr.io';
const SUCCESS_TTL_MS = 60 * 60 * 1000;
const FAILURE_TTL_MS = 5 * 60 * 1000; // a registry that is down is not asked again on every page load
const FRESH_AFTER_MS = 30 * 1000; // "Check now" may skip the cache, but not more than twice a minute
const TIMEOUT_MS = 5000;

const PLAIN = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

export function readVersion(file = new URL('../../../VERSION', import.meta.url)) {
  try {
    const text = readFileSync(file, 'utf8').trim();
    return PLAIN.test(text) ? text : null;
  } catch {
    return null;
  }
}

const parts = (v) => v.split('.').map(Number);

/** Negative, zero or positive like a sort comparison; both must be plain `1.2.3` numbers. */
export function compareVersions(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** The highest plain version among image tags. `latest`, `sha-…` and pre-release names are not versions. */
export function newestVersion(tags) {
  const plain = (Array.isArray(tags) ? tags : []).filter((t) => typeof t === 'string' && PLAIN.test(t));
  return plain.length === 0 ? null : plain.reduce((best, t) => (compareVersions(t, best) > 0 ? t : best));
}

async function getJson(fetchFn, url, headers = {}) {
  const res = await fetchFn(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

async function publishedTags(fetchFn) {
  const { token } = await getJson(fetchFn, `${REGISTRY}/token?scope=repository:${IMAGE_REPOSITORY}:pull`);
  if (typeof token !== 'string' || !token) throw new Error('no registry token');
  const body = await getJson(fetchFn, `${REGISTRY}/v2/${IMAGE_REPOSITORY}/tags/list?n=1000`, { authorization: `Bearer ${token}` });
  return body.tags;
}

export function createVersionCheck({ current = readVersion(), fetch: fetchFn = globalThis.fetch, now = Date.now } = {}) {
  let cached = null; // { at, latest, error }

  async function look() {
    try {
      const latest = newestVersion(await publishedTags(fetchFn));
      return { at: now(), latest, error: latest ? null : 'no_versions' };
    } catch {
      return { at: now(), latest: null, error: 'unreachable' }; // no detail kept: the cause is the network, and nothing here is worth a log line
    }
  }

  return {
    current,
    async status({ fresh = false } = {}) {
      const age = cached ? now() - cached.at : Infinity;
      const ttl = cached?.error ? FAILURE_TTL_MS : SUCCESS_TTL_MS;
      const usable = cached && age < (fresh ? FRESH_AFTER_MS : ttl);
      if (!usable) cached = await look();
      const { latest, error, at } = cached;
      const updateAvailable = Boolean(current && latest && compareVersions(latest, current) > 0);
      return { current, latest, updateAvailable, checkedAt: new Date(at).toISOString(), error };
    },
  };
}
