// Loaded with `node --import` before every test file. Points the worker's database module at
// the *_test database (never the dev one) and sets a fixed test-only master key.
const base = process.env.POSTGRES_DB;
if (!base) throw new Error('POSTGRES_DB is not set. Run tests with: npm test');
if (!base.endsWith('_test')) process.env.POSTGRES_DB = `${base}_test`;
process.env.APP_SECRETS_KEY = 'a1'.repeat(32); // NOT your real key
// Deployment logs go to a throwaway directory, never to the real ~/.shipdok/logs.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.LOG_DIR = mkdtempSync(join(tmpdir(), 'shipdok-test-logs-'));
