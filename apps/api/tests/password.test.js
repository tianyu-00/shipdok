import request from "supertest";
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from "./helpers.js";

let app;
beforeEach(async () => {
  await resetDb();
  app = await makeApp();
  await request(app).post("/api/auth/setup").send({ username: "admin", password: PASSWORD });
});
afterAll(closeDb);

const NEW = "another-long-password-1";
const login = async (password = PASSWORD) => (await request(app).post("/api/auth/login").send({ username: "admin", password })).headers["set-cookie"];
const change = (cookie, body) => request(app).post("/api/auth/password").set("Cookie", cookie ?? []).send(body);

describe("changing the password", () => {
  test("needs a session", async () => {
    const res = await change(null, { currentPassword: PASSWORD, newPassword: NEW });
    expect(res.status).toBe(401);
  });

  test("works with the right current password: the new one logs in, the old one no longer does", async () => {
    const cookie = await login();
    const res = await change(cookie, { currentPassword: PASSWORD, newPassword: NEW });
    expect(res.status).toBe(204);
    expect((await request(app).post("/api/auth/login").send({ username: "admin", password: PASSWORD })).status).toBe(401);
    expect((await request(app).post("/api/auth/login").send({ username: "admin", password: NEW })).status).toBe(200);
  });

  test("a wrong current password changes nothing and is not a 401 (that would look like an ended session)", async () => {
    const cookie = await login();
    const res = await change(cookie, { currentPassword: "not-the-password-xx", newPassword: NEW });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/current password/i);
    expect((await request(app).post("/api/auth/login").send({ username: "admin", password: PASSWORD })).status).toBe(200);
    expect((await request(app).post("/api/auth/login").send({ username: "admin", password: NEW })).status).toBe(401);
  });

  test.each([
    ["too short", "short"],
    ["too long", "x".repeat(257)],
    ["not a string", 123456789012],
    ["the same as now", PASSWORD],
  ])("refuses a new password that is %s", async (_, newPassword) => {
    const cookie = await login();
    const res = await change(cookie, { currentPassword: PASSWORD, newPassword });
    expect(res.status).toBe(400);
    expect((await request(app).post("/api/auth/login").send({ username: "admin", password: PASSWORD })).status).toBe(200);
  });

  test("applies the same policy as setup: patterns, runs and the username are refused", async () => {
    const cookie = await login();
    for (const newPassword of ["123456789012", "abababababababab", "my-admin-secret-phrase"]) {
      const res = await change(cookie, { currentPassword: PASSWORD, newPassword });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("weak_password");
    }
    expect((await request(app).post("/api/auth/login").send({ username: "admin", password: PASSWORD })).status).toBe(200);
  });

  test("refuses a request without both fields", async () => {
    const cookie = await login();
    expect((await change(cookie, { newPassword: NEW })).status).toBe(400);
    expect((await change(cookie, { currentPassword: PASSWORD })).status).toBe(400);
    expect((await change(cookie, {})).status).toBe(400);
  });

  test("ends every OTHER session but keeps this one signed in", async () => {
    const mine = await login();
    const other = await login();
    const res = await change(mine, { currentPassword: PASSWORD, newPassword: NEW });
    expect(res.status).toBe(204);
    expect((await request(app).get("/api/auth/me").set("Cookie", other)).status).toBe(401);
    // the answer carries the (renewed) cookie of this session, and it works
    const renewed = res.headers["set-cookie"];
    expect(renewed).toBeDefined();
    expect((await request(app).get("/api/auth/me").set("Cookie", renewed)).status).toBe(200);
    // the cookie from before the change is no longer valid (new session id after a privilege change)
    expect((await request(app).get("/api/auth/me").set("Cookie", mine)).status).toBe(401);
  });

  test("stores an argon2id hash, never the password", async () => {
    const cookie = await login();
    await change(cookie, { currentPassword: PASSWORD, newPassword: NEW });
    const { rows } = await testPool.query("SELECT password_hash FROM users");
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(rows[0].password_hash).not.toContain(NEW);
  });

  test("is limited after repeated tries, wrong ones included", async () => {
    const cookie = await login();
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await change(cookie, { currentPassword: "wrong-password-123", newPassword: NEW })).status);
    expect(codes.slice(0, 10).every((c) => c === 403)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });

  test("a foreign origin is refused", async () => {
    const cookie = await login();
    const res = await request(app).post("/api/auth/password").set("Cookie", cookie).set("Origin", "http://evil.example").send({ currentPassword: PASSWORD, newPassword: NEW });
    expect(res.status).toBe(403);
    expect((await request(app).post("/api/auth/login").send({ username: "admin", password: NEW })).status).toBe(401);
  });

  test("a session past its absolute lifetime cannot change it", async () => {
    const cookie = await login();
    await testPool.query(`UPDATE "session" SET sess = jsonb_set(sess::jsonb, '{createdAt}', to_jsonb($1::bigint))::json`, [Date.now() - 13 * 60 * 60 * 1000]);
    const res = await change(cookie, { currentPassword: PASSWORD, newPassword: NEW });
    expect(res.status).toBe(401);
    expect((await request(app).post("/api/auth/login").send({ username: "admin", password: NEW })).status).toBe(401);
  });

  test("a session whose user no longer exists is refused", async () => {
    const cookie = await login();
    await testPool.query("DELETE FROM users");
    expect((await change(cookie, { currentPassword: PASSWORD, newPassword: NEW })).status).toBe(401);
  });
});
