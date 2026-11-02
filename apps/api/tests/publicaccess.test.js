import request from "supertest";
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from "./helpers.js";
import { config } from "../src/config.js";
import { normalizePublicUrl } from "../src/settings.js";

let app;
let cookie;
beforeEach(async () => {
  await resetDb();
  await testPool.query("DELETE FROM settings");
  config.publicModeEnv = null;
  config.publicUrlEnv = null;
  app = await makeApp();
  const res = await request(app).post("/api/auth/setup").send({ username: "admin", password: PASSWORD });
  cookie = res.headers["set-cookie"];
  await testPool.query("DELETE FROM login_attempts");
});
afterAll(async () => {
  config.publicModeEnv = null;
  config.publicUrlEnv = null;
  await closeDb();
});

const OUTSIDE = { "X-Forwarded-For": "203.0.113.9" }; // a trusted proxy (loopback in tests) reporting a public client
const HOME = { "X-Forwarded-For": "192.168.1.20" };
const setMode = async (mode, extra = {}) => {
  const res = await request(app).put("/api/settings/public").set("Cookie", cookie).send({ password: PASSWORD, mode, ...extra });
  expect(res.status).toBe(200);
  return res;
};
const get = (path, headers = {}, c) => request(app).get(path).set(headers).set("Cookie", c ?? []);
const post = (path, headers = {}, body = {}) => request(app).post(path).set(headers).send(body);
const NOT_FOUND = { error: "Not found" };

describe("normalizePublicUrl", () => {
  test.each([
    ["https://shipdok.example.com", "https://shipdok.example.com"],
    ["https://shipdok.example.com/", "https://shipdok.example.com"],
    ["HTTPS://Shipdok.Example.com", "https://shipdok.example.com"],
    ["http://192.168.1.5:8080", "http://192.168.1.5:8080"],
    ["https://shipdok.example.com:443", "https://shipdok.example.com"],
    ["  https://shipdok.example.com  ", "https://shipdok.example.com"],
  ])("%s is accepted as %s", (given, shown) => expect(normalizePublicUrl(given)).toEqual({ ok: true, value: shown }));

  test.each([
    "shipdok.example.com", "ftp://shipdok.example.com", "javascript:alert(1)", "https://user:pw@shipdok.example.com", "https://shipdok.example.com/path",
    "https://shipdok.example.com/?a=1", "https://shipdok.example.com/#x", "https://", "http://", "://x", "https://exa mple.com", "https://" + "a".repeat(300) + ".com", 12345, null,
  ])("%s is refused", (given) => expect(normalizePublicUrl(given).ok).toBe(false));

  test("empty means 'none'", () => expect(normalizePublicUrl("")).toEqual({ ok: true, value: "" }));
});

describe("local is the default: outside visitors get nothing", () => {
  test("every path, the webhook included, is a plain 404", async () => {
    for (const [method, path] of [["get", "/health"], ["get", "/api/auth/status"], ["post", "/api/auth/login"], ["post", "/api/webhooks/github"], ["get", "/api/webhooks/deliveries"], ["get", "/nope"]]) {
      const res = await request(app)[method](path).set(OUTSIDE).send({});
      expect([method, path, res.status]).toEqual([method, path, 404]);
      expect(res.body).toEqual(NOT_FOUND);
    }
  });

  test("the 404 looks exactly like an unknown route (nothing says that Shipdok is here)", async () => {
    const hidden = await get("/api/auth/status", OUTSIDE);
    const unknown = await get("/nope", HOME);
    expect(hidden.body).toEqual(unknown.body);
    expect(hidden.status).toBe(unknown.status);
  });

  test("visitors on the local network and on this machine get everything", async () => {
    expect((await get("/api/auth/status")).status).toBe(200);
    expect((await get("/api/auth/status", HOME)).status).toBe(200);
    expect((await post("/api/webhooks/github", HOME)).status).not.toBe(404);
  });

  test("a stranger cannot pretend to be local by sending a private address in the header", async () => {
    // the proxy appends the real address on the right: the right-most untrusted entry is who connected
    const res = await get("/api/auth/status", { "X-Forwarded-For": "192.168.1.20, 203.0.113.9" });
    expect(res.status).toBe(404);
  });

  test("forwarding headers without an X-Forwarded-For (no client address) fail closed", async () => {
    expect((await get("/api/auth/status", { "CF-Connecting-IP": "203.0.113.9" })).status).toBe(404);
    expect((await get("/api/auth/status", { "X-Real-IP": "192.168.1.20" })).status).toBe(404);
  });
});

describe("webhook mode: from outside only the webhook", () => {
  beforeEach(async () => { await setMode("webhook"); });

  test("POST /api/webhooks/github gets through (and is judged by its signature)", async () => {
    const res = await post("/api/webhooks/github", OUTSIDE, {});
    expect(res.status).not.toBe(404);
    expect([400, 401, 403]).toContain(res.status);
  });

  test.each([
    ["get", "/api/webhooks/github"], ["put", "/api/webhooks/github"], ["post", "/api/webhooks/github/x"], ["post", "/api/webhooks/githubx"],
    ["get", "/api/webhooks/deliveries"], ["get", "/api/auth/status"], ["post", "/api/auth/login"], ["post", "/api/auth/recover"],
    ["get", "/api/apps"], ["get", "/health"], ["get", "/api/settings/public"], ["get", "/nope"],
  ])("%s %s is 404", async (method, path) => {
    const res = await request(app)[method](path).set(OUTSIDE).send({});
    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND);
  });

  test("with a query string the path is still the webhook", async () => {
    expect((await post("/api/webhooks/github?x=1", OUTSIDE, {})).status).not.toBe(404);
  });

  test("an outside visitor holding a valid session still gets nothing but the webhook", async () => {
    expect((await get("/api/auth/me", OUTSIDE, cookie)).status).toBe(404);
  });

  test("local visitors keep the whole dashboard", async () => {
    expect((await get("/api/auth/me", HOME, cookie)).status).toBe(200);
    expect((await get("/api/apps", {}, cookie)).status).toBe(200);
  });
});

describe("full mode", () => {
  beforeEach(async () => { await setMode("full"); });

  test("outside visitors can use the dashboard API like anyone else", async () => {
    expect((await get("/api/auth/status", OUTSIDE)).status).toBe(200);
    const login = await post("/api/auth/login", OUTSIDE, { username: "admin", password: PASSWORD });
    expect(login.status).toBe(200);
    expect((await get("/api/auth/me", OUTSIDE, login.headers["set-cookie"])).status).toBe(200);
  });

  test("the address that counts for the lockout is the outside visitor's, not the proxy's", async () => {
    for (let i = 0; i < 5; i++) await post("/api/auth/login", OUTSIDE, { username: "admin", password: "wrong-password-123" });
    expect((await post("/api/auth/login", OUTSIDE, { username: "admin", password: PASSWORD })).status).toBe(429);
    const { rows } = await testPool.query("SELECT DISTINCT address FROM login_attempts WHERE NOT success");
    expect(rows.map((r) => r.address)).toEqual(["203.0.113.9"]);
  });
});

describe("the public host name", () => {
  beforeEach(async () => { await setMode("webhook", { publicUrl: "https://shipdok.example.com" }); });

  test("a request for it that no proxy vouched for is outside, even from a private address", async () => {
    const res = await request(app).get("/api/auth/status").set("Host", "shipdok.example.com");
    expect(res.status).toBe(404);
  });

  test("a proxy that vouches for a local visitor is believed", async () => {
    const res = await request(app).get("/api/auth/status").set("Host", "shipdok.example.com").set(HOME);
    expect(res.status).toBe(200);
  });

  test("the dashboard's web server says whether the visitor's request carried an address of its own", async () => {
    const host = (proxied) => request(app).get("/api/auth/status").set("Host", "shipdok.example.com").set(HOME).set("X-Shipdok-Proxied", proxied);
    expect((await host("0")).status).toBe(404); // the address was added by the web server itself: nobody vouched
    expect((await host("1")).status).toBe(200);
  });

  test("other names are not affected", async () => {
    expect((await request(app).get("/api/auth/status").set("Host", "localhost:8080")).status).toBe(200);
  });
});

describe("the visitor check used by the dashboard's web server", () => {
  const visitor = (headers = {}) => request(app).get("/api/_visitor").set(headers);

  test("local mode: only local visitors are let in", async () => {
    expect((await visitor()).status).toBe(204);
    expect((await visitor(HOME)).status).toBe(204);
    expect((await visitor(OUTSIDE)).status).toBe(403);
  });

  test("webhook mode: still only local visitors may be served the dashboard pages", async () => {
    await setMode("webhook");
    expect((await visitor(HOME)).status).toBe(204);
    expect((await visitor(OUTSIDE)).status).toBe(403);
  });

  test("full mode: everyone", async () => {
    await setMode("full");
    expect((await visitor(OUTSIDE)).status).toBe(204);
  });

  test("it answers without needing a session and without a body", async () => {
    const res = await visitor();
    expect(res.text).toBe("");
  });
});

describe("the settings", () => {
  const put = (body, c = cookie) => request(app).put("/api/settings/public").set("Cookie", c ?? []).send(body);

  test("need a session", async () => {
    expect((await request(app).get("/api/settings/public")).status).toBe(401);
    expect((await put({ password: PASSWORD, mode: "full" }, null)).status).toBe(401);
  });

  test("start as local with no address", async () => {
    const res = await get("/api/settings/public", {}, cookie);
    expect(res.body).toEqual({ mode: "local", publicUrl: "", modeLocked: false, urlLocked: false, visitor: "local" });
  });

  test("say whether THIS request counts as local or outside", async () => {
    await setMode("full");
    expect((await get("/api/settings/public", OUTSIDE, cookie)).body.visitor).toBe("outside");
    expect((await get("/api/settings/public", HOME, cookie)).body.visitor).toBe("local");
  });

  test("a change needs the current password", async () => {
    const none = await put({ mode: "full" });
    expect(none.status).toBe(400);
    const wrong = await put({ password: "not-the-password-xx", mode: "full" });
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe("wrong_password");
    expect((await get("/api/settings/public", {}, cookie)).body.mode).toBe("local");
  });

  test("sets the mode and the address, which take effect at once", async () => {
    const res = await put({ password: PASSWORD, mode: "webhook", publicUrl: "https://shipdok.example.com/" });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("webhook");
    expect(res.body.publicUrl).toBe("https://shipdok.example.com");
    expect((await get("/api/auth/status", OUTSIDE)).status).toBe(404);
    expect((await post("/api/webhooks/github", OUTSIDE)).status).not.toBe(404);
  });

  test("a field that is left out is left alone; an empty address clears it", async () => {
    await put({ password: PASSWORD, mode: "full", publicUrl: "https://shipdok.example.com" });
    await put({ password: PASSWORD, mode: "webhook" });
    expect((await get("/api/settings/public", {}, cookie)).body).toMatchObject({ mode: "webhook", publicUrl: "https://shipdok.example.com" });
    await put({ password: PASSWORD, publicUrl: "" });
    expect((await get("/api/settings/public", {}, cookie)).body).toMatchObject({ mode: "webhook", publicUrl: "" });
  });

  test("the mode can be chosen without an address", async () => {
    expect((await put({ password: PASSWORD, mode: "full" })).status).toBe(200);
  });

  test.each([["mode", "everything"], ["mode", 5], ["publicUrl", "not a url"], ["publicUrl", "https://x.example.com/path"], ["publicUrl", 5]])("a bad %s (%s) is refused and nothing changes", async (field, value) => {
    const res = await put({ password: PASSWORD, [field]: value });
    expect(res.status).toBe(400);
    expect((await get("/api/settings/public", {}, cookie)).body).toMatchObject({ mode: "local", publicUrl: "" });
  });

  test("nothing to change is a 400", async () => {
    expect((await put({ password: PASSWORD })).status).toBe(400);
  });

  test("every change is recorded in the activity log, with what it was before and after", async () => {
    await put({ password: PASSWORD, mode: "full" });
    const list = (await get("/api/audit", {}, cookie)).body.entries;
    expect(list[0]).toMatchObject({ category: "security", action: "public_access", actor: "admin", summary: "Public access changed: Local only → Full" });
    expect(list[0].details).toEqual([{ label: "Who may reach Shipdok", from: "Local only", to: "Full" }]);
    await put({ password: PASSWORD, mode: "full" });
    expect((await get("/api/audit", {}, cookie)).body.entries[0].summary).toBe("Public access saved, nothing changed");
  });

  test("a wrong password is not recorded as a change", async () => {
    await put({ password: "nope-nope-nope-1", mode: "full" });
    const list = (await get("/api/audit", {}, cookie)).body.entries;
    expect(list.some((l) => l.category === "security")).toBe(false);
  });

  test("a wrong password is limited like the other password checks", async () => {
    for (let i = 0; i < 10; i++) expect((await put({ password: "nope-nope-nope-1", mode: "full" })).status).toBe(403);
    expect((await put({ password: "nope-nope-nope-1", mode: "full" })).status).toBe(429);
  });
});

describe("the environment wins", () => {
  const put = (body) => request(app).put("/api/settings/public").set("Cookie", cookie).send({ password: PASSWORD, ...body });

  test("SHIPDOK_PUBLIC sets the mode whatever the database says, and the dashboard is told it is locked", async () => {
    await setMode("full");
    config.publicModeEnv = "local";
    expect((await get("/api/auth/status", OUTSIDE)).status).toBe(404);
    const s = (await get("/api/settings/public", {}, cookie)).body;
    expect(s).toMatchObject({ mode: "local", modeLocked: true });
  });

  test("PUBLIC_URL sets the address and locks it", async () => {
    config.publicUrlEnv = "https://env.example.com";
    const s = (await get("/api/settings/public", {}, cookie)).body;
    expect(s).toMatchObject({ publicUrl: "https://env.example.com", urlLocked: true });
  });

  test("a locked setting cannot be changed from the dashboard (409), the other still can", async () => {
    config.publicModeEnv = "webhook";
    const res = await put({ mode: "full" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("locked_by_environment");
    expect((await put({ publicUrl: "https://shipdok.example.com" })).status).toBe(200);
  });

  test("sending a locked field with the value it already has is not an error", async () => {
    config.publicModeEnv = "webhook";
    expect((await put({ mode: "webhook", publicUrl: "https://shipdok.example.com" })).status).toBe(200);
  });
});

describe("the allowed origins", () => {
  const login = (origin) => request(app).post("/api/auth/login").set("Origin", origin).send({ username: "admin", password: PASSWORD });

  test("the public address is added to the dashboard's own, and the local one stays", async () => {
    expect((await login("https://shipdok.example.com")).status).toBe(403);
    await setMode("full", { publicUrl: "https://shipdok.example.com" });
    expect((await login("https://shipdok.example.com")).status).toBe(200);
    expect((await login("http://localhost:5173")).status).toBe(200);
    expect((await login("https://evil.example.com")).status).toBe(403);
  });

  test("clearing the address removes it again", async () => {
    await setMode("full", { publicUrl: "https://shipdok.example.com" });
    await setMode("full", { publicUrl: "" });
    expect((await login("https://shipdok.example.com")).status).toBe(403);
  });

  test("the environment's address counts too", async () => {
    config.publicUrlEnv = "https://env.example.com";
    expect((await login("https://env.example.com")).status).toBe(200);
  });
});
