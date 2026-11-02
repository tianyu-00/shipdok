// The activity log as the API uses it. The core (the categories, the entry, the trimming) is in the shared package, because the worker writes entries too.
import { recordAudit } from '@shipdok/shared';
import { addressOf } from './lockout.js';

export { AUDIT_CATEGORIES, AUDIT_SOURCES, change, fact, recordAudit, changesOf } from '@shipdok/shared';

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
