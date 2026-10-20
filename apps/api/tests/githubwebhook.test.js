import request from "supertest";
import { generateKeyPairSync } from "node:crypto";
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from "./helpers.js";
import { createGithubProvider, parseMasterKey, saveGithubApp } from "@shipdok/shared";

const KEY = parseMasterKey("a1".repeat(32));
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" });
const URL_A = "https://shipdok.example.com";
const HOOK_A = `${URL_A}/api/webhooks/github`;

let app;
let cookie;
let gh;
let hooks; // what the fake GitHub currently has, per GitHub App number
let failing; // GitHub App number -> status its PATCH answers with (-1: the network fails)
let ids; // GitHub App number -> Shipdok's id for it
const issuer = (init) => JSON.parse(Buffer.from(String(init.headers?.Authorization ?? init.headers?.authorization).split(" ")[1].split(".")[1], "base64url").toString()).iss;

async function boot({ apps = ["1"], publicUrl = "" } = {}) {
  await resetDb();
  await testPool.query("DELETE FROM settings");
  hooks = Object.fromEntries(apps.map((n) => [n, `https://old${n}.example.com/api/webhooks/github`]));
  failing = {};
  const calls = [];
  gh = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const who = String(issuer(init));
    calls.push({ app: who, path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    if (path === "/app/hook/config" && (init.method ?? "GET") === "GET") return new Response(JSON.stringify({ url: hooks[who], content_type: "json" }), { status: 200 });
    if (path === "/app/hook/config" && init.method === "PATCH") {
      if (failing[who] === -1) throw new Error("network");
      if (failing[who]) return new Response("{}", { status: failing[who] });
      hooks[who] = JSON.parse(init.body).url;
      return new Response(JSON.stringify({ url: hooks[who] }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  gh.calls = calls;
  if (publicUrl) await testPool.query(`INSERT INTO settings (key, value) VALUES ('public_url', to_jsonb($1::text))`, [publicUrl]);
  ids = {};
  for (const n of apps) ids[n] = (await saveGithubApp(testPool, KEY, { appId: n, slug: `s${n}`, name: `App ${n}`, privateKeyPem: PEM, webhookSecret: `hook-secret-0123456789-${n}`, source: "manual" })).id;
  const githubProvider = createGithubProvider(testPool, KEY, { ttlMs: 0, fetch: gh });
  app = await makeApp({ githubProvider, githubFetch: gh });
  cookie = (await request(app).post("/api/auth/setup").send({ username: "admin", password: PASSWORD })).headers["set-cookie"];
}
afterAll(async () => {
  await resetDb();
  await testPool.query("DELETE FROM settings");
  await closeDb();
});

const check = (n = "1", c = cookie) => request(app).get(`/api/github/apps/${ids[n] ?? n}/webhook`).set("Cookie", c ?? []);
const sync = (n = "1", c = cookie) => request(app).post(`/api/github/apps/${ids[n] ?? n}/webhook/sync`).set("Cookie", c ?? []);
const putSettings = (body) => request(app).put("/api/settings/public").set("Cookie", cookie).send({ password: PASSWORD, ...body });
const patches = () => gh.calls.filter((c) => c.method === "PATCH");
const NOBODY = "99999999-9999-4999-8999-999999999999";

describe("which address GitHub sends webhooks to", () => {
  test("needs a session", async () => {
    await boot();
    expect((await check("1", null)).status).toBe(401);
    expect((await sync("1", null)).status).toBe(401);
  });

  test("404 for a GitHub app that is not connected", async () => {
    await boot();
    expect((await check(NOBODY)).status).toBe(404);
    expect((await sync(NOBODY)).status).toBe(404);
    expect((await check("not-an-id")).status).toBe(404);
  });

  test("with no public address there is nothing to compare with, and nothing can be synced", async () => {
    await boot();
    const res = await check();
    expect(res.body).toEqual({ expected: null, actual: hooks["1"], matches: null });
    const s = await sync();
    expect(s.status).toBe(400);
    expect(s.body.code).toBe("no_public_address");
    expect(patches()).toHaveLength(0);
  });

  test("says whether GitHub has the address Shipdok expects", async () => {
    await boot({ publicUrl: URL_A });
    expect((await check()).body).toEqual({ expected: HOOK_A, actual: "https://old1.example.com/api/webhooks/github", matches: false });
    hooks["1"] = HOOK_A;
    expect((await check()).body).toEqual({ expected: HOOK_A, actual: HOOK_A, matches: true });
  });

  test("each GitHub app is asked about its own address", async () => {
    await boot({ apps: ["1", "2"], publicUrl: URL_A });
    hooks["2"] = HOOK_A;
    expect((await check("1")).body.matches).toBe(false);
    expect((await check("2")).body.matches).toBe(true);
    expect(gh.calls.filter((c) => c.method === "GET").map((c) => c.app)).toEqual(["1", "2"]);
  });

  test("a failure to ask GitHub is a 502", async () => {
    await boot({ publicUrl: URL_A });
    const broken = createGithubProvider(testPool, KEY, { ttlMs: 0, fetch: async () => new Response("{}", { status: 500 }) });
    app = await makeApp({ githubProvider: broken });
    cookie = (await request(app).post("/api/auth/login").send({ username: "admin", password: PASSWORD })).headers["set-cookie"];
    const res = await check();
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/GitHub/);
  });

  test("sync points GitHub at the expected address, and only changes the address", async () => {
    await boot({ publicUrl: URL_A });
    const res = await sync();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ expected: HOOK_A, actual: HOOK_A, matches: true });
    expect(patches()).toHaveLength(1);
    expect(patches()[0].body).toEqual({ url: HOOK_A });
    expect(hooks["1"]).toBe(HOOK_A);
  });

  test("sync changes only the app it was asked about", async () => {
    await boot({ apps: ["1", "2"], publicUrl: URL_A });
    await sync("2");
    expect(patches().map((p) => p.app)).toEqual(["2"]);
    expect(hooks["1"]).toBe("https://old1.example.com/api/webhooks/github");
    expect(hooks["2"]).toBe(HOOK_A);
  });

  test.each([[403, /did not accept/i], [-1, /reach GitHub/i], [500, /GitHub/]])("a failed sync (%i) is a 502 with a plain reason", async (status, message) => {
    await boot({ publicUrl: URL_A });
    failing["1"] = status;
    const res = await sync();
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(message);
  });
});

describe("changing the public address updates GitHub by itself", () => {
  test("when an app is connected and the address changes", async () => {
    await boot();
    const res = await putSettings({ publicUrl: URL_A });
    expect(res.status).toBe(200);
    expect(res.body.githubWebhook).toEqual({ updated: true });
    expect(hooks["1"]).toBe(HOOK_A);
  });

  test("every connected GitHub app is told, not only one", async () => {
    await boot({ apps: ["1", "2", "3"] });
    const res = await putSettings({ publicUrl: URL_A });
    expect(res.body.githubWebhook).toEqual({ updated: true });
    expect(Object.values(hooks)).toEqual([HOOK_A, HOOK_A, HOOK_A]);
    expect(patches().map((p) => p.app).sort()).toEqual(["1", "2", "3"]);
  });

  test("one that fails does not stop the others, and the answer names it", async () => {
    await boot({ apps: ["1", "2", "3"] });
    failing["2"] = 403;
    const res = await putSettings({ publicUrl: URL_A });
    expect(res.status).toBe(200);
    expect(res.body.githubWebhook.updated).toBe(false);
    expect(res.body.githubWebhook.failed).toEqual(["App 2"]);
    expect(res.body.githubWebhook.error).toMatch(/App 2/);
    expect(res.body.githubWebhook.error).not.toMatch(/App 1|App 3/);
    expect(hooks["1"]).toBe(HOOK_A);
    expect(hooks["3"]).toBe(HOOK_A);
  });

  test("a failure does not undo the setting, and says what happened", async () => {
    await boot();
    failing["1"] = 403;
    const res = await putSettings({ publicUrl: URL_A });
    expect(res.status).toBe(200);
    expect(res.body.publicUrl).toBe(URL_A);
    expect(res.body.githubWebhook.updated).toBe(false);
    expect(res.body.githubWebhook.error).toMatch(/did not accept/i);
  });

  test("an unreachable GitHub is reported differently from a refusal", async () => {
    await boot();
    failing["1"] = -1;
    const res = await putSettings({ publicUrl: URL_A });
    expect(res.body.githubWebhook.error).toMatch(/Could not update/i);
  });

  test("not when no app is connected", async () => {
    await boot({ apps: [] });
    const res = await putSettings({ publicUrl: URL_A });
    expect(res.status).toBe(200);
    expect(res.body.githubWebhook).toBeUndefined();
  });

  test("not when the address is cleared, or when only the mode changes", async () => {
    await boot({ publicUrl: URL_A });
    expect((await putSettings({ publicUrl: "" })).body.githubWebhook).toBeUndefined();
    expect((await putSettings({ mode: "webhook" })).body.githubWebhook).toBeUndefined();
    expect(patches()).toHaveLength(0);
  });

  test("not when the address is saved unchanged", async () => {
    await boot({ publicUrl: URL_A });
    expect((await putSettings({ publicUrl: URL_A })).body.githubWebhook).toBeUndefined();
    expect(patches()).toHaveLength(0);
  });
});
