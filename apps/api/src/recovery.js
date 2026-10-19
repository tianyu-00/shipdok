// Recovery codes: ten long random codes the administrator keeps somewhere safe. Each one sets a new password once.
//
// A code is 16 characters from a 32-letter alphabet (80 bits), written in four groups of four. Because it is random and
// that long, a plain SHA-256 is enough to store it (a slow hash protects short human passwords, not this), and it lets
// the database find the code by equality. Guessing is held back by the lockout, not by the hash.
import { createHash, randomInt } from "node:crypto";

export const CODE_COUNT = 10;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // no I, L, O, U: nothing to mix up when copying by hand
const LENGTH = 16;

function makeCode() {
  let raw = "";
  for (let i = 0; i < LENGTH; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  return raw.match(/.{4}/g).join("-");
}

export function generateCodes(count = CODE_COUNT) {
  const codes = new Set();
  while (codes.size < count) codes.add(makeCode());
  return [...codes];
}

/** What was typed, reduced to the 16 characters it stands for; null if it cannot be a code. */
export function normalizeCode(input) {
  if (typeof input !== "string" || input.length > 64) return null;
  const raw = input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return raw.length === LENGTH && [...raw].every((c) => ALPHABET.includes(c)) ? raw : null;
}

export const hashCode = (normalized) => createHash("sha256").update(`shipdok-recovery:${normalized}`).digest("hex");

/** Replace the administrator's whole set with a fresh one (inside the caller's transaction). Returns the plain codes: this is the only time they exist. */
export async function replaceCodes(client, userId) {
  const codes = generateCodes();
  await client.query("DELETE FROM recovery_codes WHERE user_id = $1", [userId]);
  for (const code of codes) {
    await client.query("INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)", [userId, hashCode(normalizeCode(code))]);
  }
  return codes;
}

/** Spend a code. True only for the one request that finds it unused: the UPDATE decides, so two at once cannot both win. */
export async function spendCode(client, userId, typed) {
  const normalized = normalizeCode(typed);
  if (!normalized) return false;
  const { rowCount } = await client.query(
    "UPDATE recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL",
    [userId, hashCode(normalized)],
  );
  return rowCount === 1;
}

export async function recoveryStatus(db, userId) {
  const { rows } = await db.query(
    "SELECT count(*) FILTER (WHERE used_at IS NULL)::int AS remaining, max(created_at) AS created_at FROM recovery_codes WHERE user_id = $1",
    [userId],
  );
  return { remaining: rows[0].remaining, createdAt: rows[0].created_at };
}
