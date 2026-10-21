import request from "supertest";
import { jest } from "@jest/globals";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from "./helpers.js";
import { createGithubProvider, parseMasterKey, saveGithubApp, loadGithubApp, listGithubApps } from "@shipdok/shared";

const KEY = parseMasterKey("a1".repeat(32)); // the key setupEnv.js gives the app
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" });
const SECRET = "a-webhook-secret-0123456789";
const SECOND = "second-webhook-secret-9876543210";
const NOBODY = "99999999-9999-4999-8999-999999999999";

// The number of the GitHub App a request is signed as (the `iss` of its token).
// (An installation token, which is not a token of this kind, belongs to no app by itself: undefined.)
const issuer = (init) => {
  const part = String(init.headers?.Authorization).split(" ")[1]?.split(".")[1];
  return part ? String(JSON.parse(Buffer.from(part, "base64url").toString()).iss) : undefined;
};

// A fake GitHub: answers by path, records every call.
function fakeGithub(handlers = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const path = new URL(url).pathname + new URL(url).search;
    calls.push({ path, method: init.method ?? "GET", auth: init.headers?.Authorization, app: issuer(init) });
    const h = handlers[path] ?? handlers["*"];
    const r = h ? await h({ path, init, app: issuer(init) }) : { status: 404, json: { message: "no fake" } };
    if (r.throws) throw new Error("network");
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  fn.calls = calls;
  return fn;
}
// GitHub's answer to "who am I": it is whichever app the token was made for.
const whoAmI = ({ app }) => ({ json: { id: Number(app), slug: `shipdok-${app}`, name: `Shipdok ${app}`, html_url: `https://github.com/apps/shipdok-${app}`, owner: { login: app === "123456" ? "tianyu-00" : "my-org" } } });

let app;
let cookie;
let gh;
async function boot(handlers = { "/app": whoAmI }, { ttlMs = 0 } = {}) {
  await resetDb();
  gh = fakeGithub(handlers);
  const githubProvider = createGithubProvider(testPool, KEY, { ttlMs, fetch: gh });
  app = await makeApp({ githubProvider, githubFetch: gh });
  const res = await request(app).post("/api/auth/setup").send({ username: "admin", password: PASSWORD });
  cookie = res.headers["set-cookie"];
  await testPool.query("DELETE FROM login_attempts");
}
beforeEach(async () => {
  await boot();
});
afterAll(async () => {
  await resetDb();
  await closeDb();
});

const status = (c = cookie) => request(app).get("/api/github").set("Cookie", c ?? []);
const manual = (body, c = cookie) => request(app).post("/api/github/apps").set("Cookie", c ?? []).send(body);
const good = (over = {}) => ({ password: PASSWORD, appId: "123456", privateKey: PEM, webhookSecret: SECRET, ...over });
const other = (over = {}) => good({ appId: "654321", webhookSecret: SECOND, ...over });
const disconnect = (id, body, c = cookie) => request(app).delete(`/api/github/apps/${id}`).set("Cookie", c ?? []).send(body);
const signed = (body, secret = SECRET) => {
  const raw = JSON.stringify(body);
  return request(app).post("/api/webhooks/github").set("Content-Type", "application/json").set("X-GitHub-Event", "ping").set("X-GitHub-Delivery", `d-${Math.random().toString(16).slice(2)}-${Date.now()}`.padEnd(20, "0"))
    .set("X-Hub-Signature-256", `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`).send(raw);
};
const count = async () => (await testPool.query("SELECT count(*)::int AS n FROM github_apps")).rows[0].n;
const addProject = (name, port, githubAppId, installation = null) =>
  testPool.query("INSERT INTO apps (name, slug, repo, container_port, host_port, github_app_id, github_installation_id) VALUES ($1, $1, 'o/r', 3000, $2, $3, $4)", [name, port, githubAppId, installation]);

describe("the list of connected apps", () => {
  test("needs a session", async () => {
    expect((await status(null)).status).toBe(401);
  });

  test("nothing connected yet", async () => {
    const res = await status();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ apps: [], unknownSenders: [] });
  });

  test("once connected it describes each app and never a secret", async () => {
    const first = (await manual(good())).body.app;
    await manual(other());
    const res = await status();
    expect(res.body.apps).toHaveLength(2);
    expect(res.body.apps[0]).toMatchObject({ id: first.id, appId: "123456", name: "Shipdok 123456", slug: "shipdok-123456", ownerLogin: "tianyu-00", htmlUrl: "https://github.com/apps/shipdok-123456", source: "manual", problem: null, projects: [] });
    expect(res.body.apps[1]).toMatchObject({ appId: "654321", ownerLogin: "my-org" });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(SECOND);
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toMatch(/webhookSecret|privateKey|client_?secret/i);
  });

  test("each app lists the projects assigned to it", async () => {
    const a = (await manual(good())).body.app;
    const b = (await manual(other())).body.app;
    await addProject("alpha", 21000, a.id);
    await addProject("beta", 21001, a.id);
    await addProject("gamma", 21002, b.id);
    await addProject("delta", 21003, null);
    const apps = (await status()).body.apps;
    expect(apps[0].projects.map((p) => p.name)).toEqual(["alpha", "beta"]);
    expect(apps[1].projects.map((p) => p.name)).toEqual(["gamma"]);
    expect(Object.keys(apps[0].projects[0]).sort()).toEqual(["id", "name", "slug"]);
  });

  test("credentials that cannot be decrypted are reported on that app, not hidden", async () => {
    await saveGithubApp(testPool, parseMasterKey("b2".repeat(32)), { appId: "1", name: "Broken", privateKeyPem: PEM, webhookSecret: SECRET, source: "manual" });
    await manual(good());
    const res = await status();
    expect(res.body.apps.map((a) => [a.name, a.problem])).toEqual([["Broken", "cannot_decrypt"], ["Shipdok 123456", null]]);
  });
});

describe("entering an app by hand", () => {
  test("needs a session", async () => {
    expect((await manual(good(), null)).status).toBe(401);
  });

  test("checks the key and the id with GitHub, then stores the app encrypted and answers with its details", async () => {
    const res = await manual(good());
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.app).toMatchObject({ appId: "123456", name: "Shipdok 123456", source: "manual" });
    expect(gh.calls.map((c) => c.path)).toContain("/app");
    expect(gh.calls[0].auth).toMatch(/^Bearer ey/); // signed as the app
    const saved = await loadGithubApp(testPool, KEY, res.body.app.id);
    expect(saved.webhookSecret).toBe(SECRET);
    const row = (await testPool.query("SELECT * FROM github_apps")).rows[0];
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
    expect(await count()).toBe(0);
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
    expect(await count()).toBe(0);
  });

  test("an error never repeats the secret or the key", async () => {
    const res = await manual(good({ privateKey: `${PEM.slice(0, 80)} broken` }));
    expect(JSON.stringify(res.body)).not.toContain(PEM.split("\n")[1]);
    const res2 = await manual(good({ webhookSecret: "short-secret-abcde" }));
    expect(JSON.stringify(res2.body)).not.toContain("short-secret-abcde");
  });

  test("a key a PEM with Windows line endings and spaces around it is fine", async () => {
    const res = await manual(good({ privateKey: `  ${PEM.replace(/\n/g, "\r\n")}  ` }));
    expect(res.status).toBe(201);
  });

  test("GitHub refusing the key or id is explained and nothing is stored", async () => {
    await boot({ "/app": () => ({ status: 401, json: { message: "A JSON web token could not be decoded" } }) });
    const res = await manual(good());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("github_rejected");
    expect(res.body.error).toMatch(/did not accept/i);
    expect(await count()).toBe(0);
  });

  test("an app id that GitHub says belongs to another app is refused", async () => {
    await boot({ "/app": () => ({ json: { id: 999, slug: "x", name: "X", html_url: "u", owner: { login: "o" } } }) });
    const res = await manual(good());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("app_id_mismatch");
    expect(await count()).toBe(0);
  });

  test("GitHub being unreachable is a 502 and nothing is stored", async () => {
    await boot({ "/app": () => ({ throws: true }) });
    const res = await manual(good());
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("github_unreachable");
    expect(await count()).toBe(0);
  });

  test("a second, different GitHub App is added next to the first, which is left as it was", async () => {
    const first = (await manual(good())).body.app;
    const second = await manual(other());
    expect(second.status).toBe(201);
    expect(second.body.app.id).not.toBe(first.id);
    expect(await count()).toBe(2);
    expect((await loadGithubApp(testPool, KEY, first.id)).webhookSecret).toBe(SECRET);
    expect((await loadGithubApp(testPool, KEY, second.body.app.id)).webhookSecret).toBe(SECOND);
  });

  test("there is no limit on how many are connected: the twelfth is added like the first", async () => {
    for (let n = 1; n <= 11; n += 1) await saveGithubApp(testPool, KEY, { appId: String(1000 + n), name: `App ${n}`, privateKeyPem: PEM, webhookSecret: `secret-number-${n}-0123456789`, source: "manual" });
    expect((await manual(good())).status).toBe(201);
    expect(await count()).toBe(12);
    expect((await status()).body.apps).toHaveLength(12);
  });

  test("entering the same GitHub App again replaces its credentials (200, same id), it does not add a second", async () => {
    const first = (await manual(good())).body.app;
    const again = await manual(good({ webhookSecret: "second-secret-0123456789" }));
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.app.id).toBe(first.id);
    expect(await count()).toBe(1);
    expect((await loadGithubApp(testPool, KEY, first.id)).webhookSecret).toBe("second-secret-0123456789");
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

describe("projects and installations when apps are added or replaced", () => {
  test("adding another GitHub App leaves the projects of the first, and their installations, alone", async () => {
    const a = (await manual(good())).body.app;
    await addProject("alpha", 21000, a.id, 7);
    await manual(other());
    const row = (await testPool.query("SELECT github_app_id, github_installation_id FROM apps")).rows[0];
    expect([row.github_app_id, Number(row.github_installation_id)]).toEqual([a.id, 7]);
  });

  test("replacing the credentials of the same GitHub App keeps its installations: they are still valid", async () => {
    const a = (await manual(good())).body.app;
    await addProject("alpha", 21000, a.id, 7);
    await manual(good({ webhookSecret: "second-secret-0123456789" }));
    const row = (await testPool.query("SELECT github_app_id, github_installation_id FROM apps")).rows[0];
    expect([row.github_app_id, Number(row.github_installation_id)]).toEqual([a.id, 7]);
  });

  test("a refused attempt leaves everything alone", async () => {
    const a = (await manual(good())).body.app;
    await addProject("alpha", 21000, a.id, 7);
    await manual(other({ password: "not-the-password-xx" }));
    expect(await count()).toBe(1);
    expect(Number((await testPool.query("SELECT github_installation_id FROM apps")).rows[0].github_installation_id)).toBe(7);
  });
});

describe("the webhook uses the stored secrets, live", () => {
  test("until an app is connected it is switched off", async () => {
    const res = await signed({ zen: "x" });
    expect(res.status).toBe(503);
  });

  test("connecting switches it on at once, with no restart", async () => {
    await manual(good());
    expect((await signed({ zen: "x" })).status).toBe(200);
    expect((await signed({ zen: "x" }, "some-other-secret-0123456789")).status).toBe(401);
  });

  test("with two apps, a delivery signed by either is believed, and any other is not", async () => {
    await manual(good());
    await manual(other());
    expect((await signed({ zen: "x" }, SECRET)).status).toBe(200);
    expect((await signed({ zen: "x" }, SECOND)).status).toBe(200);
    expect((await signed({ zen: "x" }, "some-other-secret-0123456789")).status).toBe(401);
  });

  test("replacing the secret changes which signature is accepted, at once", async () => {
    await manual(good());
    await manual(good({ webhookSecret: "second-secret-0123456789" }));
    expect((await signed({ zen: "x" }, SECRET)).status).toBe(401);
    expect((await signed({ zen: "x" }, "second-secret-0123456789")).status).toBe(200);
  });

  test("disconnecting one app stops believing its secret and keeps the other's", async () => {
    const a = (await manual(good())).body.app;
    await manual(other());
    await disconnect(a.id, { password: PASSWORD });
    expect((await signed({ zen: "x" }, SECRET)).status).toBe(401);
    expect((await signed({ zen: "x" }, SECOND)).status).toBe(200);
  });

  test("disconnecting the last one switches it off again", async () => {
    const a = (await manual(good())).body.app;
    await disconnect(a.id, { password: PASSWORD });
    expect((await signed({ zen: "x" })).status).toBe(503);
  });
});

describe("what a refused push leaves for the dashboard is cleared when the app is dealt with", () => {
  const refuse = (appNumber) => {
    const raw = JSON.stringify({ zen: "x" });
    return request(app).post("/api/webhooks/github").set("Content-Type", "application/json").set("X-GitHub-Event", "ping").set("X-GitHub-Delivery", `d-${Math.random().toString(16).slice(2)}-${Date.now()}`.padEnd(20, "0"))
      .set("X-GitHub-Hook-Installation-Target-ID", appNumber).set("X-Hub-Signature-256", `sha256=${createHmac("sha256", "not-the-secret-0123456789").update(raw).digest("hex")}`).send(raw);
  };
  const first = async () => (await status()).body.apps[0];
  beforeEach(() => { jest.spyOn(console, "warn").mockImplementation(() => {}); });

  test("entering the app again, with its secret, clears the warning", async () => {
    await manual(good());
    await refuse("123456");
    expect((await first()).refusedPush).toMatchObject({ count: 1 });
    await manual(good({ webhookSecret: "second-secret-0123456789" }));
    expect((await first()).refusedPush).toBeNull();
  });

  test("a refused attempt to enter it leaves the warning", async () => {
    await manual(good());
    await refuse("123456");
    await manual(good({ password: "not-the-password-xx" }));
    expect((await first()).refusedPush).not.toBeNull();
  });

  test("a push from an app that was not connected stops being unknown once it is connected", async () => {
    await manual(other()); // (with no app connected at all a delivery is a 503, not a wrong signature)
    await refuse("123456");
    expect((await status()).body.unknownSenders).toMatchObject([{ appNumber: "123456" }]);
    await manual(good());
    const body = (await status()).body;
    expect(body.unknownSenders).toEqual([]);
    expect(body.apps.map((x) => x.refusedPush)).toEqual([null, null]);
  });

  test("disconnecting the app forgets what was refused for it, and does not make it an unknown sender", async () => {
    const added = (await manual(good())).body.app;
    await refuse("123456");
    await disconnect(added.id, { password: PASSWORD });
    expect((await status()).body.unknownSenders).toEqual([]);
  });

  test("other senders' entries are left alone", async () => {
    await manual(good());
    await refuse("123456");
    await refuse("777");
    await manual(good({ webhookSecret: "second-secret-0123456789" }));
    expect((await status()).body.unknownSenders).toMatchObject([{ appNumber: "777" }]);
  });
});

describe("with the real cache time (a change must not wait for it)", () => {
  beforeEach(async () => {
    await boot({ "/app": whoAmI }, { ttlMs: 60_000 });
  });

  test("connecting, replacing and disconnecting take effect at once in the same process", async () => {
    expect((await signed({ zen: "x" })).status).toBe(503); // primes the cache with "nothing connected"
    const a = (await manual(good())).body.app;
    expect((await signed({ zen: "x" })).status).toBe(200);
    await manual(good({ webhookSecret: "second-secret-0123456789" }));
    expect((await signed({ zen: "x" }, "second-secret-0123456789")).status).toBe(200);
    await disconnect(a.id, { password: PASSWORD });
    expect((await signed({ zen: "x" }, "second-secret-0123456789")).status).toBe(503);
  });
});

describe("disconnecting one app", () => {
  let a;
  let b;
  beforeEach(async () => {
    a = (await manual(good())).body.app;
    b = (await manual(other())).body.app;
  });

  test("needs a session and the password", async () => {
    expect((await disconnect(a.id, { password: PASSWORD }, null)).status).toBe(401);
    const wrong = await disconnect(a.id, { password: "not-the-password-xx" });
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe("wrong_password");
    expect((await disconnect(a.id, {})).status).toBe(400);
    expect((await status()).body.apps).toHaveLength(2);
  });

  test("removes that app's credentials and only that app's", async () => {
    const res = await disconnect(a.id, { password: PASSWORD });
    expect(res.status).toBe(204);
    expect((await listGithubApps(testPool)).map((x) => x.id)).toEqual([b.id]);
    expect((await status()).body.apps.map((x) => x.id)).toEqual([b.id]);
  });

  test("the projects that used it keep existing, with no GitHub app and no installation; those of the other app are untouched", async () => {
    await addProject("alpha", 21000, a.id, 7);
    await addProject("beta", 21001, b.id, 8);
    await disconnect(a.id, { password: PASSWORD });
    const rows = (await testPool.query("SELECT slug, github_app_id, github_installation_id FROM apps ORDER BY slug")).rows;
    expect(rows.map((r) => [r.slug, r.github_app_id, r.github_installation_id === null ? null : Number(r.github_installation_id)])).toEqual([["alpha", null, null], ["beta", b.id, 8]]);
  });

  test("an app that is not there is a 404 (after the password), not a quiet success", async () => {
    expect((await disconnect(NOBODY, { password: PASSWORD })).status).toBe(404);
    expect((await disconnect("not-an-id", { password: PASSWORD })).status).toBe(404);
    expect((await disconnect(NOBODY, { password: "not-the-password-xx" })).status).toBe(403);
    expect(await count()).toBe(2);
  });

  test("a second disconnect of the same app is a 404", async () => {
    await disconnect(a.id, { password: PASSWORD });
    expect((await disconnect(a.id, { password: PASSWORD })).status).toBe(404);
  });

  test("leaves the projects' deployments alone", async () => {
    await addProject("alpha", 21000, a.id);
    await disconnect(a.id, { password: PASSWORD });
    expect((await testPool.query("SELECT count(*)::int AS n FROM apps")).rows[0].n).toBe(1);
  });

  test("is recorded in the sign-ins list", async () => {
    await disconnect(a.id, { password: PASSWORD });
    const list = (await request(app).get("/api/auth/logins").set("Cookie", cookie)).body.logins;
    expect(list[0]).toMatchObject({ kind: "github", success: true });
  });
});

describe("repositories and installations of one app", () => {
  const REPOS = {
    "/app/installations?per_page=100": ({ app: who }) => ({ json: who === "123456" ? [{ id: 7, account: { login: "tianyu-00" } }] : [{ id: 9, account: { login: "my-org" } }] }),
    "/app/installations/7/access_tokens": () => ({ status: 201, json: { token: "ghs_x", expires_at: new Date(Date.now() + 3600_000).toISOString() } }),
    "/app/installations/9/access_tokens": () => ({ status: 201, json: { token: "ghs_y", expires_at: new Date(Date.now() + 3600_000).toISOString() } }),
    "/installation/repositories?per_page=100": () => ({ json: { repositories: [{ full_name: "tianyu-00/shipdok-test-app", private: true, default_branch: "main" }] } }),
    "/app": whoAmI,
  };
  const get = (path, c = cookie) => request(app).get(path).set("Cookie", c ?? []);

  test("a repository list for an app that is not connected is a 404; for a connected one it is the list", async () => {
    await boot(REPOS);
    expect((await get(`/api/github/apps/${NOBODY}/repos`)).status).toBe(404);
    const a = (await manual(good())).body.app;
    const res = await get(`/api/github/apps/${a.id}/repos`);
    expect(res.status).toBe(200);
    expect(res.body.repos).toEqual([{ fullName: "tianyu-00/shipdok-test-app", private: true, defaultBranch: "main", installationId: 7 }]);
    expect(JSON.stringify(res.body)).not.toContain("ghs_x");
  });

  test("each app lists only what its own installations hold", async () => {
    await boot({
      ...REPOS,
      "/installation/repositories?per_page=100": ({ init }) => ({ json: { repositories: [{ full_name: init.headers.Authorization === "Bearer ghs_x" ? "tianyu-00/mine" : "my-org/theirs", private: true, default_branch: "main" }] } }),
    });
    const a = (await manual(good())).body.app;
    const b = (await manual(other())).body.app;
    expect((await get(`/api/github/apps/${a.id}/repos`)).body.repos.map((r) => r.fullName)).toEqual(["tianyu-00/mine"]);
    expect((await get(`/api/github/apps/${b.id}/repos`)).body.repos.map((r) => r.fullName)).toEqual(["my-org/theirs"]);
    // and they were asked as themselves
    const listings = gh.calls.filter((c) => c.path === "/app/installations?per_page=100").map((c) => c.app);
    expect(listings).toEqual(["123456", "654321"]);
  });

  test("installations: who the app is installed on", async () => {
    await boot(REPOS);
    const a = (await manual(good())).body.app;
    const b = (await manual(other())).body.app;
    expect((await get(`/api/github/apps/${NOBODY}/installations`)).status).toBe(404);
    expect((await get(`/api/github/apps/${a.id}/installations`)).body.installations).toEqual([{ id: 7, account: "tianyu-00" }]);
    expect((await get(`/api/github/apps/${b.id}/installations`)).body.installations).toEqual([{ id: 9, account: "my-org" }]);
  });

  test("a GitHub failure is a 502 with a plain message", async () => {
    await boot({ ...REPOS, "/app/installations?per_page=100": () => ({ status: 500, json: {} }) });
    const a = (await manual(good())).body.app;
    const res = await get(`/api/github/apps/${a.id}/installations`);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/GitHub/);
  });

  test("both need a session", async () => {
    const a = (await manual(good())).body.app;
    expect((await get(`/api/github/apps/${a.id}/repos`, null)).status).toBe(401);
    expect((await get(`/api/github/apps/${a.id}/installations`, null)).status).toBe(401);
  });

  test("an app whose credentials cannot be read says so (409), not that it is missing", async () => {
    const broken = await saveGithubApp(testPool, parseMasterKey("b2".repeat(32)), { appId: "1", name: "Broken", privateKeyPem: PEM, webhookSecret: SECRET, source: "manual" });
    const res = await get(`/api/github/apps/${broken.id}/repos`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("cannot_decrypt");
  });
});

describe("a new project checks whether the chosen GitHub App is installed on its repository", () => {
  test("uses the stored app, with no restart, and asks the app that was chosen", async () => {
    await boot({
      "/app": whoAmI,
      "/repos/tianyu-00/shipdok-test-app/installation": ({ app: who }) => ({ json: { id: who === "123456" ? 7 : 9 } }),
    });
    await manual(good());
    const b = (await manual(other())).body.app;
    const res = await request(app).post("/api/apps").set("Cookie", cookie).send({ name: "My app", repo: "tianyu-00/shipdok-test-app", container_port: 3000, github_app_id: b.id });
    expect(res.status).toBe(201);
    expect(res.body.github_installation_id).toBe(9);
    expect(res.body.github_app_id).toBe(b.id);
  });
});
