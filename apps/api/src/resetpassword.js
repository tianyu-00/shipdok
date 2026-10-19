// The way back in for whoever controls the host: sets a new random password for the administrator, signs everyone out and
// clears any lockout. Run it with:  docker compose exec api node scripts/reset-password.js
import { hash } from "@node-rs/argon2";
import { randomInt } from "node:crypto";

const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alikes (l, 1, 0, O ...)

function randomPassword(length = 24) {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export async function resetAdminPassword(db) {
  const { rows } = await db.query("SELECT id, username FROM users LIMIT 1");
  if (!rows[0]) throw new Error("There is no administrator yet: open the dashboard to create one");
  const password = randomPassword();
  await db.query("UPDATE users SET password_hash = $2 WHERE id = $1", [rows[0].id, await hash(password)]);
  await db.query(`DELETE FROM "session" WHERE sess->>'userId' = $1`, [String(rows[0].id)]);
  // A locked-out administrator must be able to try the new password at once: the failed tries stay in the list but stop counting.
  await db.query("UPDATE login_attempts SET forgiven = true WHERE NOT success");
  await db.query("INSERT INTO login_attempts (kind, username, address, success) VALUES ('reset', $1, 'host', true)", [rows[0].username]);
  return { username: rows[0].username, password };
}
