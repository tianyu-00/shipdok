// The activity log, written by the API (what the administrator does) and by the worker (what Shipdok does by itself).
// `details` is a short list of facts: change('Mode', 'Local', 'Webhook only') or fact('Backup', 'made 3 Nov'). Never put a secret in one:
// a password, passphrase, key or variable value is at most said to have changed.
export const AUDIT_CATEGORIES = ['security', 'github', 'backups', 'apps', 'deployments', 'variables', 'storage'];
export const AUDIT_SOURCES = ['user', 'webhook', 'schedule', 'system'];

export const KEEP_DAYS_CHOICES = [7, 30, 90, 365];
export const KEEP_DAYS_KEY = 'activity_keep_days';
export const DEFAULT_KEEP_DAYS = 30;

// The days a row is kept: the stored choice when it is a whole number of at least 7 (a damaged value can never stop a sign-in from being recorded), else 30.
const KEEP_DAYS_SQL = `GREATEST(7, COALESCE((SELECT CASE WHEN value #>> '{}' ~ '^[0-9]{1,4}$' THEN (value #>> '{}')::int END FROM settings WHERE key = '${KEEP_DAYS_KEY}'), ${DEFAULT_KEEP_DAYS}))`;

/** The days sign-ins and activity are kept for now. */
export async function keepDays(client) {
  const { rows } = await client.query(`SELECT ${KEEP_DAYS_SQL} AS days`);
  return rows[0].days;
}

/** Deletes the sign-in rows and the activity rows older than the kept days; says how many of each. */
export async function trimLog(client) {
  const attempts = await client.query(`DELETE FROM login_attempts WHERE at < now() - make_interval(days => ${KEEP_DAYS_SQL})`);
  const audit = await client.query(`DELETE FROM audit_log WHERE at < now() - make_interval(days => ${KEEP_DAYS_SQL})`);
  return { attempts: attempts.rowCount, audit: audit.rowCount };
}

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

/** The changes between two versions of a record: one `change` for each key whose value differs (null and empty count as the same). */
export function changesOf(before, after, labels) {
  const numeric = (x) => x !== null && x !== undefined && x !== '' && typeof x !== 'boolean' && !Number.isNaN(Number(x));
  const same = (a, b) => (numeric(a) && numeric(b) ? Number(a) === Number(b) : (a ?? '') === (b ?? '') || String(a) === String(b));
  return Object.keys(after).filter((k) => !same(before[k], after[k])).map((k) => change(labels[k] ?? k, before[k], after[k]));
}
