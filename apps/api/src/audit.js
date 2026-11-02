// The activity log: one row for each thing the administrator does that is worth knowing afterwards, with what changed.
// `details` is a short list of facts: change('Mode', 'Local', 'Webhook only') or fact('Backup', 'made 3 Nov'). Never put a secret in one:
// a password, passphrase, key or variable value is at most said to have changed.
import { trimLog } from './lockout.js';

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
