import { Router } from "express";
import { hash, verify } from "@node-rs/argon2";
import { passwordProblem } from "@shipdok/shared";
import { requireAuth } from "../middleware/requireAuth.js";
import { limiter, startSession } from "../authutil.js";
import { addressOf, cleanName, lockedFor, lockMessage, recordAttempt, withAttemptLock } from "../lockout.js";
import { recoveryStatus, replaceCodes, spendCode } from "../recovery.js";
import { fact, recordAuditFor } from "../audit.js";

export function recoveryRouter(db) {
  const r = Router();

  // How many codes are left. Never the codes themselves: they exist in the clear only at the moment they are made.
  r.get("/recovery", requireAuth, async (req, res, next) => {
    try {
      res.json(await recoveryStatus(db, req.session.userId));
    } catch (err) {
      next(err);
    }
  });

  // Make a new set of ten. The old set stops working. The current password is asked again: a stolen session alone must
  // not be able to mint codes that outlive it.
  r.post("/recovery", requireAuth, limiter(10), async (req, res, next) => {
    try {
      const { password } = req.body ?? {};
      if (typeof password !== "string") return res.status(400).json({ error: "Give your current password" });
      const { rows } = await db.query("SELECT id, password_hash FROM users WHERE id = $1", [req.session.userId]);
      if (!rows[0]) return res.status(401).json({ error: "Not authenticated" });
      let ok = false;
      try {
        ok = await verify(rows[0].password_hash, password);
      } catch {
        ok = false;
      }
      if (!ok) return res.status(403).json({ error: "The current password is not correct", code: "wrong_password" });

      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const codes = await replaceCodes(client, rows[0].id);
        await client.query("COMMIT");
        await recordAuditFor(db, req, {
          category: "security", action: "recovery_codes_new", summary: "New recovery codes made",
          details: [fact("Effect", "the old set stops working; ten new codes were shown once"), fact("Codes", "never recorded")],
        });
        res.json({ codes });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  });

  // Lost the password: a recovery code and a new password. Spending a code signs every other session out and signs this
  // browser in. Tries are held back like logins (same counters, same wait). A weak new password is refused BEFORE the
  // code is looked at, so that answer says nothing about the code and does not use it up.
  r.post("/recover", limiter(10), async (req, res, next) => {
    try {
      const { username, code, newPassword } = req.body ?? {};
      if (typeof username !== "string" || typeof code !== "string" || typeof newPassword !== "string") {
        return res.status(400).json({ error: "Give the username, a recovery code and a new password" });
      }
      const weak = passwordProblem(newPassword, { username });
      if (weak) return res.status(400).json({ error: weak, code: "weak_password" });

      const who = { username: cleanName(username), address: addressOf(req) };
      const outcome = await withAttemptLock(db, who, async (client) => {
        const wait = await lockedFor(client, who);
        if (wait > 0) return { wait };
        const { rows } = await client.query("SELECT id FROM users WHERE username = $1", [username]);
        const user = rows[0];
        const ok = user ? await spendCode(client, user.id, code) : false;
        if (ok) {
          await client.query("UPDATE users SET password_hash = $2 WHERE id = $1", [user.id, await hash(newPassword)]);
          await client.query(`DELETE FROM "session" WHERE sess->>'userId' = $1`, [String(user.id)]);
        }
        await recordAttempt(client, { kind: "recovery", ...who, success: ok });
        return { userId: ok ? user.id : null };
      });
      if (outcome.wait) {
        res.set("Retry-After", String(outcome.wait));
        return res.status(429).json({ error: lockMessage(outcome.wait), code: "locked", retryAfterSeconds: outcome.wait });
      }
      if (!outcome.userId) return res.status(401).json({ error: "Invalid username or recovery code" });

      await startSession(req, outcome.userId);
      res.json({ username });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
