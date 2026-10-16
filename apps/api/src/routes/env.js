// Environment variables for an app. Values are encrypted at rest (AES-256-GCM, bound to app + name)
// and are NEVER returned by any route except the explicit reveal endpoint.
import { Router } from "express";
import {
  encryptSecret,
  decryptSecret,
  envVarContext,
  parseEnvText,
  ENV_KEY_RE,
  MAX_ENV_VARS,
  MAX_ENV_VALUE_BYTES,
  isReservedEnvName,
} from "@shipdok/shared";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MASK = "********"; // fixed placeholder: reveals nothing, not even the value's length

class ClientError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

async function withTx(db, fn) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function keyProblem(key) {
  if (!ENV_KEY_RE.test(key))
    return "Variable names use letters, digits and underscore, must not start with a digit, and are at most 128 characters";
  if (isReservedEnvName(key)) return `"${key}" is reserved and cannot be set`;
  return null;
}

function valueProblem(value) {
  if (typeof value !== "string") return "value must be a string";
  if (value.includes("\0")) return "Value contains a null character";
  if (Buffer.byteLength(value, "utf8") > MAX_ENV_VALUE_BYTES)
    return `Value is larger than ${MAX_ENV_VALUE_BYTES / 1024} KB`;
  return null;
}

// What differs between the variables saved now and those the last successful deployment used.
async function pendingChanges(db, appId, rows) {
  const { rows: dep } = await db.query(
    `SELECT config_snapshot->'env' AS env FROM deployments
     WHERE app_id = $1 AND status = 'successful'
     ORDER BY finished_at DESC NULLS LAST, queued_at DESC LIMIT 1`,
    [appId],
  );
  if (!dep[0]) return { deployed: false, pending: false, added: [], changed: [], removed: [] };

  const baseline = dep[0].env ?? {}; // deployments from before this feature used no variables
  const current = Object.fromEntries(rows.map((r) => [r.key, r.version]));
  const added = Object.keys(current)
    .filter((k) => !(k in baseline))
    .sort();
  const removed = Object.keys(baseline)
    .filter((k) => !(k in current))
    .sort();
  const changed = Object.keys(current)
    .filter((k) => k in baseline && baseline[k] !== current[k])
    .sort();
  return {
    deployed: true,
    pending: Boolean(added.length || removed.length || changed.length),
    added,
    changed,
    removed,
  };
}

const UPSERT = `
  INSERT INTO app_env_vars (app_id, key, value_encrypted) VALUES ($1, $2, $3)
  ON CONFLICT (app_id, key) DO UPDATE
    SET value_encrypted = EXCLUDED.value_encrypted,
        version = nextval('app_env_var_version_seq'),
        updated_at = now()
  RETURNING (xmax = 0) AS created, updated_at`;

export function envRouter({ db, secretsKey }) {
  const r = Router({ mergeParams: true });
  const handle = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof ClientError) return res.status(err.status).json({ error: err.message, ...err.extra });
      next(err);
    }
  };

  // Every route below needs an existing app.
  r.use(async (req, res, next) => {
    try {
      const id = req.params.id;
      const ok = UUID_RE.test(id) && (await db.query("SELECT 1 FROM apps WHERE id = $1", [id])).rowCount === 1;
      if (!ok) return res.status(404).json({ error: "App not found" });
      req.appId = id;
      next();
    } catch (err) {
      next(err);
    }
  });

  r.get(
    "/",
    handle(async (req, res) => {
      const { rows } = await db.query(
        "SELECT key, version::text AS version, updated_at FROM app_env_vars WHERE app_id = $1 ORDER BY key",
        [req.appId],
      );
      res.json({
        variables: rows.map((v) => ({ key: v.key, value: MASK, updated_at: v.updated_at })),
        pending: await pendingChanges(db, req.appId, rows),
      });
    }),
  );

  // Bulk import from .env text. All or nothing: any problem means nothing is saved.
  r.post(
    "/import",
    handle(async (req, res) => {
      const content = req.body?.content;
      if (typeof content !== "string") throw new ClientError(400, "content must be the text of a .env file");

      const { vars, problems, duplicates } = parseEnvText(content);
      for (const v of vars) {
        const p = keyProblem(v.key) ?? valueProblem(v.value);
        if (p) problems.push({ line: v.line, message: p });
      }
      problems.sort((a, b) => a.line - b.line);
      if (problems.length) {
        throw new ClientError(400, "Import failed; nothing was saved", {
          problems: problems.slice(0, 50),
          total_problems: problems.length,
        });
      }
      if (!vars.length) throw new ClientError(400, "No variables found in the file");

      const result = await withTx(db, async (c) => {
        await c.query("SELECT id FROM apps WHERE id = $1 FOR UPDATE", [req.appId]); // serialise concurrent edits
        const existing = new Set(
          (await c.query("SELECT key FROM app_env_vars WHERE app_id = $1", [req.appId])).rows.map((x) => x.key),
        );
        const total = existing.size + vars.filter((v) => !existing.has(v.key)).length;
        if (total > MAX_ENV_VARS)
          throw new ClientError(
            400,
            `An app can have at most ${MAX_ENV_VARS} variables; this import would make ${total}`,
          );

        let created = 0;
        let updated = 0;
        for (const v of vars) {
          const token = encryptSecret(v.value, secretsKey, envVarContext(req.appId, v.key));
          const { rows } = await c.query(UPSERT, [req.appId, v.key, token]);
          if (rows[0].created) created++;
          else updated++;
        }
        return { created, updated };
      });
      res.json({ ...result, keys: vars.map((v) => v.key), duplicates });
    }),
  );

  r.put(
    "/:key",
    handle(async (req, res) => {
      const { key } = req.params;
      const value = req.body?.value;
      const problem = keyProblem(key) ?? valueProblem(value);
      if (problem) throw new ClientError(400, problem);

      const out = await withTx(db, async (c) => {
        await c.query("SELECT id FROM apps WHERE id = $1 FOR UPDATE", [req.appId]);
        const exists =
          (await c.query("SELECT 1 FROM app_env_vars WHERE app_id = $1 AND key = $2", [req.appId, key])).rowCount === 1;
        if (!exists) {
          const n = (await c.query("SELECT count(*)::int AS n FROM app_env_vars WHERE app_id = $1", [req.appId]))
            .rows[0].n;
          if (n >= MAX_ENV_VARS) throw new ClientError(400, `An app can have at most ${MAX_ENV_VARS} variables`);
        }
        const token = encryptSecret(value, secretsKey, envVarContext(req.appId, key));
        return (await c.query(UPSERT, [req.appId, key, token])).rows[0];
      });
      res.status(out.created ? 201 : 200).json({ key, created: out.created, updated_at: out.updated_at });
    }),
  );

  r.delete(
    "/:key",
    handle(async (req, res) => {
      const { key } = req.params;
      const gone =
        ENV_KEY_RE.test(key) &&
        (await db.query("DELETE FROM app_env_vars WHERE app_id = $1 AND key = $2", [req.appId, key])).rowCount === 1;
      if (!gone) throw new ClientError(404, "Variable not found");
      res.status(204).end();
    }),
  );

  // The only place a value leaves the server. POST (not GET) so it is never prefetched or cached,
  // and so it passes the same origin check as every other state-changing route.
  r.post(
    "/:key/reveal",
    handle(async (req, res) => {
      const { key } = req.params;
      const row = ENV_KEY_RE.test(key)
        ? (await db.query("SELECT value_encrypted FROM app_env_vars WHERE app_id = $1 AND key = $2", [req.appId, key]))
            .rows[0]
        : null;
      if (!row) throw new ClientError(404, "Variable not found");

      let value;
      try {
        value = decryptSecret(row.value_encrypted, secretsKey, envVarContext(req.appId, key));
      } catch {
        console.error("Reveal failed: a stored variable could not be decrypted"); // no key name, no value
        throw new ClientError(500, "Could not decrypt this value. Has APP_SECRETS_KEY changed?");
      }
      res.set("Cache-Control", "no-store");
      res.json({ key, value });
    }),
  );

  return r;
}
