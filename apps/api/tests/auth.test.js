import request from "supertest";
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from "./helpers.js";

let app;
beforeEach(async () => {
  await resetDb();
  app = await makeApp();
});
afterAll(closeDb);

const setup = (a, body = {}) => a.post("/api/auth/setup").send({ username: "admin", password: PASSWORD, ...body });

describe("health", () => {
  test("/health is ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  test("/health/ready checks the database", async () => {
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(200);
  });
});

describe("first-run setup", () => {
  test("status reports needsSetup until an admin exists", async () => {
    let res = await request(app).get("/api/auth/status");
    expect(res.body).toEqual({ needsSetup: true, authenticated: false });

    await setup(request(app));
    res = await request(app).get("/api/auth/status");
    expect(res.body.needsSetup).toBe(false);
  });

  test("creates the admin, signs them in, and sets a hardened cookie", async () => {
    const res = await setup(request(app));
    expect(res.status).toBe(201);
    expect(res.body.username).toBe("admin");
    expect(res.body.recoveryCodes).toHaveLength(10); // shown once, here

    const cookie = res.headers["set-cookie"].join(";");
    expect(cookie).toMatch(/shipdok\.sid=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const me = await request(app).get("/api/auth/me").set("Cookie", res.headers["set-cookie"]);
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ username: "admin" });
  });

  test("is atomic: concurrent requests create exactly one administrator", async () => {
    const attempts = Array.from({ length: 8 }, (_, i) => setup(request(app), { username: `admin${i}` }));
    const results = await Promise.all(attempts);
    const statuses = results.map((r) => r.status).sort();

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);
    const { rows } = await testPool.query("SELECT count(*)::int AS n FROM users");
    expect(rows[0].n).toBe(1);
  });

  test("a second setup after completion is refused", async () => {
    await setup(request(app));
    const res = await setup(request(app), { username: "other" });
    expect(res.status).toBe(409);
  });

  test("rejects weak credentials without creating a user", async () => {
    const short = await setup(request(app), { password: "short" });
    expect(short.status).toBe(400);
    const pattern = await setup(request(app), { password: "abababababababab" });
    expect(pattern.status).toBe(400);
    expect(pattern.body.error).toMatch(/pattern/i);
    const hasName = await setup(request(app), { username: "administrator", password: "my-administrator-pass" });
    expect(hasName.status).toBe(400);
    expect(hasName.body.error).toMatch(/username/i);
    const badName = await setup(request(app), { username: "a b!" });
    expect(badName.status).toBe(400);
    const { rows } = await testPool.query("SELECT count(*)::int AS n FROM users");
    expect(rows[0].n).toBe(0);
  });

  test("stores an argon2id hash, never the plaintext password", async () => {
    await setup(request(app));
    const { rows } = await testPool.query("SELECT password_hash FROM users");
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(rows[0].password_hash).not.toContain(PASSWORD);
  });
});

describe("login and logout", () => {
  beforeEach(async () => {
    await setup(request(app));
  });

  test("logs in with correct credentials", async () => {
    const res = await request(app).post("/api/auth/login").send({ username: "admin", password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]).toBeDefined();
  });

  test("wrong password and unknown user get the same 401 message", async () => {
    const wrong = await request(app)
      .post("/api/auth/login")
      .send({ username: "admin", password: "wrong-password-123" });
    const unknown = await request(app).post("/api/auth/login").send({ username: "nobody", password: PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  test("logout invalidates the session on the server", async () => {
    const login = await request(app).post("/api/auth/login").send({ username: "admin", password: PASSWORD });
    const cookie = login.headers["set-cookie"];

    const out = await request(app).post("/api/auth/logout").set("Cookie", cookie);
    expect(out.status).toBe(204);

    // Replaying the old cookie must fail: the session row is gone, not just the browser cookie.
    const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(me.status).toBe(401);
  });

  test("protected routes require a session", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });
});

describe("session expiry", () => {
  let cookie;
  beforeEach(async () => {
    const res = await setup(request(app));
    cookie = res.headers["set-cookie"];
  });

  test("a session past its absolute lifetime is rejected", async () => {
    const thirteenHoursAgo = Date.now() - 13 * 60 * 60 * 1000;
    await testPool.query(
      `UPDATE "session" SET sess = jsonb_set(sess::jsonb, '{createdAt}', to_jsonb($1::bigint))::json`,
      [thirteenHoursAgo],
    );
    const res = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(res.status).toBe(401);
  });

  test("a session idle past its inactivity timeout is rejected", async () => {
    await testPool.query(`UPDATE "session" SET expire = now() - interval '1 minute'`);
    const res = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(res.status).toBe(401);
  });

  test("activity renews the sliding expiry", async () => {
    await testPool.query(`UPDATE "session" SET expire = now() + interval '1 minute'`);
    await request(app).get("/api/auth/me").set("Cookie", cookie);
    const { rows } = await testPool.query(`SELECT expire > now() + interval '20 minutes' AS renewed FROM "session"`);
    expect(rows[0].renewed).toBe(true);
  });
});

describe("rate limiting", () => {
  test("setup is limited to 10 tries per client", async () => {
    await setup(request(app));
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await setup(request(app))).status);
    expect(codes.slice(0, 9).every((c) => c === 409)).toBe(true); // 1 used by the first setup above
    expect(codes.slice(9)).toEqual([429, 429, 429]);
  });

  test("a run of wrong logins from one address, each for a different name, is stopped by the lockout", async () => {
    await setup(request(app));
    // Both count by client address, and the lock steps in first (after 5 failures), so these are 429s from the lockout.
    const codes = [];
    for (let i = 0; i < 12; i++) {
      codes.push((await request(app).post("/api/auth/login").send({ username: `nobody${i}`, password: "wrong-password-123" })).status);
    }
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes.slice(5).every((c) => c === 429)).toBe(true);
  });
});

describe("CSRF-sensitive routes", () => {
  test("state-changing requests from a foreign origin are rejected", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("Origin", "http://evil.example")
      .send({ username: "admin", password: PASSWORD });
    expect(res.status).toBe(403);
  });

  test("the dashboard origin is allowed", async () => {
    const res = await request(app).post("/api/auth/login").set("Origin", "http://localhost:5173").send({});
    expect(res.status).toBe(400); // passed the origin check, failed validation
  });

  test("foreign origins can still read safe routes (no cookie-bearing side effects)", async () => {
    const res = await request(app).get("/health").set("Origin", "http://evil.example");
    expect(res.status).toBe(200);
  });
});

describe("error handling", () => {
  test("unknown routes return a JSON 404", async () => {
    const res = await request(app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
  });

  test("malformed JSON is a client error (400), not a server error", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send('{"username": ');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid JSON" });
  });

  test("oversized bodies are rejected with 413", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ username: "admin", password: "x".repeat(200 * 1024) });
    expect(res.status).toBe(413);
  });
});
