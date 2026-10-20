import request from "supertest";
import { jest } from "@jest/globals";
import { parseMasterKey, decryptSecret, envVarContext } from "@shipdok/shared";
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from "./helpers.js";

const SECRET = "S3cr3t-Value-Do-Not-Leak-9f2a";
const KEY = parseMasterKey(process.env.APP_SECRETS_KEY);

let queue;
let app;
let agent;
let appId;
const seen = []; // everything the API ever sent back, for leak checks

const track = (res) => {
  seen.push(res.text ?? "", JSON.stringify(res.headers));
  return res;
};
const put = (k, value) => agent.put(`/api/apps/${appId}/env/${k}`).send({ value }).then(track);
const list = () => agent.get(`/api/apps/${appId}/env`).then(track);
const del = (k) => agent.delete(`/api/apps/${appId}/env/${k}`).then(track);
const reveal = (k) => agent.post(`/api/apps/${appId}/env/${k}/reveal`).then(track);
const importText = (content) => agent.post(`/api/apps/${appId}/env/import`).send({ content }).then(track);
const rows = async () =>
  (await testPool.query("SELECT key, value_encrypted, version::text AS version FROM app_env_vars ORDER BY key")).rows;

// Simulates the worker finishing a deployment, so "pending changes" has a baseline.
async function deployOk() {
  const dep = (await agent.post(`/api/apps/${appId}/deployments`)).body;
  await testPool.query(`UPDATE deployments SET status = 'successful', finished_at = now() WHERE id = $1`, [dep.id]);
  return dep;
}

beforeEach(async () => {
  seen.length = 0;
  await resetDb();
  queue = { add: jest.fn(async () => ({ id: "42" })) };
  app = await makeApp({ queue });
  agent = request.agent(app);
  await agent.post("/api/auth/setup").send({ username: "admin", password: PASSWORD });
  const created = await agent.post("/api/apps").send({
    name: "Env App",
    repo: "o/r",
    container_port: 3000,
    host_port: 8080,
  });
  appId = created.body.id;
});
afterEach(() => jest.restoreAllMocks());
afterAll(closeDb);

describe("authentication and origin", () => {
  test("every route requires a session", async () => {
    const anon = request(app);
    const base = `/api/apps/${appId}/env`;
    expect((await anon.get(base)).status).toBe(401);
    expect((await anon.put(`${base}/A`).send({ value: "x" })).status).toBe(401);
    expect((await anon.delete(`${base}/A`)).status).toBe(401);
    expect((await anon.post(`${base}/import`).send({ content: "A=1" })).status).toBe(401);
    expect((await anon.post(`${base}/A/reveal`)).status).toBe(401);
  });

  test("state-changing requests from a foreign origin are rejected and change nothing", async () => {
    await put("KEEP", "original");
    const evil = "http://evil.example";
    const base = `/api/apps/${appId}/env`;
    expect((await agent.put(`${base}/KEEP`).set("Origin", evil).send({ value: "hacked" })).status).toBe(403);
    expect((await agent.delete(`${base}/KEEP`).set("Origin", evil)).status).toBe(403);
    expect((await agent.post(`${base}/import`).set("Origin", evil).send({ content: "X=1" })).status).toBe(403);
    expect((await agent.post(`${base}/KEEP/reveal`).set("Origin", evil)).status).toBe(403);
    expect((await rows()).map((r) => r.key)).toEqual(["KEEP"]);
    expect((await reveal("KEEP")).body.value).toBe("original");
  });

  test("unknown and malformed app ids are 404", async () => {
    const zero = "00000000-0000-0000-0000-000000000000";
    expect((await agent.get(`/api/apps/${zero}/env`)).status).toBe(404);
    expect((await agent.get("/api/apps/not-a-uuid/env")).status).toBe(404);
    expect((await agent.put(`/api/apps/${zero}/env/A`).send({ value: "x" })).status).toBe(404);
  });
});

describe("storing variables", () => {
  test("creates (201) then updates (200)", async () => {
    const a = await put("DATABASE_URL", SECRET);
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ key: "DATABASE_URL", created: true });
    const b = await put("DATABASE_URL", `${SECRET}-new`);
    expect(b.status).toBe(200);
    expect(b.body.created).toBe(false);
    expect(await rows()).toHaveLength(1);
  });

  test("the table never holds plaintext, and the stored value decrypts only with the right context", async () => {
    await put("DATABASE_URL", SECRET);
    const [row] = await rows();
    expect(row.value_encrypted).toMatch(/^v1:/);
    expect(row.value_encrypted).not.toContain(SECRET);
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(decryptSecret(row.value_encrypted, KEY, envVarContext(appId, "DATABASE_URL"))).toBe(SECRET);
    expect(() => decryptSecret(row.value_encrypted, KEY, envVarContext(appId, "OTHER"))).toThrow();
  });

  test("every change gets a new version, including re-adding a deleted variable", async () => {
    await put("A", "1");
    const v1 = (await rows())[0].version;
    await put("A", "2");
    const v2 = (await rows())[0].version;
    await del("A");
    await put("A", "2");
    const v3 = (await rows())[0].version;
    expect(new Set([v1, v2, v3]).size).toBe(3);
  });

  test("accepts empty, unicode and multi-line values, and round-trips them", async () => {
    const values = { EMPTY: "", UNI: "pässwörd-密码-🔑", PEM: "-----BEGIN-----\nabc\n-----END-----\n" };
    for (const [k, v] of Object.entries(values)) expect((await put(k, v)).status).toBe(201);
    for (const [k, v] of Object.entries(values)) expect((await reveal(k)).body.value).toBe(v);
  });

  test.each([
    ["a digit first", "1BAD"],
    ["a dash", "a-b"],
    ["a dot", "a.b"],
    ["too long", "A".repeat(129)],
  ])("rejects a name with %s", async (_l, name) => {
    expect((await put(name, "x")).status).toBe(400);
    expect(await rows()).toHaveLength(0);
  });

  test.each(["PATH", "NODE_OPTIONS", "LD_PRELOAD", "HOME", "SHIPDOK_TOKEN"])(
    "rejects the reserved name %s",
    async (name) => {
      const res = await put(name, "x");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/reserved/);
    },
  );

  test("rejects values that are not strings, contain a null, or exceed 64 KB", async () => {
    expect((await put("A", 123)).status).toBe(400);
    expect((await put("A", null)).status).toBe(400);
    expect((await put("A", "ab\u0000cd")).status).toBe(400);
    expect((await put("A", "x".repeat(65 * 1024))).status).toBe(400);
    expect((await put("A", "x".repeat(64 * 1024))).status).toBe(201); // exactly at the limit is fine
  });

  test("an app can have at most 100 variables; existing ones can still be updated", async () => {
    await testPool.query(
      `INSERT INTO app_env_vars (app_id, key, value_encrypted)
       SELECT $1, 'K' || g, 'v1:a:b:c' FROM generate_series(1, 100) g`,
      [appId],
    );
    expect((await put("ONE_TOO_MANY", "x")).status).toBe(400);
    expect((await put("K1", "still-allowed")).status).toBe(200);
    expect(await rows()).toHaveLength(100);
  });

  test("deleting removes a variable; deleting it again is a 404", async () => {
    await put("A", "1");
    expect((await del("A")).status).toBe(204);
    expect((await del("A")).status).toBe(404);
    expect((await del("not a name")).status).toBe(404);
    expect(await rows()).toHaveLength(0);
  });
});

describe("masking: values never leave the server except through reveal", () => {
  test("listing shows names and a fixed mask, sorted, with no values", async () => {
    await put("ZED", SECRET);
    await put("ALPHA", "short");
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body.variables.map((v) => v.key)).toEqual(["ALPHA", "ZED"]);
    expect(res.body.variables.every((v) => v.value === "********")).toBe(true); // same mask for every length
    expect(res.text).not.toContain(SECRET);
  });

  test("no response from any route ever contained the secret, except reveal", async () => {
    await put("A", SECRET);
    await put("A", SECRET); // update
    await importText(`B=${SECRET}\nC=ok`);
    await importText(`D=${SECRET}\nbroken line ${SECRET}`); // fails
    await put("PATH", SECRET); // fails
    await list();
    await del("C");
    await del("C"); // 404
    expect(seen.join("\n")).not.toContain(SECRET);
    expect((await reveal("A")).body.value).toBe(SECRET); // and reveal is the one that does
  });

  test("stored values are not leaked through deployment snapshots either", async () => {
    await put("A", SECRET);
    const dep = (await agent.post(`/api/apps/${appId}/deployments`)).body;
    expect(JSON.stringify(dep)).not.toContain(SECRET);
    expect(dep.config_snapshot.env).toEqual({ A: (await rows())[0].version });
    expect(JSON.stringify(queue.add.mock.calls)).not.toContain(SECRET);
  });

  test("nothing is written to the server logs", async () => {
    const spies = ["log", "info", "warn", "error", "debug"].map((m) =>
      jest.spyOn(console, m).mockImplementation(() => {}),
    );
    await put("A", SECRET);
    await put("PATH", SECRET);
    await importText(`B=${SECRET}\nbad ${SECRET}`);
    await importText(`B=${SECRET}`);
    await reveal("B");
    await testPool.query(`UPDATE app_env_vars SET value_encrypted = 'v1:AAAA:BBBB:CCCC' WHERE key = 'B'`);
    expect((await reveal("B")).status).toBe(500); // forces the decrypt-failure path
    await del("A");
    const logged = spies
      .flatMap((s) => s.mock.calls)
      .map((args) => args.map(String).join(" "))
      .join("\n");
    expect(logged).not.toContain(SECRET);
  });
});

describe("reveal", () => {
  test("returns one decrypted value and forbids caching", async () => {
    await put("API_KEY", SECRET);
    const res = await reveal("API_KEY");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ key: "API_KEY", value: SECRET });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("unknown variables are 404, and GET is not a way to reveal", async () => {
    await put("A", SECRET);
    expect((await reveal("MISSING")).status).toBe(404);
    expect((await agent.get(`/api/apps/${appId}/env/A/reveal`)).status).toBe(404);
    expect((await agent.get(`/api/apps/${appId}/env/A`)).status).toBe(404);
  });

  test("a ciphertext moved to another variable name will not decrypt, and leaks nothing", async () => {
    await put("REAL", SECRET);
    await put("OTHER", "x");
    const real = (await rows()).find((r) => r.key === "REAL");
    await testPool.query(`UPDATE app_env_vars SET value_encrypted = $1 WHERE key = 'OTHER'`, [real.value_encrypted]);
    jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await reveal("OTHER");
    expect(res.status).toBe(500);
    expect(res.text).not.toContain(SECRET);
  });

  test("a ciphertext moved to another app will not decrypt", async () => {
    await put("SHARED_NAME", SECRET);
    const second = (
      await agent.post("/api/apps").send({ name: "Second", repo: "o/r2", container_port: 3000, host_port: 8081 })
    ).body.id;
    const stolen = (await rows())[0].value_encrypted;
    await testPool.query("INSERT INTO app_env_vars (app_id, key, value_encrypted) VALUES ($1, $2, $3)", [
      second,
      "SHARED_NAME",
      stolen,
    ]);
    jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await agent.post(`/api/apps/${second}/env/SHARED_NAME/reveal`);
    expect(res.status).toBe(500);
    expect(res.text).not.toContain(SECRET);
  });
});

describe(".env import", () => {
  const FILE = [
    "# database",
    'export DATABASE_URL="postgres://u:p@h:5432/db"',
    "API_KEY='abc#123'",
    "PORT=3000 # the port",
    'GREETING="hello\\nworld"',
    "DUP=first",
    "DUP=second",
  ].join("\n");

  test("imports every variable and reports what happened", async () => {
    const res = await importText(FILE);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 5, updated: 0, duplicates: ["DUP"] });
    expect(res.body.keys.sort()).toEqual(["API_KEY", "DATABASE_URL", "DUP", "GREETING", "PORT"]);

    const expected = {
      DATABASE_URL: "postgres://u:p@h:5432/db",
      API_KEY: "abc#123",
      PORT: "3000",
      GREETING: "hello\nworld",
      DUP: "second",
    };
    for (const row of await rows()) {
      expect(decryptSecret(row.value_encrypted, KEY, envVarContext(appId, row.key))).toBe(expected[row.key]);
    }
  });

  test("importing again updates existing variables instead of failing", async () => {
    await importText("A=1\nB=2");
    const res = await importText("B=changed\nC=3");
    expect(res.body).toMatchObject({ created: 1, updated: 1 });
    expect((await reveal("B")).body.value).toBe("changed");
  });

  test("is all-or-nothing: one bad line means nothing is saved, and every problem is reported with its line", async () => {
    const res = await importText(`GOOD=1\nno equals ${SECRET}\nPATH=/evil\n1BAD=x\nALSO_GOOD=2`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nothing was saved/);
    expect(res.body.problems.map((p) => p.line)).toEqual([2, 3, 4]);
    expect(res.text).not.toContain(SECRET);
    expect(await rows()).toHaveLength(0);
  });

  test("refuses an import that would exceed 100 variables, saving nothing", async () => {
    await put("EXISTING", "x");
    const big = Array.from({ length: 100 }, (_, i) => `N${i}=${i}`).join("\n");
    const res = await importText(big);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at most 100/);
    expect(await rows()).toHaveLength(1);
  });

  test("rejects missing content, non-text content and files with no variables", async () => {
    expect((await agent.post(`/api/apps/${appId}/env/import`).send({})).status).toBe(400);
    expect((await agent.post(`/api/apps/${appId}/env/import`).send({ content: 42 })).status).toBe(400);
    expect((await importText("# just a comment\n\n")).status).toBe(400);
  });
});

describe("pending changes", () => {
  test("before any successful deployment there is no baseline to compare against", async () => {
    await put("A", "1");
    const { pending } = (await list()).body;
    expect(pending).toEqual({ deployed: false, pending: false, added: [], changed: [], removed: [] });
  });

  test("tracks added, changed and removed variables against the last successful deployment", async () => {
    await put("A", "1");
    await put("B", "1");
    await deployOk();
    expect((await list()).body.pending).toMatchObject({ deployed: true, pending: false });

    await put("C", "1"); // added
    await put("A", "2"); // changed
    await del("B"); // removed
    expect((await list()).body.pending).toEqual({
      deployed: true,
      pending: true,
      added: ["C"],
      changed: ["A"],
      removed: ["B"],
    });

    await deployOk();
    expect((await list()).body.pending).toMatchObject({ pending: false });
  });

  test("deleting and re-adding a variable counts as a change, even with the same value", async () => {
    await put("A", "same");
    await deployOk();
    await del("A");
    await put("A", "same");
    expect((await list()).body.pending).toMatchObject({ pending: true, changed: ["A"] });
  });

  test("a failed or queued deployment is not a baseline", async () => {
    await put("A", "1");
    const dep = (await agent.post(`/api/apps/${appId}/deployments`)).body;
    await testPool.query(`UPDATE deployments SET status = 'failed', finished_at = now() WHERE id = $1`, [dep.id]);
    expect((await list()).body.pending.deployed).toBe(false);
  });

  test("a deployment from before variables existed counts every current variable as added", async () => {
    const dep = (await agent.post(`/api/apps/${appId}/deployments`)).body;
    await testPool.query(
      `UPDATE deployments SET status = 'successful', finished_at = now(), config_snapshot = config_snapshot - 'env' WHERE id = $1`,
      [dep.id],
    );
    await put("A", "1");
    expect((await list()).body.pending).toMatchObject({ deployed: true, pending: true, added: ["A"] });
  });
});

describe("where a variable is available (scope)", () => {
  const putScoped = (k, body) => agent.put(`/api/apps/${appId}/env/${k}`).send(body).then(track);
  const scopeOf = async (k) => (await testPool.query("SELECT scope FROM app_env_vars WHERE key = $1", [k])).rows[0]?.scope;
  const versionOf = async (k) => (await testPool.query("SELECT version::text AS v FROM app_env_vars WHERE key = $1", [k])).rows[0].v;
  const valueOf = async (k) => (await reveal(k)).body.value;

  test("a new variable is runtime-only unless it says otherwise, and the list shows the scope", async () => {
    await put("PLAIN", "1");
    await putScoped("VITE_X", { value: "2", scope: "build" });
    await putScoped("BOTH_ONE", { value: "3", scope: "both" });
    const res = await list();
    expect(res.body.variables.map((v) => [v.key, v.scope])).toEqual([["BOTH_ONE", "both"], ["PLAIN", "runtime"], ["VITE_X", "build"]]);
    expect(res.body.variables.every((v) => v.value === "********")).toBe(true);
  });

  test("the answer carries the scope", async () => {
    const res = await putScoped("A", { value: "1", scope: "both" });
    expect([res.status, res.body.scope, res.body.created]).toEqual([201, "both", true]);
  });

  test("a new value keeps the scope the variable has", async () => {
    await putScoped("A", { value: "1", scope: "build" });
    await put("A", "2");
    expect(await scopeOf("A")).toBe("build");
    expect(await valueOf("A")).toBe("2");
  });

  test("a scope alone changes where it is available, keeps the value, and gets a new version", async () => {
    await put("A", "keep-me");
    const before = await versionOf("A");
    const res = await putScoped("A", { scope: "both" });
    expect([res.status, res.body.scope, res.body.created]).toEqual([200, "both", false]);
    expect(await scopeOf("A")).toBe("both");
    expect(await valueOf("A")).toBe("keep-me");
    expect(await versionOf("A")).not.toBe(before);
  });

  test("the same scope again changes nothing, not even the version", async () => {
    await putScoped("A", { value: "1", scope: "build" });
    const before = await versionOf("A");
    expect((await putScoped("A", { scope: "build" })).status).toBe(200);
    expect(await versionOf("A")).toBe(before);
  });

  test("a scope change is a pending change (it applies from the next deployment)", async () => {
    await put("A", "1");
    await deployOk();
    expect((await list()).body.pending.pending).toBe(false);
    await putScoped("A", { scope: "build" });
    expect((await list()).body.pending).toMatchObject({ pending: true, changed: ["A"] });
  });

  test("a scope for a variable that does not exist is a 404, not a new empty variable", async () => {
    expect((await putScoped("NOPE", { scope: "build" })).status).toBe(404);
    expect(await scopeOf("NOPE")).toBeUndefined();
  });

  test("nothing at all to set is refused", async () => {
    expect((await putScoped("A", {})).status).toBe(400);
  });

  test("an unknown scope is refused and changes nothing", async () => {
    await put("A", "1");
    for (const scope of ["Build", "all", "", null, 1]) expect((await putScoped("A", { scope })).status).toBe(400);
    expect(await scopeOf("A")).toBe("runtime");
  });

  test.each(["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "BUILDKIT_PROGRESS", "LD_PRELOAD", "XDG_CONFIG_HOME", "LANG"])(
    "%s may not be used at build time, whether new or existing",
    async (name) => {
      const res = await putScoped(name, { value: "x", scope: "build" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/reserved|cannot be used at build time/);
      expect((await putScoped(name, { value: "x", scope: "both" })).status).toBe(400);
    },
  );

  test("a name that is only reserved at build time is still fine as a runtime variable", async () => {
    expect((await put("LANG", "en_US.UTF-8")).status).toBe(201);
    expect((await putScoped("LANG", { scope: "build" })).status).toBe(400); // an existing runtime variable cannot be moved to build either
    expect(await scopeOf("LANG")).toBe("runtime");
  });

  test("a name that is reserved everywhere stays refused, whatever the scope", async () => {
    expect((await putScoped("SHIPDOK_X", { value: "1", scope: "build" })).status).toBe(400);
    expect((await put("NODE_OPTIONS", "1")).status).toBe(400);
  });

  test("an import never changes the scope of a variable that exists, and new ones start as runtime", async () => {
    await putScoped("VITE_X", { value: "old", scope: "build" });
    const res = await importText("VITE_X=new\nPLAIN=1\n");
    expect(res.status).toBe(200);
    expect(await scopeOf("VITE_X")).toBe("build");
    expect(await scopeOf("PLAIN")).toBe("runtime");
    expect(await valueOf("VITE_X")).toBe("new");
  });

  test("the value of a build variable is encrypted and never listed, like any other", async () => {
    await putScoped("NPM_TOKEN", { value: SECRET, scope: "build" });
    const row = (await rows()).find((r) => r.key === "NPM_TOKEN");
    expect(row.value_encrypted).not.toContain(SECRET);
    expect(decryptSecret(row.value_encrypted, KEY, envVarContext(appId, "NPM_TOKEN"))).toBe(SECRET);
    await list();
    expect(seen.join("\n")).not.toContain(SECRET.slice(0, 12));
  });

  test("a deployment job never carries a value, only the snapshot's version numbers", async () => {
    await putScoped("NPM_TOKEN", { value: SECRET, scope: "build" });
    const dep = (await agent.post(`/api/apps/${appId}/deployments`)).body;
    expect(JSON.stringify(queue.add.mock.calls.at(-1)[1])).not.toContain(SECRET);
    expect(JSON.stringify(dep)).not.toContain(SECRET);
    expect(Object.keys(dep.config_snapshot.env)).toContain("NPM_TOKEN");
  });
});

describe("how a build variable is passed (buildAs)", () => {
  const putAs = (k, body) => agent.put(`/api/apps/${appId}/env/${k}`).send(body).then(track);
  const asOf = async (k) => (await testPool.query("SELECT build_as FROM app_env_vars WHERE key = $1", [k])).rows[0]?.build_as;
  const versionOf = async (k) => (await testPool.query("SELECT version::text AS v FROM app_env_vars WHERE key = $1", [k])).rows[0].v;
  const valueOf = async (k) => (await reveal(k)).body.value;

  test("a new variable is passed as an argument unless it says otherwise; the list and the answer show it", async () => {
    await put("PLAIN", "1");
    const res = await putAs("NPM_TOKEN", { value: "t", scope: "build", buildAs: "secret" });
    expect([res.status, res.body.build_as]).toEqual([201, "secret"]);
    expect((await list()).body.variables.map((v) => [v.key, v.build_as])).toEqual([["NPM_TOKEN", "secret"], ["PLAIN", "arg"]]);
  });

  test("a new value keeps how it is passed", async () => {
    await putAs("A", { value: "1", scope: "build", buildAs: "secret" });
    await put("A", "2");
    expect(await asOf("A")).toBe("secret");
  });

  test("buildAs alone changes how it is passed, keeps the value and the scope, and gets a new version", async () => {
    await putAs("A", { value: "keep-me", scope: "both" });
    const before = await versionOf("A");
    const res = await putAs("A", { buildAs: "secret" });
    expect([res.status, res.body.build_as, res.body.scope]).toEqual([200, "secret", "both"]);
    expect(await asOf("A")).toBe("secret");
    expect(await valueOf("A")).toBe("keep-me");
    expect(await versionOf("A")).not.toBe(before);
  });

  test("the same again changes nothing, not even the version", async () => {
    await putAs("A", { value: "1", scope: "build", buildAs: "secret" });
    const before = await versionOf("A");
    expect((await putAs("A", { buildAs: "secret", scope: "build" })).status).toBe(200);
    expect(await versionOf("A")).toBe(before);
  });

  test("a change is a pending change", async () => {
    await putAs("A", { value: "1", scope: "build" });
    await deployOk();
    await putAs("A", { buildAs: "secret" });
    expect((await list()).body.pending).toMatchObject({ pending: true, changed: ["A"] });
  });

  test("a scope change alone keeps how it is passed", async () => {
    await putAs("A", { value: "1", scope: "build", buildAs: "secret" });
    await putAs("A", { scope: "both" });
    expect(await asOf("A")).toBe("secret");
  });

  test("an unknown value is refused and changes nothing; no such variable is a 404", async () => {
    await put("A", "1");
    for (const buildAs of ["Secret", "env", "", null, 1]) expect((await putAs("A", { buildAs })).status).toBe(400);
    expect(await asOf("A")).toBe("arg");
    expect((await putAs("NOPE", { buildAs: "secret" })).status).toBe(404);
  });

  test("an import never changes it, and new variables start as arguments", async () => {
    await putAs("TOKEN", { value: "old", scope: "build", buildAs: "secret" });
    expect((await importText("TOKEN=new\nOTHER=1\n")).status).toBe(200);
    expect(await asOf("TOKEN")).toBe("secret");
    expect(await asOf("OTHER")).toBe("arg");
  });

  test("a rename keeps it, and a rename can change it in the same request", async () => {
    await putAs("OLD_NAME", { value: "v", scope: "build", buildAs: "secret" });
    expect((await putAs("OLD_NAME", { newKey: "NEW_NAME" })).body.build_as).toBe("secret");
    expect(await asOf("NEW_NAME")).toBe("secret");
    expect((await putAs("NEW_NAME", { newKey: "THIRD", buildAs: "arg" })).body.build_as).toBe("arg");
    expect(await asOf("THIRD")).toBe("arg");
    expect(await valueOf("THIRD")).toBe("v");
  });

  test("the value of a secret is encrypted and never listed", async () => {
    await putAs("NPM_TOKEN", { value: SECRET, scope: "build", buildAs: "secret" });
    expect((await rows()).find((r) => r.key === "NPM_TOKEN").value_encrypted).not.toContain(SECRET);
    await list();
    expect(seen.join("\n")).not.toContain(SECRET.slice(0, 12));
  });
});

describe("renaming a variable", () => {
  const edit = (k, body) => agent.put(`/api/apps/${appId}/env/${k}`).send(body).then(track);
  const keys = async () => (await testPool.query("SELECT key FROM app_env_vars ORDER BY key")).rows.map((r) => r.key);
  const row = async (k) => (await testPool.query("SELECT scope, value_encrypted, version::text AS version FROM app_env_vars WHERE key = $1", [k])).rows[0];
  const valueOf = async (k) => (await reveal(k)).body.value;

  test("renames, keeping the value and the scope, and says what it was called", async () => {
    await edit("OLD_NAME", { value: "keep-me", scope: "build" });
    const res = await edit("OLD_NAME", { newKey: "NEW_NAME" });
    expect([res.status, res.body.key, res.body.previous_key, res.body.scope, res.body.created]).toEqual([200, "NEW_NAME", "OLD_NAME", "build", false]);
    expect(await keys()).toEqual(["NEW_NAME"]);
    expect(await valueOf("NEW_NAME")).toBe("keep-me");
    expect((await row("NEW_NAME")).scope).toBe("build");
  });

  test("the value is encrypted again for the new name (it only decrypts under it), and never shown", async () => {
    await put("OLD_NAME", SECRET);
    await edit("OLD_NAME", { newKey: "NEW_NAME" });
    const token = (await row("NEW_NAME")).value_encrypted;
    expect(decryptSecret(token, KEY, envVarContext(appId, "NEW_NAME"))).toBe(SECRET);
    expect(() => decryptSecret(token, KEY, envVarContext(appId, "OLD_NAME"))).toThrow();
    expect(seen.join("\n")).not.toContain(SECRET);
  });

  test("a new name can come with a new value and a new scope in the same request", async () => {
    await edit("A", { value: "old", scope: "runtime" });
    const res = await edit("A", { newKey: "B", value: "fresh", scope: "both" });
    expect([res.status, res.body.key, res.body.scope]).toEqual([200, "B", "both"]);
    expect(await keys()).toEqual(["B"]);
    expect(await valueOf("B")).toBe("fresh");
    expect((await row("B")).scope).toBe("both");
  });

  test("the version changes, so it is a pending change", async () => {
    await put("A", "1");
    const before = (await row("A")).version;
    await edit("A", { newKey: "B" });
    expect((await row("B")).version).not.toBe(before);
  });

  test("after a deployment the old name shows as removed and the new one as added", async () => {
    await put("A", "1");
    await deployOk();
    await edit("A", { newKey: "B" });
    expect((await list()).body.pending).toMatchObject({ pending: true, added: ["B"], removed: ["A"], changed: [] });
  });

  test("a name that is already taken is a 409 and nothing changes, not even the other variable", async () => {
    await put("A", "a-value");
    await put("B", "b-value");
    const res = await edit("A", { newKey: "B", value: "overwrite?" });
    expect([res.status, res.body.code]).toEqual([409, "name_taken"]);
    expect(await keys()).toEqual(["A", "B"]);
    expect(await valueOf("A")).toBe("a-value");
    expect(await valueOf("B")).toBe("b-value");
  });

  test("renaming a variable that does not exist is a 404, and creates nothing", async () => {
    expect((await edit("NOPE", { newKey: "OTHER" })).status).toBe(404);
    expect((await edit("NOPE", { newKey: "OTHER", value: "x" })).status).toBe(404); // a rename never makes a new variable
    expect(await keys()).toEqual([]);
  });

  test("the new name follows the same rules as any name", async () => {
    await put("A", "1");
    for (const newKey of ["1BAD", "has-dash", "", "PATH", "NODE_OPTIONS", "SHIPDOK_X", "x".repeat(129)]) {
      expect((await edit("A", { newKey })).status).toBe(400);
    }
    expect((await edit("A", { newKey: 5 })).status).toBe(400);
    expect(await keys()).toEqual(["A"]);
  });

  test("a name that cannot be used at build time is refused when the variable reaches the build, and fine for runtime", async () => {
    await edit("BUILD_ONE", { value: "1", scope: "build" });
    const refused = await edit("BUILD_ONE", { newKey: "LANG" });
    expect([refused.status, refused.body.error]).toEqual([400, expect.stringMatching(/cannot be used at build time/)]);
    expect((await edit("BUILD_ONE", { newKey: "LANG", scope: "both" })).status).toBe(400);
    expect(await keys()).toEqual(["BUILD_ONE"]);
    // moving it to runtime in the same request is fine
    expect((await edit("BUILD_ONE", { newKey: "LANG", scope: "runtime" })).status).toBe(200);
    // and a runtime variable may take such a name
    await put("PLAIN", "1");
    expect((await edit("PLAIN", { newKey: "TZ" })).status).toBe(200);
  });

  test("renaming to its own name is an ordinary edit, not a conflict", async () => {
    await put("A", "1");
    const res = await edit("A", { newKey: "A", value: "2" });
    expect([res.status, res.body.key, res.body.previous_key]).toEqual([200, "A", undefined]);
    expect(await valueOf("A")).toBe("2");
    expect((await edit("A", { newKey: "A" })).status).toBe(400); // nothing to change
  });

  test("two requests renaming to the same name: exactly one wins", async () => {
    await put("A", "a");
    await put("B", "b");
    const results = await Promise.all([edit("A", { newKey: "C" }), edit("B", { newKey: "C" })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await keys()).filter((k) => k === "C")).toHaveLength(1);
    expect(await keys()).toHaveLength(2);
  });

  test("a value that cannot be decrypted cannot be carried over, but a new value renames it fine; neither leaks anything", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {}); // the route logs (without any name or value) that it could not decrypt
    await testPool.query("INSERT INTO app_env_vars (app_id, key, value_encrypted) VALUES ($1, 'BROKEN', 'v1:aaaa:bbbb:cccc')", [appId]);
    const refused = await edit("BROKEN", { newKey: "FIXED" });
    expect(refused.status).toBe(500);
    expect(refused.text).toMatch(/APP_SECRETS_KEY/);
    expect(await keys()).toEqual(["BROKEN"]); // nothing changed
    const ok = await edit("BROKEN", { newKey: "FIXED", value: SECRET });
    expect(ok.status).toBe(200);
    expect(await valueOf("FIXED")).toBe(SECRET);
  });

  test("it needs the same session as everything else", async () => {
    await put("A", "1");
    const res = await request(app).put(`/api/apps/${appId}/env/A`).send({ newKey: "B" });
    expect(res.status).toBe(401);
    expect(await keys()).toEqual(["A"]);
  });

  test("a request with nothing in it is still refused", async () => {
    await put("A", "1");
    expect((await edit("A", {})).status).toBe(400);
  });
});
