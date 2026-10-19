// Which Origin may make state-changing requests (the CSRF defence in depth).
//
// An Origin is accepted when it is
//   - the address the request itself arrived at (scheme + host + port, as the browser sees it): a page served by this very dashboard,
//   - one of the addresses in WEB_ORIGIN (optional now), or
//   - the public address.
// Nothing has to be configured for the first: it works at whatever address the dashboard is opened, which is what a self-hosted tool on
// a LAN, behind a proxy, or on a Pi needs. A page on another site always has a different Origin than the Host it is talking to.

/** Is `origin` exactly the address this request was sent to? `req.protocol` and `req.host` already honour a TRUSTED proxy's headers. */
export function sameOrigin(req, origin) {
  if (typeof origin !== "string" || !origin || typeof req.host !== "string" || !req.host) return false;
  const own = `${String(req.protocol).toLowerCase()}://${req.host.toLowerCase()}`;
  return origin.toLowerCase() === own;
}
