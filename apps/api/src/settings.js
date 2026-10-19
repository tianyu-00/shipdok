// Settings kept in the database and edited in the dashboard. Right now: who may reach Shipdok from outside, and the
// public address. A value given in the environment (SHIPDOK_PUBLIC, PUBLIC_URL) wins and locks the field.
import { config } from "./config.js";
import { PUBLIC_MODES, normalizePublicUrl } from "./publicurl.js";

export { PUBLIC_MODES, normalizePublicUrl };

const MODE_KEY = "public_mode";
const URL_KEY = "public_url";

export function createSettings(db, { ttlMs = 5000 } = {}) {
  let cache = null;

  async function load() {
    if (cache && Date.now() - cache.at < ttlMs) return cache.rows;
    const { rows } = await db.query("SELECT key, value FROM settings WHERE key = ANY($1)", [[MODE_KEY, URL_KEY]]);
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    cache = { at: Date.now(), rows: map };
    return map;
  }

  return {
    /** The public-access settings as they apply now: the environment first, then the database, then the safe default. */
    async public() {
      let stored = {};
      try {
        stored = await load();
      } catch {
        // The database is unreachable: keep the last known values, or the most restrictive ones.
        stored = cache?.rows ?? {};
      }
      const modeLocked = Boolean(config.publicModeEnv);
      const urlLocked = Boolean(config.publicUrlEnv);
      const mode = config.publicModeEnv ?? (PUBLIC_MODES.includes(stored[MODE_KEY]) ? stored[MODE_KEY] : "local");
      const publicUrl = config.publicUrlEnv ?? (typeof stored[URL_KEY] === "string" ? stored[URL_KEY] : "");
      return { mode, publicUrl, modeLocked, urlLocked };
    },

    /** Save the fields that are given (already validated). */
    async setPublic({ mode, publicUrl }) {
      if (mode !== undefined) await db.query(`INSERT INTO settings (key, value) VALUES ($1, to_jsonb($2::text)) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [MODE_KEY, mode]);
      if (publicUrl !== undefined) await db.query(`INSERT INTO settings (key, value) VALUES ($1, to_jsonb($2::text)) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [URL_KEY, publicUrl]);
      cache = null;
    },

    invalidate() {
      cache = null;
    },
  };
}
