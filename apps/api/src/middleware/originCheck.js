// CSRF defence in depth (alongside SameSite=Lax cookies and JSON-only bodies):
// browsers always send Origin on cross-origin state-changing requests, so reject any
// that does not come from the dashboard. Non-browser clients (curl) send no Origin.
// The dashboard's own origins come from WEB_ORIGIN; the public address (dashboard setting or PUBLIC_URL) is added to them
// and never replaces them, so a mistyped public address cannot lock the administrator out.
import { config } from "../config.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function originCheck(settings) {
  return async (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.get("origin");
    if (!origin || config.webOrigins.includes(origin)) return next();
    try {
      const { publicUrl } = await settings.public();
      if (publicUrl && origin === publicUrl) return next();
    } catch {
      /* fall through to refusing */
    }
    return res.status(403).json({ error: "Origin not allowed" });
  };
}
