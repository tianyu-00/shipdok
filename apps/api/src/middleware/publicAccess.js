// Who may reach Shipdok from outside, decided in the application because Shipdok does not control the proxy in front of it.
//   local    outside visitors get nothing (a plain 404 for every path, the webhook included)
//   webhook  outside visitors may POST /api/webhooks/github and nothing else
//   full     everyone may use everything
// Visitors on the local network always get everything. The 404 is the same answer an unknown route gives, so nothing says Shipdok is here.
import { hostOf, visitorOf } from "../visitor.js";

export async function accessFor(req, settings) {
  const s = await settings.public();
  const visitor = visitorOf(req, hostOf(s.publicUrl));
  return { visitor, mode: s.mode };
}

export function publicAccess(settings) {
  return async (req, res, next) => {
    try {
      const { visitor, mode } = await accessFor(req, settings);
      if (visitor === "local" || mode === "full") return next();
      if (mode === "webhook" && req.method === "POST" && req.path === "/api/webhooks/github") return next();
      return res.status(404).json({ error: "Not found" });
    } catch (err) {
      next(err);
    }
  };
}

/**
 * For the dashboard's web server (nginx auth_request): may this visitor be served the dashboard's pages? 204 yes, 403 no.
 * The pages are served by nginx, not by this API, so nginx asks here first. Mounted before publicAccess on purpose.
 */
export function visitorCheck(settings) {
  return async (req, res, next) => {
    try {
      const { visitor, mode } = await accessFor(req, settings);
      res.status(visitor === "local" || mode === "full" ? 204 : 403).end();
    } catch (err) {
      next(err);
    }
  };
}
