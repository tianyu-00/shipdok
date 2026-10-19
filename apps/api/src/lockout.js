// Progressive lockout for sign-in attempts, counted per account name and per client address.
//
// After FREE_TRIES failures in a row (since the last success for that name or address) the next attempts are refused
// for a while, and the wait doubles with each further failure. A success clears the count. While locked, nothing is
// checked at all (even the right password is refused) and the refused try is NOT counted, so hammering cannot extend
// the wait. The per-account wait is shorter than the per-address one: anyone can type the administrator's name, so a
// long account lock would let a stranger keep the administrator out.

export const FREE_TRIES = 4;
export const FIRST_WAIT_SECONDS = 30;
export const ACCOUNT_CAP_SECONDS = 15 * 60;
export const ADDRESS_CAP_SECONDS = 60 * 60;
const WINDOW = '24 hours'; // failures older than this are forgotten
const KEEP = '30 days'; // attempt rows older than this are deleted

/** How long to wait after `failures` failures in a row. */
export function waitSeconds(failures, cap) {
  if (failures <= FREE_TRIES) return 0;
  return Math.min(cap, FIRST_WAIT_SECONDS * 2 ** (failures - FREE_TRIES - 1));
}

const FAILURES = (column) => `
  SELECT count(*)::int AS failures, extract(epoch FROM now() - max(at))::float AS age
    FROM login_attempts
   WHERE ${column} = $1 AND NOT success AND at > now() - interval '${WINDOW}'
     AND at > coalesce((SELECT max(at) FROM login_attempts WHERE ${column} = $1 AND success), '-infinity')`;

async function remaining(client, column, value, cap) {
  const { rows } = await client.query(FAILURES(column), [value]);
  const { failures, age } = rows[0];
  const wait = failures ? waitSeconds(failures, cap) : 0;
  if (wait === 0) return 0; // no wait is owed, whatever the clocks say (a transaction that began earlier than the row it reads gives a negative age)
  return Math.max(0, Math.ceil(wait - age));
}

/** Seconds until this name AND this address may try again (0 = may try now). */
export async function lockedFor(client, { username, address }) {
  const [account, from] = await Promise.all([
    remaining(client, 'username', username, ACCOUNT_CAP_SECONDS),
    remaining(client, 'address', address, ADDRESS_CAP_SECONDS),
  ]);
  return Math.max(account, from);
}

export async function recordAttempt(client, { kind, username, address, success }) {
  await client.query('INSERT INTO login_attempts (kind, username, address, success) VALUES ($1, $2, $3, $4)', [kind, username, address, success]);
  await client.query(`DELETE FROM login_attempts WHERE at < now() - interval '${KEEP}'`);
}

export function lockMessage(seconds) {
  const wait = seconds < 90 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`;
  return `Too many failed attempts. Try again in ${wait}.`;
}

export const cleanName = (username) => String(username).slice(0, 64);
export const addressOf = (req) => req.ip || 'unknown';

/**
 * Run `fn(client)` holding a lock for this name and this address, so a burst of parallel attempts cannot all pass the
 * "not locked" check before any of them is recorded. The locks are taken in a fixed order (name, then address).
 */
export async function withAttemptLock(db, { username, address }, fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`login:name:${username}`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`login:address:${address}`]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
