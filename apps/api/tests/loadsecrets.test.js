// The secret files are read at process start, before anything reads the environment. Checked in child processes, because the config module
// reads the environment when it is first loaded.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const API = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "shipdok-loadsecrets-"));
const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
const run = (code, env) => execFileSync(process.execPath, ["--input-type=module", "-e", code], { cwd: API, env: { ...baseEnv, ...env }, encoding: "utf8", timeout: 20000 }).trim();

describe("config reads the platform secrets from files", () => {
  const SESSION = "s".repeat(64);
  const KEY = "ab".repeat(32);
  const file = (name, content) => { writeFileSync(join(dir, name), content); return join(dir, name); };

  test("SESSION_SECRET_FILE, APP_SECRETS_KEY_FILE and SETUP_TOKEN_FILE fill the configuration", () => {
    const out = run(
      'const { config, assertConfig } = await import("./src/config.js"); assertConfig(); console.log(config.sessionSecret.length, config.setupToken);',
      { SESSION_SECRET_FILE: file("s", `${SESSION}\n`), APP_SECRETS_KEY_FILE: file("k", KEY), SETUP_TOKEN_FILE: file("t", "ABCDE-FGHJK-LMNPQ-RSTUV") },
    );
    expect(out).toBe(`64 ABCDE-FGHJK-LMNPQ-RSTUV`);
  });

  test("the environment wins over the file", () => {
    const out = run('const { config } = await import("./src/config.js"); console.log(config.sessionSecret);', { SESSION_SECRET: "e".repeat(40), SESSION_SECRET_FILE: file("s2", SESSION) });
    expect(out).toBe("e".repeat(40));
  });

  test("a missing file stops the process with a clear message and no value", () => {
    let err;
    try { run('await import("./src/config.js");', { SESSION_SECRET_FILE: join(dir, "nope") }); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.stderr).toMatch(/SESSION_SECRET_FILE points to a file that cannot be read/);
  });

  test("the database and Redis passwords come from files too", () => {
    const out = run(
      'const { pgConfig } = await import("./src/db/pool.js"); await import("./src/queue.js"); console.log(pgConfig().password, process.env.REDIS_PASSWORD);',
      { POSTGRES_PASSWORD_FILE: file("p", "pg-password-from-file"), REDIS_PASSWORD_FILE: file("r", "redis-password-from-file") },
    );
    expect(out).toBe("pg-password-from-file redis-password-from-file");
  });
});

describe("the first-run script", () => {
  test("generates what is missing, keeps it on the second run, and prints no value", () => {
    const target = mkdtempSync(join(tmpdir(), "shipdok-init-"));
    const first = execFileSync(process.execPath, ["scripts/init-secrets.js"], { cwd: API, env: { ...baseEnv, SECRETS_DIR: target }, encoding: "utf8", timeout: 20000 });
    expect(first).toMatch(/Generated: .*APP_SECRETS_KEY/);
    expect(readdirSync(target).sort()).toEqual(["app_secrets_key", "postgres_password", "redis_password", "session_secret", "setup_token"]);
    const key = readFileSync(join(target, "app_secrets_key"), "utf8");
    expect(first).not.toContain(key);
    const second = execFileSync(process.execPath, ["scripts/init-secrets.js"], { cwd: API, env: { ...baseEnv, SECRETS_DIR: target }, encoding: "utf8", timeout: 20000 });
    expect(second).toMatch(/Nothing to generate/);
    expect(readFileSync(join(target, "app_secrets_key"), "utf8")).toBe(key);
  });

  test("a value given in the environment is not generated", () => {
    const target = mkdtempSync(join(tmpdir(), "shipdok-init-"));
    const out = execFileSync(process.execPath, ["scripts/init-secrets.js"], { cwd: API, env: { ...baseEnv, SECRETS_DIR: target, POSTGRES_PASSWORD: "mine-mine-mine-mine" }, encoding: "utf8", timeout: 20000 });
    expect(out).toMatch(/Taken from the environment \(nothing written\): POSTGRES_PASSWORD/);
    expect(readdirSync(target)).not.toContain("postgres_password");
    expect(out).not.toContain("mine-mine-mine-mine");
  });

  test("an unusable directory is a clear failure", () => {
    const notADirectory = join(dir, "just-a-file");
    writeFileSync(notADirectory, "x");
    let err;
    try { execFileSync(process.execPath, ["scripts/init-secrets.js"], { cwd: API, env: { ...baseEnv, SECRETS_DIR: join(notADirectory, "secrets") }, encoding: "utf8", stdio: "pipe", timeout: 20000 }); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.status).toBe(1);
    expect(err.stderr).toMatch(/Could not prepare the secrets/);
  });
});
