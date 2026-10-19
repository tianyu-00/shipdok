import request from "supertest";
import { makeApp, closeDb, resetDb, testPool, PASSWORD, settingsFor } from "./helpers.js";
import { sameOrigin } from "../src/origin.js";

afterAll(closeDb);

describe("sameOrigin (the request's own address, as the browser sees it)", () => {
  const req = (over = {}) => ({ protocol: "http", host: "192.168.1.193:8080", ...over });
  test("an Origin equal to scheme://host[:port] of the request is the same origin", () => {
    expect(sameOrigin(req(), "http://192.168.1.193:8080")).toBe(true);
    expect(sameOrigin(req({ protocol: "https", host: "shipdok.example.com" }), "https://shipdok.example.com")).toBe(true);
  });

  test("case does not matter for the host or the scheme", () => {
    expect(sameOrigin(req({ host: "Shipdok.Example.com" }), "http://shipdok.example.COM:8080".replace(":8080", ""))).toBe(true);
    expect(sameOrigin(req({ protocol: "HTTPS", host: "a.example.com" }), "https://A.example.com")).toBe(true);
  });

  test.each([
    ["another host", "http://evil.example.com"],
    ["another port", "http://192.168.1.193:9090"],
    ["no port when the request has one", "http://192.168.1.193"],
    ["the other scheme", "https://192.168.1.193:8080"],
    ["a host that merely contains it", "http://192.168.1.193:8080.evil.example.com"],
    ["a host with it as a prefix", "http://192.168.1.193:80801"],
    ["a user name trick", "http://192.168.1.193:8080@evil.example.com"],
    ["a path", "http://192.168.1.193:8080/"],
    ["null", "null"],
    ["nothing", ""],
    ["not a string", undefined],
  ])("%s is not", (_, origin) => expect(sameOrigin(req(), origin)).toBe(false));

  test("a request without a host is never the same origin", () => {
    expect(sameOrigin({ protocol: "http", host: undefined }, "http://x")).toBe(false);
    expect(sameOrigin({ protocol: "http", host: "" }, "http://")).toBe(false);
  });
});

describe("the origin check, with WEB_ORIGIN not mentioning this address at all", () => {
  let app;
  let cookie;
  beforeEach(async () => {
    await resetDb();
    await testPool.query("DELETE FROM settings");
    app = await makeApp();
    cookie = (await request(app).post("/api/auth/setup").send({ username: "admin", password: PASSWORD })).headers["set-cookie"];
  });
  const login = (headers) => request(app).post("/api/auth/login").set(headers).send({ username: "admin", password: PASSWORD });

  test("a page served from the same address may make requests", async () => {
    expect((await login({ Host: "192.168.1.193:8080", Origin: "http://192.168.1.193:8080" })).status).toBe(200);
    expect((await login({ Host: "localhost:8080", Origin: "http://localhost:8080" })).status).toBe(200);
  });

  test("a page from another site may not, even when it sends a Host header of its own choosing for another name", async () => {
    expect((await login({ Host: "192.168.1.193:8080", Origin: "http://evil.example.com" })).status).toBe(403);
    expect((await login({ Host: "192.168.1.193:8080", Origin: "null" })).status).toBe(403);
  });

  test("behind a proxy that says the visitor used https, the https address is the same origin and the http one is not", async () => {
    const via = { Host: "shipdok.example.com", "X-Forwarded-Proto": "https", "X-Forwarded-For": "192.168.1.20" };
    expect((await login({ ...via, Origin: "https://shipdok.example.com" })).status).toBe(200);
    expect((await login({ ...via, Origin: "http://shipdok.example.com" })).status).toBe(403);
  });

  test("the address a trusted proxy says it was reached at counts", async () => {
    const via = { Host: "dashboard:80", "X-Forwarded-Host": "shipdok.example.com", "X-Forwarded-Proto": "https", "X-Forwarded-For": "192.168.1.20" };
    expect((await login({ ...via, Origin: "https://shipdok.example.com" })).status).toBe(200);
  });

  test("a proxy that is NOT trusted cannot make up an address", async () => {
    const untrusting = await makeApp({ trustProxy: false, settings: settingsFor("full") }); // full: so that the origin check, not the visitor rule, is what answers
    const res = await request(untrusting).post("/api/auth/login")
      .set({ Host: "192.168.1.193:8080", "X-Forwarded-Host": "evil.example.com", "X-Forwarded-Proto": "https", Origin: "https://evil.example.com" })
      .send({ username: "admin", password: PASSWORD });
    expect(res.status).toBe(403);
  });

  test("requests without an Origin (curl, the webhook) are still let through, as before", async () => {
    expect((await login({})).status).toBe(200);
  });

  test("safe methods are never blocked", async () => {
    expect((await request(app).get("/api/auth/status").set({ Origin: "http://evil.example.com" })).status).toBe(200);
  });

  test("the configured origins and the public address still work too", async () => {
    expect((await login({ Origin: "http://localhost:5173" })).status).toBe(200); // WEB_ORIGIN in the test environment
  });

  test("connecting GitHub accepts the address the dashboard was opened at", async () => {
    const res = await request(app).post("/api/github/connect/start").set("Cookie", cookie).set({ Host: "192.168.1.193:8080", Origin: "http://192.168.1.193:8080" }).send({});
    expect(res.status).toBe(200);
    expect(res.body.manifest.redirect_url).toBe("http://192.168.1.193:8080/api/github/connect/callback");
  });

  test("...and still refuses an Origin that is not this address", async () => {
    const res = await request(app).post("/api/github/connect/start").set("Cookie", cookie).set({ Host: "192.168.1.193:8080" }).set("Origin", "http://evil.example.com").send({});
    expect(res.status).toBe(403);
  });
});
