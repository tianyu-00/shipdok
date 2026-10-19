import request from "supertest";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from "./helpers.js";
import { createGithubProvider, parseMasterKey, saveGithubApp, loadGithubApp } from "@shipdok/shared";

const KEY = parseMasterKey("a1".repeat(32)); // the key setupEnv.js gives the app
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" });
const SECRET = "a-webhook-secret-0123456789";

// A fake GitHub: answers by path, records every call.
function fakeGithub(handlers = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const path = new URL(url).pathname + new URL(url).search;
    calls.push({ path, method: init.method ?? "GET", auth: init.headers?.Authorization });
    const h = handlers[path] ?? handlers["*"];
    const r = h ? await h({ path, init }) : { status: 404, json: { message: "no fake" } };
    if (r.throws) throw new Error("network");
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  fn.calls = calls;
  return fn;
}
const appReply = (over = {}) => ({ json: { id: 123456, slug: "shipdok", name: "Shipdok", html_url: "https://github.com/apps/shipdok", owner: { login: "tianyu-00" }, ...over } });

let app;
let cookie;
let gh;
async function boot(handlers = { "/app": () => appReply() }) {
  await resetDb();
  await testPool.query("DELETE FROM github_app");
  gh = fakeGithub(handlers);
  const githubProvider = createGithubProvider(testPool, KEY, { ttlMs: 0, fetch: gh });
  app = await makeApp({ githubProvider, githubFetch: gh });
  const res = await request(app).post("/api/auth/setup").send({ username: "admin", password: PASSWORD });
  cookie = res.headers["set-cookie"];
  await testPool.query("DELETE FROM login_attempts");
}
beforeEach(async () => {
  await boot();
});
afterAll(async () => {
  await testPool.query("DELETE FROM github_app");
  await closeDb();
});

const status = (c = cookie) => request(app).get("/api/github").set("Cookie", c ?? []);
const manual = (body, c = cookie) => request(app).post("/api/github/manual").set("Cookie", c ?? []).send(body);
const good = (over = {}) => ({ password: PASSWORD, appId: "123456", privateKey: PEM, webhookSecret: SECRET, ...over });
const disconnect = (body, c = cookie) => request(app).delete("/api/github").set("Cookie", c ?? []).send(body);
const signed = (body, secret = SECRET) => {
  const raw = JSON.stringify(body);
  return request(app).post("/api/webhooks/github").set("Content-Type", "application/json").set("X-GitHub-Event", "ping").set("X-GitHub-Delivery", `d-${Math.random().toString(16).slice(2)}-${Date.now()}`.padEnd(20, "0"))
    .set("X-Hub-Signature-256", `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`).send(raw);
};

describe("the status", () => {
  test("needs a session", async () => {
    expect((await status(null)).status).toBe(401);
  });

  test("nothing connected yet", async () => {
    const res = await status();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false, app: null, problem: null });
  });

  test("once connected it describes the app and never a secret", async () => {
    await manual(good());
    const res = await status();
    expect(res.body.connected).toBe(true);
    expect(res.body.app).toMatchObject({ appId: "123456", name: "Shipdok", slug: "shipdok", ownerLogin: "tianyu-00", htmlUrl: "https://github.com/apps/shipdok", source: "manual" });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toMatch(/webhookSecret|privateKey|client_?secret/i);
  });

  test("credentials that cannot be decrypted are reported, not hidden", async () => {
    await saveGithubApp(testPool, parseMasterKey("b2".repeat(32)), { appId: "1", privateKeyPem: PEM, webhookSecret: SECRET, source: "manual" });
    const res = await status();
    expect(res.body).toMatchObject({ connected: false, problem: "cannot_decrypt" });
  });
});

describe("entering the app by hand", () => {
  test("needs a session", async () => {
    expect((await manual(good(), null)).status).toBe(401);
  });

  test("checks the key and the id with GitHub, then stores the app encrypted and answers with its details", async () => {
    const res = await manual(good());
    expect(res.status).toBe(200);
    expect(res.body.app).toMatchObject({ appId: "123456", name: "Shipdok", source: "manual" });
    expect(gh.calls.map((c) => c.path)).toContain("/app");
    expect(gh.calls[0].auth).toMatch(/^Bearer ey/); // signed as the app
    const saved = await loadGithubApp(testPool, KEY);
    expect(saved.webhookSecret).toBe(SECRET);
    const row = (await testPool.query("SELECT * FROM github_app")).rows[0];
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(JSON.stringify(row)).not.toContain("BEGIN RSA");
  });

  test("the answer carries no secret", async () => {
    const res = await manual(good());
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(JSON.stringify(res.body)).not.toContain("PRIVATE KEY");
  });

  test("a wrong password changes nothing", async () => {
    const res = await manual(good({ password: "not-the-password-xx" }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("wrong_password");
    expect((await testPool.query("SELECT count(*)::int AS n FROM github_app")).rows[0].n).toBe(0);
    expect(gh.calls).toHaveLength(0);
  });

  test.each([
    ["no password", { password: undefined }, 400, /password/i],
    ["no app id", { appId: undefined }, 400, /app id/i],
    ["an app id that is not a number", { appId: "abc" }, 400, /number/i],
    ["an app id with spaces in it", { appId: "12 34" }, 400, /number/i],
    ["no private key", { privateKey: undefined }, 400, /private key/i],
    ["a private key that is not a key", { privateKey: "not a key" }, 400, /private key/i],
    ["no webhook secret", { webhookSecret: undefined }, 400, /webhook secret/i],
    ["a webhook secret that is too short", { webhookSecret: "short" }, 400, /at least 16/i],
    ["a webhook secret that is too long", { webhookSecret: "x".repeat(300) }, 400, /at most 256/i],
  ])("%s is refused (%i) without calling GitHub or storing anything", async (_, over, code, message) => {
    const res = await manual(good(over));
    expect(res.status).toBe(code);
    expect(res.body.error).toMatch(message);
    expect(gh.calls).toHaveLength(0);
    expect((await testPool.query("SELECT count(*)::int AS n FROM github_app")).rows[0].n).toBe(0);
  });

  test("an error never repeats the secret or the key", async () => {
    const res = await manual(good({ privateKey: `${PEM.slice(0, 80)} broken` }));
    expect(JSON.stringify(res.body)).not.toContain(PEM.split("\n")[1]);
    const res2 = await manual(good({ webhookSecret: "short-secret-abcde" }));
    expect(JSON.stringify(res2.body)).not.toContain("short-secret-abcde");
  });

  test("a key a PEM with Windows line endings and spaces around it is fine", async () => {
    const res = await manual(good({ privateKey: `  ${PEM.replace(/\n/g, "\r\n")}  ` }));
    expect(res.status).toBe(200);
  });

  test("GitHub refusing the key or id is explained and nothing is stored", async () => {
    await boot({ "/app": () => ({ status: 401, json: { message: "A JSON web token could not be decoded" } }) });
    const res = await manual(good());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("github_rejected");
    expect(res.body.error).toMatch(/did not accept/i);
    expect((await testPool.query("SELECT count(*)::int AS n FROM github_app")).rows[0].n).toBe(0);
  });

  test("an app id that GitHub says belongs to another app is refused", async () => {
    await boot({ "/app": () => appReply({ id: 999 }) });
    const res = await manual(good());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("app_id_mismatch");
    expect((await testPool.query("SELECT count(*)::int AS n FROM github_app")).rows[0].n).toBe(0);
  });

  test("GitHub being unreachable is a 502 and nothing is stored", async () => {
    await boot({ "/app": () => ({ throws: true }) });
    const res = await manual(good());
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("github_unreachable");
    expect((await testPool.query("SELECT count(*)::int AS n FROM github_app")).rows[0].n).toBe(0);
  });

  test("entering it again replaces the app", async () => {
    await manual(good());
    await manual(good({ webhookSecret: "second-secret-0123456789" }));
    expect((await testPool.query("SELECT count(*)::int AS n FROM github_app")).rows[0].n).toBe(1);
    expect((await loadGithubApp(testPool, KEY)).webhookSecret).toBe("second-secret-0123456789");
  });

  test("is recorded in the sign-ins list", async () => {
    await manual(good());
    const list = (await request(app).get("/api/auth/logins").set("Cookie", cookie)).body.logins;
    expect(list[0]).toMatchObject({ kind: "github", username: "admin", success: true });
  });

  test("a failed attempt is not recorded as a change", async () => {
    await manual(good({ password: "not-the-password-xx" }));
    const list = (await request(app).get("/api/auth/logins").set("Cookie", cookie)).body.logins;
    expect(list.some((l) => l.kind === "github")).toBe(false);
  });

  test("a wrong password is limited like the other password checks", async () => {
    for (let i = 0; i < 10; i++) expect((await manual(good({ password: "nope-nope-nope-1" }))).status).toBe(403);
    expect((await manual(good({ password: "nope-nope-nope-1" }))).status).toBe(429);
  });
});

describe("installation ids belong to one GitHub App", () => {
  const withInstalledApp = async () => {
    await testPool.query("INSERT INTO apps (name, slug, repo, container_port, host_port, github_installation_id) VALUES ('A','a','o/r',3000,21000,7), ('B','b','o/s',3000,21001,NULL)");
  };
  const stored = async () => (await testPool.query("SELECT slug, github_installation_id FROM apps ORDER BY slug")).rows.map((r) => [r.slug, r.github_installation_id === null ? null : Number(r.github_installation_id)]);

  test("entering a (different) app forgets the installations remembered for the old one", async () => {
    await withInstalledApp();
    await manual(good());
    expect(await stored()).toEqual([["a", null], ["b", null]]);
  });

  test("a refused attempt leaves them alone", async () => {
    await withInstalledApp();
    await manual(good({ password: "not-the-password-xx" }));
    expect(await stored()).toEqual([["a", 7], ["b", null]]);
    await boot({ "/app": () => ({ status: 401, json: {} }) });
    await withInstalledApp();
    await manual(good());
    expect(await stored()).toEqual([["a", 7], ["b", null]]);
  });

  test("disconnecting forgets them too", async () => {
    await manual(good());
    await withInstalledApp();
    await disconnect({ password: PASSWORD });
    expect(await stored()).toEqual([["a", null], ["b", null]]);
  });
});

describe("the webhook uses the stored secret, live", () => {
  test("until an app is connected it is switched off", async () => {
    const res = await signed({ zen: "x" });
    expect(res.status).toBe(503);
  });

  test("connecting switches it on at once, with no restart", async () => {
    await manual(good());
    expect((await signed({ zen: "x" })).status).toBe(200);
    expect((await signed({ zen: "x" }, "some-other-secret-0123456789")).status).toBe(401);
  });

  test("replacing the secret changes which signature is accepted, at once", async () => {
    await manual(good());
    await manual(good({ webhookSecret: "second-secret-0123456789" }));
    expect((await signed({ zen: "x" }, SECRET)).status).toBe(401);
    expect((await signed({ zen: "x" }, "second-secret-0123456789")).status).toBe(200);
  });

  test("disconnecting switches it off again", async () => {
    await manual(good());
    await disconnect({ password: PASSWORD });
    expect((await signed({ zen: "x" })).status).toBe(503);
  });
});

describe("with the real cache time (a change must not wait for it)", () => {
  beforeEach(async () => {
    await resetDb();
    await testPool.query("DELETE FROM github_app");
    gh = fakeGithub({ "/app": () => appReply() });
    const githubProvider = createGithubProvider(testPool, KEY, { ttlMs: 60_000, fetch: gh });
    app = await makeApp({ githubProvider, githubFetch: gh });
    cookie = (await request(app).post("/api/auth/setup").send({ username: "admin", password: PASSWORD })).headers["set-cookie"];
  });

  test("connecting, replacing and disconnecting take effect at once in the same process", async () => {
    expect((await signed({ zen: "x" })).status).toBe(503); // primes the cache with "nothing connected"
    await manual(good());
    expect((await signed({ zen: "x" })).status).toBe(200);
    await manual(good({ webhookSecret: "second-secret-0123456789" }));
    expect((await signed({ zen: "x" }, "second-secret-0123456789")).status).toBe(200);
    await disconnect({ password: PASSWORD });
    expect((await signed({ zen: "x" }, "second-secret-0123456789")).status).toBe(503);
  });
});

describe("disconnecting", () => {
  beforeEach(async () => { await manual(good()); });

  test("needs a session and the password", async () => {
    expect((await disconnect({ password: PASSWORD }, null)).status).toBe(401);
    const wrong = await disconnect({ password: "not-the-password-xx" });
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe("wrong_password");
    expect((await disconnect({})).status).toBe(400);
    expect((await status()).body.connected).toBe(true);
  });

  test("removes the credentials", async () => {
    const res = await disconnect({ password: PASSWORD });
    expect(res.status).toBe(204);
    expect((await status()).body).toEqual({ connected: false, app: null, problem: null });
    expect((await testPool.query("SELECT count(*)::int AS n FROM github_app")).rows[0].n).toBe(0);
  });

  test("with nothing connected it is a quiet 204", async () => {
    await disconnect({ password: PASSWORD });
    expect((await disconnect({ password: PASSWORD })).status).toBe(204);
  });

  test("leaves apps and their deployments alone", async () => {
    await testPool.query("INSERT INTO apps (name, slug, repo, container_port, host_port) VALUES ('A','a','o/r',3000,21000)");
    await disconnect({ password: PASSWORD });
    expect((await testPool.query("SELECT count(*)::int AS n FROM apps")).rows[0].n).toBe(1);
  });

  test("is recorded in the sign-ins list", async () => {
    await disconnect({ password: PASSWORD });
    const list = (await request(app).get("/api/auth/logins").set("Cookie", cookie)).body.logins;
    expect(list[0]).toMatchObject({ kind: "github", success: true });
  });
});

describe("repositories and installations", () => {
  const REPOS = {
    "/app/installations?per_page=100": () => ({ json: [{ id: 7, account: { login: "tianyu-00" } }] }),
    "/app/installations/7/access_tokens": () => ({ status: 201, json: { token: "ghs_x", expires_at: new Date(Date.now() + 3600_000).toISOString() } }),
    "/installation/repositories?per_page=100": () => ({ json: { repositories: [{ full_name: "tianyu-00/shipdok-test-app", private: true, default_branch: "main" }] } }),
    "/app": () => appReply(),
  };

  test("repositories: 501 until an app is connected, then the list", async () => {
    await boot(REPOS);
    expect((await request(app).get("/api/github/repos").set("Cookie", cookie)).status).toBe(501);
    await manual(good());
    const res = await request(app).get("/api/github/repos").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.repos).toEqual([{ fullName: "tianyu-00/shipdok-test-app", private: true, defaultBranch: "main", installationId: 7 }]);
    expect(JSON.stringify(res.body)).not.toContain("ghs_x");
  });

  test("installations: who the app is installed on", async () => {
    await boot(REPOS);
    expect((await request(app).get("/api/github/installations").set("Cookie", cookie)).status).toBe(501);
    await manual(good());
    const res = await request(app).get("/api/github/installations").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.installations).toEqual([{ id: 7, account: "tianyu-00" }]);
  });

  test("a GitHub failure is a 502 with a plain message", async () => {
    await boot({ ...REPOS, "/app/installations?per_page=100": () => ({ status: 500, json: {} }) });
    await manual(good());
    const res = await request(app).get("/api/github/installations").set("Cookie", cookie);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/GitHub/);
  });

  test("both need a session", async () => {
    expect((await request(app).get("/api/github/repos")).status).toBe(401);
    expect((await request(app).get("/api/github/installations")).status).toBe(401);
  });
});

describe("a new app checks whether the connected GitHub App is installed on its repository", () => {
  test("uses the stored app, with no restart", async () => {
    await boot({ "/app": () => appReply(), "/repos/tianyu-00/shipdok-test-app/installation": () => ({ json: { id: 7 } }) });
    await manual(good());
    const res = await request(app).post("/api/apps").set("Cookie", cookie).send({ name: "My app", repo: "tianyu-00/shipdok-test-app", container_port: 3000 });
    expect(res.status).toBe(201);
    expect(res.body.github_installation_id).toBe(7);
  });
});
