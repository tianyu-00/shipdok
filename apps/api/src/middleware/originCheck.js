// CSRF defence in depth (alongside SameSite=Lax cookies and JSON-only bodies):
// browsers always send Origin on cross-origin state-changing requests, so reject any
// that does not come from the dashboard. Non-browser clients (curl) send no Origin.
// An Origin is accepted when it is the address the request arrived at (see origin.js), one of the optional WEB_ORIGIN addresses, or the
// public address (dashboard setting or PUBLIC_URL). Each only ADDS to the others, so a mistyped public address cannot lock the administrator out.
import { config } from "../config.js";
import { sameOrigin } from "../origin.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function originCheck(settings) {
  return async (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.get("origin");
    if (!origin || sameOrigin(req, origin) || config.webOrigins.includes(origin)) return next();
    try {
      const { publicUrl } = await settings.public();
      if (publicUrl && origin === publicUrl) return next();
    } catch {
      /* fall through to refusing */
    }
    return res.status(403).json({ error: "Origin not allowed" });
  };
}
