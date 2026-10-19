// Pure helpers for the public-access settings (no database, no config), so config.js can use them without a cycle.

export const PUBLIC_MODES = ["local", "webhook", "full"];

/** The address as an origin (scheme://host[:port]), lower case, no trailing slash. "" means none. */
export function normalizePublicUrl(input) {
  if (input === "") return { ok: true, value: "" };
  if (typeof input !== "string" || input.length > 255) return { ok: false, error: "Enter the address like https://shipdok.example.com" };
  const text = input.trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: "Enter the address like https://shipdok.example.com" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "The address must start with https:// (or http://)" };
  if (!url.hostname || /\s/.test(text)) return { ok: false, error: "The address has no host name" };
  if (url.username || url.password) return { ok: false, error: "Leave out the user name and password" };
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash || /^[a-z]+:\/\/[^/]*[/?#]./i.test(text)) {
    return { ok: false, error: "Give only the address, without a path (for example https://shipdok.example.com)" };
  }
  return { ok: true, value: url.origin };
}
