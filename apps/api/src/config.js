import "./loadsecrets.js"; // before anything reads the environment
import { parseMasterKey } from "@shipdok/shared";
import { parsePortRange } from "./ports.js";
import { PUBLIC_MODES, normalizePublicUrl } from "./publicurl.js";

// API settings from the environment. Call assertConfig() once at startup.
export const config = {
  host: process.env.API_HOST ?? "127.0.0.1", // loopback by default; widen deliberately
  port: Number(process.env.API_PORT ?? 4000),
  sessionSecret: process.env.SESSION_SECRET,
  // Optional: the dashboard accepts requests from the address it is opened at without this (see origin.js). Extra addresses, comma separated.
  webOrigins: (process.env.WEB_ORIGIN ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  setupToken: process.env.SETUP_TOKEN || null, // optional: required on first-run setup if set
  // "true"/"false" force it; anything else (compose's default, "auto") sets the Secure flag only on requests that came in over HTTPS
  // (as reported by a trusted proxy), so the same install works on plain http locally and behind an https proxy.
  // The interactive API reference at /api/docs (administrator only). On unless API_DOCS=false.
  apiDocs: process.env.API_DOCS !== "false",
  secureCookies: process.env.COOKIE_SECURE === "true" ? true : process.env.COOKIE_SECURE === "false" ? false : "auto",
  // Who may reach Shipdok from outside, and where: normally set in the dashboard. These environment settings override it.
  publicModeEnv: process.env.SHIPDOK_PUBLIC || null,
  publicUrlEnv: process.env.PUBLIC_URL || null,
  // Where automatically chosen host ports come from (a new app that is not given one). Checked at startup.
  portRangeText: process.env.PORT_RANGE || undefined,
  idleMs: 30 * 60 * 1000, // sliding inactivity timeout (spec: exact values open)
  maxLifetimeMs: 12 * 60 * 60 * 1000, // absolute session lifetime
};

// The master key for encrypting app secrets. Throws a clear error if missing or malformed.
export function loadSecretsKey() {
  return parseMasterKey(process.env.APP_SECRETS_KEY);
}

export function assertConfig() {
  if (config.publicModeEnv && !PUBLIC_MODES.includes(config.publicModeEnv)) {
    throw new Error(`SHIPDOK_PUBLIC must be one of: ${PUBLIC_MODES.join(", ")}`);
  }
  if (config.publicUrlEnv) {
    const parsed = normalizePublicUrl(config.publicUrlEnv);
    if (!parsed.ok || !parsed.value) throw new Error(`PUBLIC_URL is not usable: ${parsed.error ?? "empty"}`);
    config.publicUrlEnv = parsed.value;
  }
  if (!config.sessionSecret || config.sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be set to at least 32 characters (try: openssl rand -hex 32)");
  }
  loadSecretsKey();
  parsePortRange(config.portRangeText);
}
