// npm run openapi -w apps/api   -> writes openapi/openapi.json
// Fails (and writes nothing) when a route has no description or a description has no route.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

process.env.SESSION_SECRET ??= 'x'.repeat(40); // only so that the app can be built to list its routes; nothing is listened on
const { createApp } = await import('../src/app.js');
const { listRoutes } = await import('./inventory.js');
const { buildSpec, compare } = await import('./build.js');

export const OUTPUT = fileURLToPath(new URL('./openapi.json', import.meta.url));

export const realRoutes = () => listRoutes(() => createApp({
  db: { query: async () => ({ rows: [] }) }, queue: {}, secretsKey: Buffer.alloc(32), webhookSecret: 'x',
}));

export const render = () => `${JSON.stringify(buildSpec(), null, 2)}\n`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { undocumented, stale } = compare(realRoutes());
  if (undocumented.length || stale.length) {
    if (undocumented.length) console.error(`Routes with no description in openapi/operations/:\n  ${undocumented.join('\n  ')}`);
    if (stale.length) console.error(`Descriptions with no route (renamed or removed?):\n  ${stale.join('\n  ')}`);
    process.exit(1);
  }
  await writeFile(OUTPUT, render());
  console.log(`Wrote ${OUTPUT} (${Object.keys(buildSpec().paths).length} paths)`);
  process.exit(0);
}
