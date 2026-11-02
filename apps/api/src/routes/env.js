// Environment variables for an app. Values are encrypted at rest (AES-256-GCM, bound to app + name)
// and are NEVER returned by any route except the explicit reveal endpoint.
import { Router } from "express";
import { change, fact, recordAuditFor } from "../audit.js";
import {
  encryptSecret,
  decryptSecret,
  envVarContext,
  parseEnvText,
  ENV_KEY_RE,
  MAX_ENV_VARS,
  MAX_ENV_VALUE_BYTES,
  isReservedEnvName,
  isReservedBuildName,
  reachesBuild,
  ENV_SCOPES,
  BUILD_PASSES,
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

// A variable that reaches the build is handed to `docker build` through the command's environment, so some names are not allowed there.
function scopeProblem(key, scope) {
  if (!ENV_SCOPES.includes(scope)) return `scope must be one of: ${ENV_SCOPES.join(", ")}`;
  if (reachesBuild(scope) && isReservedBuildName(key)) return `"${key}" cannot be used at build time (it changes how the build runs). Use another name, or keep it runtime-only`;
  return null;
}

function buildAsProblem(buildAs) {
  return BUILD_PASSES.includes(buildAs) ? null : `buildAs must be one of: ${BUILD_PASSES.join(", ")}`;
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

// $4 is the scope and $5 how a build variable is passed, or null: a new variable then starts as 'runtime' / 'arg' and an existing one
// keeps what it has (an import never changes either).
const UPSERT = `
  INSERT INTO app_env_vars (app_id, key, value_encrypted, scope, build_as) VALUES ($1, $2, $3, COALESCE($4, 'runtime'), COALESCE($5, 'arg'))
  ON CONFLICT (app_id, key) DO UPDATE
    SET value_encrypted = EXCLUDED.value_encrypted,
        scope = COALESCE($4, app_env_vars.scope),
        build_as = COALESCE($5, app_env_vars.build_as),
        version = nextval('app_env_var_version_seq'),
        updated_at = now()
  RETURNING (xmax = 0) AS created, updated_at, scope, build_as`;

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

  // An entry of the activity log about a variable: its name and where it is used, NEVER a value.
  const logVariable = (req, summary, action, details) =>
    recordAuditFor(db, req, { category: "variables", action, summary, appId: req.appId, appName: req.appName, details: [fact("App", req.appName), ...details] });

  // Every route below needs an existing app.
  r.use(async (req, res, next) => {
    try {
      const id = req.params.id;
      const found = UUID_RE.test(id) ? (await db.query("SELECT name FROM apps WHERE id = $1", [id])).rows[0] : null;
      if (!found) return res.status(404).json({ error: "App not found" });
      req.appId = id;
      req.appName = found.name;
      next();
    } catch (err) {
      next(err);
    }
  });

  r.get(
    "/",
    handle(async (req, res) => {
      const { rows } = await db.query(
        "SELECT key, scope, build_as, version::text AS version, updated_at FROM app_env_vars WHERE app_id = $1 ORDER BY key",
        [req.appId],
      );
      res.json({
        variables: rows.map((v) => ({ key: v.key, value: MASK, scope: v.scope, build_as: v.build_as, updated_at: v.updated_at })),
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
          const { rows } = await c.query(UPSERT, [req.appId, v.key, token, null, null]);
          if (rows[0].created) created++;
          else updated++;
        }
        return { created, updated };
      });
      await logVariable(req, `Variables imported into ${req.appName}: ${result.created} added, ${result.updated} changed`, "var_imported", [
        fact("Added", result.created), fact("Changed (an existing name)", result.updated), fact("Names", vars.map((v) => v.key).join(", ")), fact("Values", "never recorded"),
      ]);
      res.json({ ...result, keys: vars.map((v) => v.key), duplicates });
    }),
  );

  // { value?, scope?, buildAs?, newKey? }. A value alone keeps the scope (a new variable starts as runtime-only) and how it is passed to the
  // build; a scope or `buildAs` alone changes an existing variable and keeps its value (which is never sent back to the browser); `newKey` renames an existing variable.
  // The name is part of what the value is encrypted for, so a rename decrypts and encrypts again here, on the server, in the same
  // transaction as everything else the request changes: either all of it happens or none of it.
  r.put(
    "/:key",
    handle(async (req, res) => {
      const { key } = req.params;
      const { value, scope, buildAs } = req.body ?? {};
      const target = req.body?.newKey === undefined || req.body.newKey === key ? key : req.body.newKey;
      const renaming = target !== key;
      if (value === undefined && scope === undefined && buildAs === undefined && !renaming) throw new ClientError(400, "value must be a string");
      const problem =
        keyProblem(key) ??
        (renaming && typeof target !== "string" ? "newKey must be a string" : null) ??
        (renaming ? keyProblem(target) : null) ??
        (value === undefined ? null : valueProblem(value)) ??
        (scope === undefined ? null : scopeProblem(target, scope)) ??
        (buildAs === undefined ? null : buildAsProblem(buildAs));
      if (problem) throw new ClientError(400, problem);

      let out;
      try {
        out = await withTx(db, async (c) => {
          await c.query("SELECT id FROM apps WHERE id = $1 FOR UPDATE", [req.appId]);
          const current = (await c.query("SELECT scope, build_as, value_encrypted, updated_at FROM app_env_vars WHERE app_id = $1 AND key = $2", [req.appId, key])).rows[0];

          if (renaming || value === undefined) {
            // Changing only the scope or how it is passed, or renaming (with or without a new value): the variable must exist.
            if (!current) throw new ClientError(404, "Variable not found");
            const newScope = scope ?? current.scope;
            const newBuildAs = buildAs ?? current.build_as;
            if (renaming) {
              if (reachesBuild(newScope) && isReservedBuildName(target)) throw new ClientError(400, scopeProblem(target, newScope));
              let plain = value;
              if (plain === undefined) {
                try {
                  plain = decryptSecret(current.value_encrypted, secretsKey, envVarContext(req.appId, key));
                } catch {
                  console.error("Rename failed: a stored variable could not be decrypted"); // no key name, no value
                  throw new ClientError(500, "Could not decrypt this value, so it cannot be renamed. Has APP_SECRETS_KEY changed? Set a new value to rename it.");
                }
              }
              const token = encryptSecret(plain, secretsKey, envVarContext(req.appId, target));
              const { rows } = await c.query(
                `UPDATE app_env_vars SET key = $3, value_encrypted = $4, scope = $5, build_as = $6, version = nextval('app_env_var_version_seq'), updated_at = now()
                  WHERE app_id = $1 AND key = $2 RETURNING updated_at, scope, build_as`,
                [req.appId, key, target, token, newScope, newBuildAs],
              );
              return { created: false, renamed: true, before: current, ...rows[0] };
            }
            if (current.scope === newScope && current.build_as === newBuildAs) return { created: false, unchanged: true, scope: newScope, build_as: newBuildAs, updated_at: current.updated_at };
            // Only the scope or how it is passed changes. A name that is allowed for the new scope was checked above.
            const { rows } = await c.query(
              `UPDATE app_env_vars SET scope = $3, build_as = $4, version = nextval('app_env_var_version_seq'), updated_at = now()
                WHERE app_id = $1 AND key = $2 RETURNING updated_at, scope, build_as`,
              [req.appId, key, newScope, newBuildAs],
            );
            return { created: false, before: current, ...rows[0] };
          }

          if (!current) {
            const n = (await c.query("SELECT count(*)::int AS n FROM app_env_vars WHERE app_id = $1", [req.appId])).rows[0].n;
            if (n >= MAX_ENV_VARS) throw new ClientError(400, `An app can have at most ${MAX_ENV_VARS} variables`);
          }
          const token = encryptSecret(value, secretsKey, envVarContext(req.appId, key));
          return { before: current ?? null, ...(await c.query(UPSERT, [req.appId, key, token, scope ?? null, buildAs ?? null])).rows[0] };
        });
      } catch (err) {
        // A name another variable already has (or two requests racing for the same new name): the primary key lets exactly one in.
        if (err?.code === "23505" && renaming) throw new ClientError(409, `A variable named ${target} already exists`, { code: "name_taken" });
        throw err;
      }
      const how = [
        ...(out.before && out.before.scope !== out.scope ? [change("Available in", out.before.scope, out.scope)] : []),
        ...(out.before && out.before.build_as !== out.build_as ? [change("Passed to the build as", out.before.build_as, out.build_as)] : []),
      ];
      if (out.renamed) {
        await logVariable(req, `Variable renamed in ${req.appName}: ${key} → ${target}`, "var_renamed", [change("Name", key, target), ...how, ...(value !== undefined ? [fact("Value", "changed (never recorded)")] : [])]);
      } else if (out.created) {
        await logVariable(req, `Variable added to ${req.appName}: ${target}`, "var_added", [fact("Name", target), fact("Available in", out.scope), ...(reachesBuild(out.scope) ? [fact("Passed to the build as", out.build_as)] : []), fact("Value", "never recorded")]);
      } else if (value !== undefined) {
        await logVariable(req, `Variable value changed in ${req.appName}: ${key}`, "var_changed", [fact("Name", key), fact("Value", "changed (never recorded)"), ...how]);
      } else if (!out.unchanged) {
        await logVariable(req, `Variable settings changed in ${req.appName}: ${key}`, "var_changed", [fact("Name", key), ...how]);
      }
      res.status(out.created ? 201 : 200).json({
        key: target,
        created: out.created,
        ...(out.renamed ? { previous_key: key } : {}),
        scope: out.scope,
        build_as: out.build_as,
        ...(out.updated_at ? { updated_at: out.updated_at } : {}),
      });
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
      await logVariable(req, `Variable deleted from ${req.appName}: ${key}`, "var_deleted", [fact("Name", key)]);
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
      await logVariable(req, `Variable value shown: ${key} of ${req.appName}`, "var_revealed", [fact("Name", key), fact("Value", "shown in the dashboard (never recorded here)")]);
      res.set("Cache-Control", "no-store");
      res.json({ key, value });
    }),
  );

  return r;
}
