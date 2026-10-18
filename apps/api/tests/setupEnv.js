// Runs before each test file. Points the app at a separate *_test database so tests
// can wipe tables freely, and sets deterministic app settings.
const base = process.env.POSTGRES_DB;
if (!base) throw new Error("POSTGRES_DB is not set. Run tests with: npm test");
if (!base.endsWith("_test")) process.env.POSTGRES_DB = `${base}_test`;

process.env.SESSION_SECRET = "test-secret-".padEnd(48, "x");
process.env.WEB_ORIGIN = "http://localhost:5173";
process.env.SETUP_TOKEN = "";
process.env.COOKIE_SECURE = "false";
// A fixed key that is NOT your real one: tests never touch infrastructure/.env's key.
process.env.APP_SECRETS_KEY = "a1".repeat(32);
process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret-0123456789abcdef";
