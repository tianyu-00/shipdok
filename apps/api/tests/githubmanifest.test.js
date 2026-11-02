import request from "supertest";
import { generateKeyPairSync } from "node:crypto";
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from "./helpers.js";
import { createGithubProvider, parseMasterKey, saveGithubApp, loadGithubApp, listGithubApps } from "@shipdok/shared";
import { createSettings } from "../src/settings.js";

const KEY = parseMasterKey("a1".repeat(32));
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" });
const ORIGIN = "http://localhost:5173"; // WEB_ORIGIN in the test environment
const CODE = "abcdef0123456789abcdef";

function fakeGithub(handlers = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method ?? "GET", headers: init.headers ?? {} });
    const h = handlers[path] ?? handlers["*"];
    const r = h ? await h({ path, init }) : { status: 404, json: { message: "no fake" } };
    if (r.throws) throw new Error("network");
    return new Response(r.raw ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  };
  fn.calls = calls;
  return fn;
}
const converted = (over = {}) => ({
  status: 201,
  json: { id: 424242, slug: "shipdok-ab12", name: "Shipdok-ab12", html_url: "https://github.com/apps/shipdok-ab12", owner: { login: "tianyu-00" }, client_id: "Iv1.abc", client_secret: "client-secret-value", webhook_secret: "hook-secret-0123456789", pem: PEM, ...over },
});

let app;
let cookie;
let gh;
async function boot(handlers) {
  await resetDb();
  await testPool.query("DELETE FROM settings");
  gh = fakeGithub(handlers ?? { [`/app-manifests/${CODE}/conversions`]: () => converted() });
  const githubProvider = createGithubProvider(testPool, KEY, { ttlMs: 0, fetch: gh });
  app = await makeApp({ githubProvider, githubFetch: gh, settings: createSettings(testPool, { ttlMs: 0 }) }); // no cache: a test changes the settings under it
  cookie = (await request(app).post("/api/auth/setup").send({ username: "admin", password: PASSWORD })).headers["set-cookie"];
  await testPool.query("DELETE FROM login_attempts");
}
beforeEach(() => boot());
afterAll(async () => {
  await resetDb();
  await testPool.query("DELETE FROM settings");
  await closeDb();
});

const start = (body = {}, headers = { Origin: ORIGIN }, c = cookie) => request(app).post("/api/github/connect/start").set("Cookie", c ?? []).set(headers).send(body);
const callback = (query, c = cookie) => request(app).get("/api/github/connect/callback").query(query).set("Cookie", c ?? []);
const stateOf = (res) => new URL(res.body.postUrl).searchParams.get("state");
const connectedRows = async () => (await testPool.query("SELECT count(*)::int AS n FROM github_apps")).rows[0].n;

describe("starting", () => {
  test("needs a session", async () => {
    expect((await start({}, { Origin: ORIGIN }, null)).status).toBe(401);
  });

  test("gives the page the address to post to and the app definition", async () => {
    const res = await start();
    expect(res.status).toBe(200);
    expect(res.body.postUrl).toMatch(/^https:\/\/github\.com\/settings\/apps\/new\?state=[A-Za-z0-9_-]{40,}$/);
    const m = res.body.manifest;
    expect(m.name).toMatch(/^Shipdok-[0-9a-f]{4}$/);
    expect(m.redirect_url).toBe(`${ORIGIN}/api/github/connect/callback`);
    expect(m.public).toBe(false);
    expect(m.default_permissions).toEqual({ contents: "read", metadata: "read" });
    expect(m.default_events).toEqual(["push"]);
    expect(m.hook_attributes.active).toBe(true);
  });

  test("asks for nothing more than reading code and hearing about pushes", async () => {
    const m = (await start()).body.manifest;
    expect(Object.keys(m.default_permissions).sort()).toEqual(["contents", "metadata"]);
    expect(Object.values(m.default_permissions)).toEqual(["read", "read"]);
    expect(m.default_events).toEqual(["push"]);
    expect(JSON.stringify(m)).not.toMatch(/write|admin/);
  });

  test("the webhook address comes from the public address when there is one", async () => {
    await testPool.query(`INSERT INTO settings (key, value) VALUES ('public_url', to_jsonb('https://shipdok.example.com'::text))`);
    const m = (await start()).body.manifest;
    expect(m.hook_attributes.url).toBe("https://shipdok.example.com/api/webhooks/github");
    expect(m.url).toBe("https://shipdok.example.com");
  });

  test("with no public address the dashboard's own address stands in (GitHub cannot deliver until one is set)", async () => {
    const m = (await start()).body.manifest;
    expect(m.hook_attributes.url).toBe(`${ORIGIN}/api/webhooks/github`);
    expect(m.url).toBe(ORIGIN);
  });

  test("a chosen name is used, a bad one refused", async () => {
    expect((await start({ name: "My Shipdok" })).body.manifest.name).toBe("My Shipdok");
    for (const bad of ["", " leading", "x".repeat(35), "semi;colon", "<b>", 5]) {
      if (bad === "") continue; // empty means "pick one for me"
      const res = await start({ name: bad });
      expect([bad, res.status]).toEqual([bad, 400]);
    }
  });

  test("an organisation goes into the address, only if it is a valid login", async () => {
    expect((await start({ owner: "my-org" })).body.postUrl).toMatch(/^https:\/\/github\.com\/organizations\/my-org\/settings\/apps\/new\?state=/);
    expect((await start({ owner: "" })).body.postUrl).toMatch(/^https:\/\/github\.com\/settings\/apps\/new\?/);
    for (const bad of ["a/b", "../x", "a b", "a?b", "-lead", "x".repeat(40), 5]) {
      const res = await start({ owner: bad });
      expect([bad, res.status]).toEqual([bad, 400]);
    }
  });

  test("it must come from one of the dashboard's addresses", async () => {
    expect((await start({}, {})).status).toBe(400); // no Origin
    const foreign = await start({}, { Origin: "https://evil.example.com" });
    expect(foreign.status).toBe(403); // refused by the origin check before it gets here
  });

  test("the public address counts as the dashboard's address too", async () => {
    await testPool.query(`INSERT INTO settings (key, value) VALUES ('public_url', to_jsonb('https://shipdok.example.com'::text))`);
    const res = await start({}, { Origin: "https://shipdok.example.com" });
    expect(res.status).toBe(200);
    expect(res.body.manifest.redirect_url).toBe("https://shipdok.example.com/api/github/connect/callback");
  });

  test("each start makes a new state", async () => {
    const a = stateOf(await start());
    const b = stateOf(await start());
    expect(a).not.toBe(b);
  });

  test("allowed while other apps are already connected: it adds one more", async () => {
    await saveGithubApp(testPool, KEY, { appId: "1", privateKeyPem: PEM, webhookSecret: "hook-secret-0123456789", source: "manual" });
    const res = await start();
    expect(res.status).toBe(200);
    expect(res.body.postUrl).toMatch(/^https:\/\/github\.com\/settings\/apps\/new\?state=/);
  });
});

describe("coming back from GitHub", () => {
  const go = async () => {
    const res = await start();
    return stateOf(res);
  };

  test("trades the code for the app, stores it encrypted, and goes back to the GitHub page", async () => {
    const state = await go();
    const res = await callback({ code: CODE, state });
    expect(res.status).toBe(302);
    const [only] = await listGithubApps(testPool);
    expect(res.headers.location).toBe(`/github?connected=${only.id}`);
    expect(res.headers["cache-control"]).toBe("no-store");
    const saved = await loadGithubApp(testPool, KEY, only.id);
    expect(saved).toMatchObject({ appId: "424242", name: "Shipdok-ab12", slug: "shipdok-ab12", ownerLogin: "tianyu-00", source: "manifest", webhookSecret: "hook-secret-0123456789" });
    const row = (await testPool.query("SELECT * FROM github_apps")).rows[0];
    expect(JSON.stringify(row)).not.toContain("hook-secret-0123456789");
    expect(JSON.stringify(row)).not.toContain("client-secret-value");
    expect(JSON.stringify(row)).not.toContain("BEGIN RSA");
    expect(row.client_secret_enc).toMatch(/^v1:/);
  });

  test("calls GitHub once, without credentials, for exactly this code", async () => {
    await callback({ code: CODE, state: await go() });
    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0]).toMatchObject({ path: `/app-manifests/${CODE}/conversions`, method: "POST" });
    expect(gh.calls[0].headers.Authorization).toBeUndefined();
  });

  test("nothing secret is in the redirect, and it works at once (the webhook can be verified)", async () => {
    const res = await callback({ code: CODE, state: await go() });
    expect(res.headers.location).not.toMatch(/secret|key|pem|424242/i);
    expect(JSON.stringify(res.headers)).not.toContain("hook-secret-0123456789");
    expect((await request(app).get("/api/github").set("Cookie", cookie)).body.apps[0]).toMatchObject({ appId: "424242", source: "manifest" });
  });

  test("is recorded in the activity log, with the app", async () => {
    await callback({ code: CODE, state: await go() });
    const list = (await request(app).get("/api/audit").set("Cookie", cookie)).body.entries;
    expect(list[0]).toMatchObject({ category: "github", action: "github_created", actor: "admin", source: "user" });
    expect(list[0].summary).toMatch(/^GitHub app created through GitHub: /);
    expect(list[0].details.map((d) => d.label)).toEqual(["App", "GitHub app number", "Owner", "How"]);
    expect(JSON.stringify(list[0])).not.toMatch(/PRIVATE KEY|webhook_secret/i);
  });

  test("the state works once: a second visit with the same state is refused and GitHub is not asked", async () => {
    const state = await go();
    await callback({ code: CODE, state });
    const again = await callback({ code: CODE, state });
    expect(again.headers.location).toBe("/github?error=state");
    expect(gh.calls).toHaveLength(1);
  });

  test("without a login it goes to the login, and GitHub is not asked", async () => {
    const state = await go();
    const res = await callback({ code: CODE, state }, null);
    expect(res.headers.location).toBe("/github?error=login");
    expect(gh.calls).toHaveLength(0);
    expect(await connectedRows()).toBe(0);
  });

  test.each([
    ["a wrong state", () => ({ code: CODE, state: "not-the-state-not-the-state-not-the-state" })],
    ["no state", () => ({ code: CODE })],
    ["a state that is a list", () => ({ code: CODE, "state[]": "x" })],
  ])("%s is refused and GitHub is not asked", async (_, query) => {
    await go();
    const res = await callback(query());
    expect(res.headers.location).toBe("/github?error=state");
    expect(gh.calls).toHaveLength(0);
    expect(await connectedRows()).toBe(0);
  });

  test("a wrong state also uses up the real one (no second try with a guess)", async () => {
    const state = await go();
    await callback({ code: CODE, state: "wrong-wrong-wrong-wrong-wrong-wrong-wrong" });
    const res = await callback({ code: CODE, state });
    expect(res.headers.location).toBe("/github?error=state");
  });

  test("a visit with no start in this session is refused", async () => {
    const res = await callback({ code: CODE, state: "anything-anything-anything-anything-12" });
    expect(res.headers.location).toBe("/github?error=state");
    expect(gh.calls).toHaveLength(0);
  });

  test("a state older than ten minutes is refused", async () => {
    const state = await go();
    await testPool.query(`UPDATE "session" SET sess = jsonb_set(sess::jsonb, '{githubConnect,at}', to_jsonb($1::bigint))::json`, [Date.now() - 11 * 60 * 1000]);
    const res = await callback({ code: CODE, state });
    expect(res.headers.location).toBe("/github?error=state");
    expect(gh.calls).toHaveLength(0);
  });

  test("a state a session started cannot be used from another session", async () => {
    const state = await go();
    const other = (await request(app).post("/api/auth/login").send({ username: "admin", password: PASSWORD })).headers["set-cookie"];
    const res = await callback({ code: CODE, state }, other);
    expect(res.headers.location).toBe("/github?error=state");
  });

  test.each([["no code", {}], ["a code that is a list", { "code[]": "x" }]])("%s fails the exchange without asking GitHub", async (_, extra) => {
    const state = await go();
    const res = await callback({ state, ...extra });
    expect(res.headers.location).toBe("/github?error=exchange_failed");
    expect(gh.calls).toHaveLength(0);
  });

  test("a code that cannot be a code never reaches GitHub", async () => {
    const state = await go();
    const res = await callback({ state, code: "../../../x" });
    expect(res.headers.location).toBe("/github?error=exchange_failed");
    expect(gh.calls).toHaveLength(0);
  });

  test("a code GitHub does not accept stores nothing", async () => {
    await boot({ [`/app-manifests/${CODE}/conversions`]: () => ({ status: 404, json: { message: "Not Found" } }) });
    const res = await callback({ code: CODE, state: await go() });
    expect(res.headers.location).toBe("/github?error=exchange_failed");
    expect(await connectedRows()).toBe(0);
  });

  test("GitHub being unreachable is its own reason and stores nothing", async () => {
    await boot({ [`/app-manifests/${CODE}/conversions`]: () => ({ throws: true }) });
    const res = await callback({ code: CODE, state: await go() });
    expect(res.headers.location).toBe("/github?error=github_unreachable");
    expect(await connectedRows()).toBe(0);
  });

  test("an answer without a usable key stores nothing", async () => {
    await boot({ [`/app-manifests/${CODE}/conversions`]: () => converted({ pem: "not a key" }) });
    const res = await callback({ code: CODE, state: await go() });
    expect(res.headers.location).toBe("/github?error=exchange_failed");
    expect(await connectedRows()).toBe(0);
  });

  test("connecting a new app leaves the projects of the apps already connected, and their installations, alone", async () => {
    const old = await saveGithubApp(testPool, KEY, { appId: "1", privateKeyPem: PEM, webhookSecret: "other-secret-0123456789", source: "manual" });
    await testPool.query("INSERT INTO apps (name, slug, repo, container_port, host_port, github_installation_id, github_app_id) VALUES ('A','a','o/r',3000,21000,7,$1)", [old.id]);
    await callback({ code: CODE, state: await go() });
    const row = (await testPool.query("SELECT github_installation_id, github_app_id FROM apps")).rows[0];
    expect([Number(row.github_installation_id), row.github_app_id]).toEqual([7, old.id]);
  });

  test("a failed exchange leaves them alone", async () => {
    await boot({ [`/app-manifests/${CODE}/conversions`]: () => ({ status: 404, json: {} }) });
    await testPool.query("INSERT INTO apps (name, slug, repo, container_port, host_port, github_installation_id) VALUES ('A','a','o/r',3000,21000,7)");
    await callback({ code: CODE, state: await go() });
    expect(Number((await testPool.query("SELECT github_installation_id FROM apps")).rows[0].github_installation_id)).toBe(7);
  });

  test("an app connected in the meantime is not touched: the new one is added beside it", async () => {
    const state = await go();
    const other = await saveGithubApp(testPool, KEY, { appId: "1", privateKeyPem: PEM, webhookSecret: "other-secret-0123456789", source: "manual" });
    const res = await callback({ code: CODE, state });
    expect(res.headers.location).toMatch(/^\/github\?connected=[0-9a-f-]{36}$/);
    expect((await loadGithubApp(testPool, KEY, other.id)).appId).toBe("1");
    expect((await listGithubApps(testPool)).map((a) => a.appId)).toEqual(["1", "424242"]);
  });
});
