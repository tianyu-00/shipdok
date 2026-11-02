// The activity log: one row for each thing the administrator does that is worth knowing afterwards, with what changed.
// `details` is a short list of facts: change('Mode', 'Local', 'Webhook only') or fact('Backup', 'made 3 Nov'). Never put a secret in one:
// a password, passphrase, key or variable value is at most said to have changed.
import { addressOf, trimLog } from './lockout.js';

export const AUDIT_CATEGORIES = ['security', 'github', 'backups', 'apps', 'deployments', 'variables', 'storage'];
export const AUDIT_SOURCES = ['user', 'webhook', 'schedule', 'system'];

const MAX_DETAILS = 20;
const MAX_TEXT = 300;
const text = (v) => (v === null || v === undefined || v === '' ? '' : String(v).slice(0, MAX_TEXT));

/** A field that went from one value to another. */
export const change = (label, from, to) => ({ label, from: text(from), to: text(to) });
/** A fact about what was affected. */
export const fact = (label, value) => ({ label, value: text(value) });

export async function recordAudit(client, { category, action, summary, details = [], actor, address, source = 'user', appId = null, appName = null }) {
  if (!AUDIT_CATEGORIES.includes(category)) throw new Error(`Unknown audit category: ${category}`);
  if (!AUDIT_SOURCES.includes(source)) throw new Error(`Unknown audit source: ${source}`);
  await client.query(
    `INSERT INTO audit_log (category, action, summary, details, actor, address, source, app_id, app_name) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [category, action, text(summary), details.length ? JSON.stringify(details.slice(0, MAX_DETAILS)) : null, actor, address, source, appId, appName],
  );
  await trimLog(client);
}

/**
 * Records what the signed-in administrator just did (the name and the address come from the request). It runs AFTER the thing was done and
 * never fails it: an entry that cannot be written is logged and the answer to the person is unchanged.
 */
export async function recordAuditFor(db, req, fields) {
  try {
    const { rows } = await db.query('SELECT username FROM users WHERE id = $1', [req.session?.userId]);
    await recordAudit(db, { actor: rows[0]?.username ?? 'unknown', address: addressOf(req), ...fields });
  } catch (err) {
    console.error('Activity log entry not written:', err.message);
  }
}

/** The changes between two versions of a record: one `change` for each key whose value differs (null and empty count as the same). */
export function changesOf(before, after, labels) {
  const numeric = (x) => x !== null && x !== undefined && x !== '' && typeof x !== 'boolean' && !Number.isNaN(Number(x));
  const same = (a, b) => (numeric(a) && numeric(b) ? Number(a) === Number(b) : (a ?? '') === (b ?? '') || String(a) === String(b));
  return Object.keys(after).filter((k) => !same(before[k], after[k])).map((k) => change(labels[k] ?? k, before[k], after[k]));
}
