import { Router } from "express";
import { hash, verify } from "@node-rs/argon2"; // argon2id by default; prebuilt binaries (no compiling on the Pi)
import { timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { limiter, startSession } from "../authutil.js";
import { replaceCodes } from "../recovery.js";
import { passwordProblem } from "@shipdok/shared";
import { addressOf, cleanName, lockedFor, lockMessage, recordAttempt, withAttemptLock } from "../lockout.js";

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,64}$/;

// Verify against a dummy hash for unknown users so response time doesn't reveal who exists.
let dummyHash;
const getDummyHash = async () => (dummyHash ??= await hash("not-a-real-password"));

function validCredentials({ username, password }) {
  if (typeof username !== "string" || !USERNAME_RE.test(username)) {
    return "Username must be 3-64 characters: letters, numbers, dot, dash, underscore";
  }
  return passwordProblem(password, { username });
}

function tokenMatches(given) {
  if (!config.setupToken) return true;
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(config.setupToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authRouter(db) {
  const r = Router();

  r.get("/status", async (req, res, next) => {
    try {
      const { rows } = await db.query("SELECT EXISTS (SELECT 1 FROM users) AS has_admin");
      // setupTokenRequired lets the setup screen ask for the token (the token itself is never sent).
      res.json({ needsSetup: !rows[0].has_admin, authenticated: Boolean(req.session?.userId), setupTokenRequired: !rows[0].has_admin && Boolean(config.setupToken) });
    } catch (err) {
      next(err);
    }
  });

  // First-run setup. Atomicity comes from the unique index users_single_admin:
  // concurrent requests race on the INSERT and all but one get a unique violation.
  r.post("/setup", limiter(10), async (req, res, next) => {
    try {
      const { username, password, setupToken } = req.body ?? {};
      if (!tokenMatches(setupToken)) return res.status(403).json({ error: "Invalid setup token" });
      const problem = validCredentials({ username, password });
      if (problem) return res.status(400).json({ error: problem });

      const passwordHash = await hash(password);
      let userId;
      let recoveryCodes;
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query("INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id", [
          username,
          passwordHash,
        ]);
        userId = rows[0].id;
        recoveryCodes = await replaceCodes(client, userId);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        if (err.code === "23505") return res.status(409).json({ error: "Setup has already been completed" });
        throw err;
      } finally {
        client.release();
      }
      await startSession(req, userId);
      await recordAttempt(db, { kind: "setup", username: cleanName(username), address: addressOf(req), success: true });
      res.status(201).json({ username, recoveryCodes }); // the only time the codes are shown
    } catch (err) {
      next(err);
    }
  });

  // Failed tries are counted per name and per address; after a few, the next ones wait (see lockout.js). The outer
  // rate limit stays as a cheap first line.
  r.post("/login", limiter(10), async (req, res, next) => {
    try {
      const { username, password } = req.body ?? {};
      if (typeof username !== "string" || typeof password !== "string") {
        return res.status(400).json({ error: "Username and password required" });
      }
      const who = { username: cleanName(username), address: addressOf(req) };
      const outcome = await withAttemptLock(db, who, async (client) => {
        const wait = await lockedFor(client, who);
        if (wait > 0) return { wait };
        const { rows } = await client.query("SELECT id, password_hash FROM users WHERE username = $1", [username]);
        const user = rows[0];
        let ok = false;
        try {
          ok = await verify(user?.password_hash ?? (await getDummyHash()), password);
        } catch {
          ok = false;
        }
        await recordAttempt(client, { kind: "login", ...who, success: Boolean(user && ok) });
        return { userId: user && ok ? user.id : null };
      });
      if (outcome.wait) {
        res.set("Retry-After", String(outcome.wait));
        return res.status(429).json({ error: lockMessage(outcome.wait), code: "locked", retryAfterSeconds: outcome.wait });
      }
      if (!outcome.userId) return res.status(401).json({ error: "Invalid username or password" });

      await startSession(req, outcome.userId);
      res.json({ username });
    } catch (err) {
      next(err);
    }
  });

  r.post("/logout", (req, res, next) => {
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie("shipdok.sid");
      res.status(204).end();
    });
  });

  // Sign out every browser and device, this one included.
  r.post("/logout-all", requireAuth, async (req, res, next) => {
    try {
      await db.query(`DELETE FROM "session" WHERE sess->>'userId' = $1`, [String(req.session.userId)]);
      req.session.destroy((err) => {
        if (err) return next(err);
        res.clearCookie("shipdok.sid");
        res.status(204).end();
      });
    } catch (err) {
      next(err);
    }
  });

  // The latest sign-in attempts, good and bad (names typed by strangers included), newest first.
  r.get("/logins", requireAuth, async (req, res, next) => {
    try {
      const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
      const { rows } = await db.query(
        "SELECT at, kind, username, address, success FROM login_attempts ORDER BY at DESC, id DESC LIMIT $1",
        [limit],
      );
      res.json({ logins: rows });
    } catch (err) {
      next(err);
    }
  });

  // Change the administrator's password. The current one must be given again (a stolen session alone must not be enough).
  // Every other session ends; this one gets a fresh id. A wrong current password is a 403, not a 401: a 401 means "your
  // session ended" to the dashboard.
  r.post("/password", requireAuth, limiter(10), async (req, res, next) => {
    try {
      const { currentPassword, newPassword } = req.body ?? {};
      if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
        return res.status(400).json({ error: "Give the current password and a new one" });
      }
      const { rows: who } = await db.query("SELECT username FROM users WHERE id = $1", [req.session.userId]);
      const weak = passwordProblem(newPassword, { username: who[0]?.username });
      if (weak) return res.status(400).json({ error: weak, code: "weak_password" });
      if (newPassword === currentPassword) return res.status(400).json({ error: "The new password must be different from the current one" });

      const { rows } = await db.query("SELECT id, password_hash FROM users WHERE id = $1", [req.session.userId]);
      if (!rows[0]) return res.status(401).json({ error: "Not authenticated" });
      let ok = false;
      try {
        ok = await verify(rows[0].password_hash, currentPassword);
      } catch {
        ok = false;
      }
      if (!ok) return res.status(403).json({ error: "The current password is not correct", code: "wrong_password" });

      await db.query("UPDATE users SET password_hash = $2 WHERE id = $1", [rows[0].id, await hash(newPassword)]);
      await db.query(`DELETE FROM "session" WHERE sess->>'userId' = $1`, [String(rows[0].id)]); // all of them, this one included
      await startSession(req, rows[0].id); // ... and this one comes back with a new id
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  r.get("/me", requireAuth, async (req, res, next) => {
    try {
      const { rows } = await db.query("SELECT username FROM users WHERE id = $1", [req.session.userId]);
      if (!rows[0]) return res.status(401).json({ error: "Not authenticated" });
      res.json({ username: rows[0].username });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
