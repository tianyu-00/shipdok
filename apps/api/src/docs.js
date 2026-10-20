// The interactive API reference (Scalar) at /api/docs, for the signed-in administrator only. Everything comes from this server: the
// document (openapi/openapi.json, written by `npm run openapi`) and Scalar's own browser bundle from node_modules, so it works on a LAN
// with no internet. The page needs one inline script, which is allowed by a fresh nonce rather than by a general "unsafe-inline".
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { apiReference } from '@scalar/express-api-reference';

const SPEC = fileURLToPath(new URL('../openapi/openapi.json', import.meta.url));

// Scalar's browser bundle. In the Docker image it is a single file put there at build time (SCALAR_BUNDLE): the package it comes from pulls in
// about 200 MB of dependencies that the bundle does not need. In development it is taken from the package itself.
const bundlePath = () => process.env.SCALAR_BUNDLE || fileURLToPath(new URL('./browser/standalone.js', import.meta.resolve('@scalar/api-reference')));

/**
 * In front of requireAuth, for the reference PAGE only: a browser that is not signed in is sent to the dashboard's login (the route /api-docs,
 * which the dashboard serves, and which opens the reference once the administrator has signed in). Everything else (the document, the
 * script, a program asking for JSON) keeps the plain 401.
 */
export function docsGate(maxLifetimeMs) {
  return (req, res, next) => {
    const s = req.session;
    const signedIn = Boolean(s?.userId) && Date.now() - s.createdAt <= maxLifetimeMs;
    if (!signedIn && req.method === 'GET' && req.path === '/' && (req.get('accept') ?? '').includes('text/html')) return res.redirect(302, '/api-docs');
    next();
  };
}

export function docsRouter() {
  const r = Router();

  r.get('/', (req, res) => {
    const nonce = randomBytes(16).toString('base64');
    // Replaces the API's usual policy for this one page. Nothing but this origin; style-src allows inline styles because Scalar
    // injects some; no script runs without the nonce.
    res.set('Content-Security-Policy',
      `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
    res.set('Cache-Control', 'no-store');
    apiReference({
      url: '/api/docs/openapi.json',
      cdn: '/api/docs/scalar.js',
      nonce,
      pageTitle: 'Shipdok API',
      withDefaultFonts: false, // the default fonts come from the internet
      telemetry: false,
      // A self-hosted reference: none of Scalar's hosted-product menus (AI assistant, share, deploy, SDK generation).
      agent: { disabled: true },
      mcp: { disabled: true },
      showDeveloperTools: 'never',
      showToolbar: 'never',
    })(req, res);
  });

  r.get('/openapi.json', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.type('application/json').sendFile(SPEC, (err) => err && next(err));
  });

  r.get('/scalar.js', (req, res, next) => {
    res.type('application/javascript').set('Cache-Control', 'private, max-age=3600').sendFile(bundlePath(), (err) => err && next(err));
  });

  return r;
}
