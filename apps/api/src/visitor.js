// Is this request from the local network, or from outside? Shipdok does not control the administrator's proxy, so it
// decides this itself, and decides it so that a mistake fails CLOSED: a visitor counts as local only when that can be
// shown. Anything else (a public address, a proxy we do not trust, a proxy that did not say who the visitor is) is outside.
import { isIP } from "node:net";

/** An address as plain text: IPv4-in-IPv6 unwrapped, any zone ("%eth0") dropped. */
export function normalizeAddress(address) {
  if (typeof address !== "string") return "";
  const a = address.trim().replace(/%.*$/, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  return mapped ? mapped[1] : a;
}

/** Loopback, private, link-local and shared (VPN, e.g. Tailscale) ranges. False for anything else, and for anything that is not an address. */
export function isPrivateAddress(address) {
  const a = normalizeAddress(address);
  const kind = isIP(a);
  if (kind === 4) {
    const [p, q] = a.split(".").map(Number);
    return p === 127 || p === 10 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 169 && q === 254) || (p === 100 && q >= 64 && q <= 127);
  }
  if (kind === 6) {
    const lower = a.toLowerCase();
    return lower === "::1" || /^f[cd][0-9a-f]{2}:/.test(lower) || /^fe[89ab][0-9a-f]:/.test(lower);
  }
  return false;
}

/** The host name out of a Host header or a URL: lower case, no port, no brackets. */
export function hostOf(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  let v = value.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "");
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(v);
  if (bracket) return bracket[1];
  v = v.replace(/:\d+$/, "");
  return v;
}

/**
 * @param {object} r
 * @param {string} r.socket            the address that actually connected (the proxy, if there is one)
 * @param {boolean} r.hasForwardedHeaders any header that says a proxy is in the middle
 * @param {boolean} r.hasForwardedFor  X-Forwarded-For is present (the one place a client address is taken from)
 * @param {boolean} [r.clientVouched] a proxy really supplied the client address (the dashboard's web server marks requests that
 *                                     arrived WITHOUT X-Forwarded-For, to which it adds one of its own); defaults to hasForwardedFor
 * @param {boolean} r.socketTrusted    the connecting address is one we believe about forwarded headers (TRUST_PROXY)
 * @param {string} r.clientIp          who Express says the client is (the forwarded address when the proxy is trusted)
 * @param {string[]} r.hosts           the Host and X-Forwarded-Host headers
 * @param {string} r.publicHost        host name of the public address, or ""
 * @returns {"local"|"outside"}
 */
export function classifyVisitor({ socket, hasForwardedHeaders, hasForwardedFor, clientVouched = hasForwardedFor, socketTrusted, clientIp, hosts, publicHost }) {
  if (!isPrivateAddress(socket)) return "outside"; // straight from the internet, or an address we cannot place
  let proven = false; // did a trusted proxy tell us who the client is?
  if (hasForwardedHeaders) {
    if (!socketTrusted || !hasForwardedFor) return "outside";
    if (!isPrivateAddress(clientIp)) return "outside";
    proven = clientVouched;
  }
  // Someone who used the public name must have been vouched for by the proxy: a connection that merely arrives from a
  // private address (a proxy that forgot to say who is behind it) proves nothing.
  if (publicHost && hosts.some((h) => hostOf(h) === publicHost) && !proven) return "outside";
  return "local";
}

const FORWARDED_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip", "cf-connecting-ip", "true-client-ip", "x-forwarded-host"];

/** Classify an Express request (needs the app's `trust proxy` setting). */
export function visitorOf(req, publicHost) {
  const socket = normalizeAddress(req.socket?.remoteAddress);
  const trustFn = req.app.get("trust proxy fn");
  return classifyVisitor({
    socket,
    hasForwardedHeaders: FORWARDED_HEADERS.some((h) => req.headers[h] !== undefined),
    hasForwardedFor: req.headers["x-forwarded-for"] !== undefined,
    // The dashboard's web server always sets X-Forwarded-For; it says with X-Shipdok-Proxied whether the visitor's own request had one.
    clientVouched: req.headers["x-forwarded-for"] !== undefined && req.headers["x-shipdok-proxied"] !== "0",
    socketTrusted: Boolean(socket) && trustFn(socket, 0),
    clientIp: normalizeAddress(req.ip),
    hosts: [req.headers.host, req.headers["x-forwarded-host"]].filter((h) => typeof h === "string"),
    publicHost,
  });
}
