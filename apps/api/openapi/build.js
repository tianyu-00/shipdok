// Puts the OpenAPI document together from the operation descriptions in operations/ and the shapes in schemas.js, and compares it
// with the routes the API really has (inventory.js). A route without a description, or a description without a route, is an error.
import auth from './operations/auth.js';
import apps from './operations/apps.js';
import more from './operations/more.js';
import audit from './operations/audit.js';
import { schemas } from './schemas.js';

export const operations = { ...auth, ...apps, ...more, ...audit };

const TAGS = [
  ['Account', 'Signing in, the administrator\'s password, recovery codes and the sign-in history.'],
  ['Apps', 'Creating, editing, starting, stopping and deleting apps.'],
  ['Deployments', 'Building and releasing a version, cancelling, rolling back, and the history.'],
  ['Images and clean-up', 'The Docker images kept for rollback and how they are cleaned up.'],
  ['Persistent storage', 'Docker volumes that keep an app\'s files across deployments, and the ones kept without being mounted.'],
  ['Variables', 'An app\'s environment variables, encrypted at rest. Values are never returned except by `reveal`.'],
  ['GitHub', 'The connected GitHub App: connecting it, repositories, installations and the webhook address.'],
  ['Settings', 'Who may reach Shipdok from outside.'],
  ['Logs and storage', 'Build logs, an app\'s own output, and disk usage.'],
  ['Webhooks', 'GitHub\'s push webhook and its delivery history.'],
  ['System', 'Health checks and internals.'],
];

const DESCRIPTION = `The API behind the Shipdok dashboard. Everything the dashboard does goes through it.

**Signing in.** Sign in with \`POST /api/auth/login\`; the answer sets the cookie \`shipdok.sid\`, which every other call needs (except the ones marked as open). Sessions end after 30 minutes without activity, or 12 hours in all.

**State-changing calls and the \`Origin\` header.** A browser sends \`Origin\` itself and it must be one of Shipdok's own addresses (the address the dashboard is opened at, or the configured public address). A call with no \`Origin\` header at all (for example \`curl\`) is accepted, so scripts only need the cookie.

**Who can reach it.** Visitors from outside the local network get a plain \`404 {"error":"Not found"}\` for everything in \`local\` mode, and for everything except \`POST /api/webhooks/github\` in \`webhook\` mode (see the Security page's Public access).

**Errors** are JSON: \`{"error": "a sentence"}\`, with \`code\` (a short stable code) and \`details\` where there are any.

**Asynchronous work.** Deploying, rolling back, starting, stopping, restarting, cleaning up and deleting are queued for the worker and answer **202**; follow the result in the app's \`runtime\`, the deployment's \`status\` or \`GET /api/apps/{id}\`.`;

export function buildSpec() {
  const paths = {};
  for (const key of Object.keys(operations).sort()) {
    const [method, path] = key.split(' ');
    (paths[path] ??= {})[method.toLowerCase()] = operations[key];
  }
  return {
    openapi: '3.0.3',
    info: { title: 'Shipdok API', version: '1.0.0', description: DESCRIPTION, license: { name: 'MIT', url: 'https://opensource.org/licenses/MIT' } },
    tags: TAGS.map(([name, description]) => ({ name, description })),
    paths,
    components: {
      securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'shipdok.sid', description: 'The administrator\'s session cookie, set by `POST /api/auth/login`.' } },
      schemas,
    },
  };
}

/** Compare the described operations with the real routes. */
export function compare(routes) {
  const real = new Set(routes.map((r) => `${r.method} ${r.path}`));
  const described = new Set(Object.keys(operations));
  return {
    undocumented: [...real].filter((k) => !described.has(k)).sort(),
    stale: [...described].filter((k) => !real.has(k)).sort(),
  };
}
