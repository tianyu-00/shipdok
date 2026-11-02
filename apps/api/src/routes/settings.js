import { Router } from "express";
import { verify } from "@node-rs/argon2";
import { GithubError } from "@shipdok/shared";
import { limiter } from "../authutil.js";
import { PUBLIC_MODES, normalizePublicUrl } from "../publicurl.js";
import { accessFor } from "../middleware/publicAccess.js";
import { addressOf } from "../lockout.js";
import { change, recordAudit } from "../audit.js";

export function settingsRouter({ db, settings, provider }) {
  const r = Router();

  r.get("/public", async (req, res, next) => {
    try {
      const { visitor } = await accessFor(req, settings);
      res.json({ ...(await settings.public()), visitor });
    } catch (err) {
      next(err);
    }
  });

  // Change who may reach Shipdok from outside. This widens (or narrows) what a stranger can see, so the current password is
  // asked again, and the change is recorded in the sign-ins list. A setting that the environment fixes cannot be changed here.
  r.put("/public", limiter(10), async (req, res, next) => {
    try {
      const { password, mode, publicUrl } = req.body ?? {};
      if (typeof password !== "string") return res.status(400).json({ error: "Give your current password" });
      if (mode === undefined && publicUrl === undefined) return res.status(400).json({ error: "Nothing to change" });
      if (mode !== undefined && !PUBLIC_MODES.includes(mode)) return res.status(400).json({ error: `The mode must be one of: ${PUBLIC_MODES.join(", ")}` });
      let url;
      if (publicUrl !== undefined) {
        const parsed = normalizePublicUrl(publicUrl);
        if (!parsed.ok) return res.status(400).json({ error: parsed.error });
        url = parsed.value;
      }

      const { rows } = await db.query("SELECT id, username, password_hash FROM users WHERE id = $1", [req.session.userId]);
      if (!rows[0]) return res.status(401).json({ error: "Not authenticated" });
      let ok = false;
      try {
        ok = await verify(rows[0].password_hash, password);
      } catch {
        ok = false;
      }
      if (!ok) return res.status(403).json({ error: "The current password is not correct", code: "wrong_password" });

      const now = await settings.public();
      if ((mode !== undefined && now.modeLocked && mode !== now.mode) || (url !== undefined && now.urlLocked && url !== now.publicUrl)) {
        return res.status(409).json({ error: "That setting is fixed by the server's environment (SHIPDOK_PUBLIC or PUBLIC_URL) and cannot be changed here", code: "locked_by_environment" });
      }
      await settings.setPublic({ mode: now.modeLocked ? undefined : mode, publicUrl: now.urlLocked ? undefined : url });
      const after = await settings.public();
      const MODE_NAMES = { local: "Local only", webhook: "Webhook only", full: "Full" };
      const details = [];
      const parts = [];
      if (after.mode !== now.mode) {
        details.push(change("Who may reach Shipdok", MODE_NAMES[now.mode], MODE_NAMES[after.mode]));
        parts.push(`${MODE_NAMES[now.mode]} → ${MODE_NAMES[after.mode]}`);
      }
      if (after.publicUrl !== now.publicUrl) {
        details.push(change("Public address", now.publicUrl || "none", after.publicUrl || "none"));
        parts.push(after.publicUrl ? `address ${after.publicUrl}` : "address removed");
      }
      await recordAudit(db, {
        category: "security", action: "public_access", actor: rows[0].username, address: addressOf(req), details,
        summary: parts.length ? `Public access changed: ${parts.join(", ")}` : "Public access saved, nothing changed",
      });
      // A new public address means GitHub must be told where to send webhooks, for every connected GitHub App. Best effort: the setting is
      // saved either way, and the GitHub page can retry each app.
      let githubWebhook;
      if (after.publicUrl && after.publicUrl !== now.publicUrl) {
        const clients = await provider.clients().catch(() => []);
        const failed = [];
        let rejected = false;
        for (const c of clients) {
          try {
            await c.client.updateWebhookUrl(`${after.publicUrl}/api/webhooks/github`);
          } catch (err) {
            failed.push(c.name ?? 'a GitHub app');
            if (err instanceof GithubError && [401, 403, 404].includes(err.status)) rejected = true;
          }
        }
        if (clients.length) {
          githubWebhook = failed.length === 0
            ? { updated: true }
            : {
                updated: false,
                failed,
                error: rejected
                  ? `GitHub did not accept the new webhook address for ${failed.join(', ')}. Check the app on the GitHub page.`
                  : `Could not update the webhook address on GitHub for ${failed.join(', ')}. Try again on the GitHub page.`,
              };
        }
      }
      const { visitor } = await accessFor(req, settings);
      res.json({ ...after, visitor, ...(githubWebhook ? { githubWebhook } : {}) });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
