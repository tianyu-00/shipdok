// CSRF defence in depth (alongside SameSite=Lax cookies and JSON-only bodies):
// browsers always send Origin on cross-origin state-changing requests, so reject any
// that does not come from the dashboard. Non-browser clients (curl) send no Origin.
import { config } from "../config.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function originCheck(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.get("origin");
  if (origin && !config.webOrigins.includes(origin)) {
    return res.status(403).json({ error: "Origin not allowed" });
  }
  next();
}
