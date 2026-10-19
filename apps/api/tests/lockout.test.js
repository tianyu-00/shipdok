import request from "supertest";
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from "./helpers.js";
import { waitSeconds, FREE_TRIES, ACCOUNT_CAP_SECONDS, ADDRESS_CAP_SECONDS } from "../src/lockout.js";

let app;
beforeEach(async () => {
  await resetDb();
  app = await makeApp();
  await request(app).post("/api/auth/setup").send({ username: "admin", password: PASSWORD });
  await testPool.query("DELETE FROM login_attempts"); // the setup entry is covered elsewhere
});
afterAll(closeDb);

const attempt = (password, username = "admin", a = app) => request(a).post("/api/auth/login").send({ username, password });
const wrong = async (n, username = "admin", a = app) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push((await attempt("wrong-password-123", username, a)).status);
  return out;
};
const ago = (seconds) => testPool.query("UPDATE login_attempts SET at = at - ($1 || ' seconds')::interval", [String(seconds)]);

describe("the wait schedule", () => {
  test("nothing for the first few failures, then it doubles up to a cap", () => {
    expect(FREE_TRIES).toBe(4);
    expect([1, 2, 3, 4].map((n) => waitSeconds(n, 900))).toEqual([0, 0, 0, 0]);
    expect([5, 6, 7, 8, 9, 10].map((n) => waitSeconds(n, 900))).toEqual([30, 60, 120, 240, 480, 900]);
    expect(waitSeconds(40, 900)).toBe(900);
    expect(waitSeconds(40, 3600)).toBe(3600);
  });

  test("an account is never locked longer than 15 minutes, an address never longer than an hour", () => {
    expect(ACCOUNT_CAP_SECONDS).toBe(900);
    expect(ADDRESS_CAP_SECONDS).toBe(3600);
  });
});

describe("progressive lockout", () => {
  test("five wrong tries are answered normally, the sixth is refused with the wait", async () => {
    expect(await wrong(5)).toEqual([401, 401, 401, 401, 401]);
    const res = await attempt("wrong-password-123");
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("locked");
    expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(res.body.retryAfterSeconds).toBeLessThanOrEqual(30);
    expect(res.headers["retry-after"]).toBe(String(res.body.retryAfterSeconds));
    expect(res.body.error).toMatch(/try again in \d+ seconds/i);
  });

  test("while locked even the RIGHT password is refused, and the refused tries are not counted", async () => {
    await wrong(5);
    for (let i = 0; i < 3; i++) expect((await attempt(PASSWORD)).status).toBe(429);
    const { rows } = await testPool.query("SELECT count(*)::int AS n FROM login_attempts");
    expect(rows[0].n).toBe(5);
  });

  test("when the wait is over the right password works and clears the count", async () => {
    await wrong(5);
    await ago(31);
    expect((await attempt(PASSWORD)).status).toBe(200);
    expect(await wrong(4)).toEqual([401, 401, 401, 401]); // counting starts again from zero
  });

  test("another failure after the wait doubles it", async () => {
    await wrong(5);
    await ago(31);
    expect((await attempt("wrong-password-123")).status).toBe(401); // 6th failure -> 60 s
    const res = await attempt(PASSWORD);
    expect(res.status).toBe(429);
    expect(res.body.retryAfterSeconds).toBeGreaterThan(30);
    expect(res.body.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  test("the account wait stops growing at 15 minutes", async () => {
    const rows = Array.from({ length: 30 }, () => "('login','admin','10.0.0.9',false)").join(",");
    await testPool.query(`INSERT INTO login_attempts (kind, username, address, success) VALUES ${rows}`);
    const res = await attempt(PASSWORD);
    expect(res.status).toBe(429);
    expect(res.body.retryAfterSeconds).toBeLessThanOrEqual(900);
    expect(res.body.retryAfterSeconds).toBeGreaterThan(890);
  });

  test("failures recorded 'in the future' (by a transaction that began a moment later) do not lock anyone who owes no wait", async () => {
    const rows = Array.from({ length: 4 }, () => "(now() + interval '3 seconds','login','admin','10.0.0.9',false)").join(",");
    await testPool.query(`INSERT INTO login_attempts (at, kind, username, address, success) VALUES ${rows}`);
    expect((await attempt(PASSWORD)).status).toBe(200);
  });

  test("failures older than a day are forgotten: one new failure starts the count again", async () => {
    const rows = Array.from({ length: 30 }, () => "('login','admin','10.0.0.9',false)").join(",");
    await testPool.query(`INSERT INTO login_attempts (kind, username, address, success) VALUES ${rows}`);
    await ago(25 * 3600);
    expect((await attempt("wrong-password-123")).status).toBe(401);
    expect((await attempt(PASSWORD)).status).toBe(200);
  });

  test("failures at an address lock that address for every name", async () => {
    await wrong(5, "someone-else");
    // supertest always connects from the same address, so the address itself is now locked: refused whatever the name
    expect((await attempt(PASSWORD)).status).toBe(429);
  });

  test("a name locked from one address stays locked from another", async () => {
    const rows = Array.from({ length: 6 }, () => "('login','admin','203.0.113.5',false)").join(",");
    await testPool.query(`INSERT INTO login_attempts (kind, username, address, success) VALUES ${rows}`);
    expect((await attempt(PASSWORD)).status).toBe(429); // different address than the failures above
  });

  test("an address with failures for other names is locked, a clean address is not", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => `('login','guess${i}','203.0.113.5',false)`).join(",");
    await testPool.query(`INSERT INTO login_attempts (kind, username, address, success) VALUES ${rows}`);
    expect((await attempt(PASSWORD)).status).toBe(200); // this test's own address is clean
  });

  test("unknown names are counted and locked the same way, with the same answer shape as a real one", async () => {
    expect(await wrong(5, "nobody")).toEqual([401, 401, 401, 401, 401]);
    const unknown = await attempt("x", "nobody");
    expect(unknown.status).toBe(429);
    expect(Object.keys(unknown.body).sort()).toEqual(["code", "error", "retryAfterSeconds"]);
  });

  test("a burst of parallel wrong tries cannot get past the lock", async () => {
    const fresh = await makeApp(); // own rate limiter, so only the lockout can stop them
    const results = await Promise.all(Array.from({ length: 9 }, () => attempt("wrong-password-123", "admin", fresh)));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(4);
    const { rows } = await testPool.query("SELECT count(*)::int AS n FROM login_attempts");
    expect(rows[0].n).toBe(5);
  });
});

describe("recent logins", () => {
  const list = async (cookie, query = "") => request(app).get(`/api/auth/logins${query}`).set("Cookie", cookie);

  test("needs a session", async () => {
    expect((await request(app).get("/api/auth/logins")).status).toBe(401);
  });

  test("lists good and bad tries, newest first, with the address and no password data", async () => {
    await attempt("wrong-password-123");
    await attempt("wrong-password-123", "nobody");
    const ok = await attempt(PASSWORD);
    const res = await list(ok.headers["set-cookie"]);
    expect(res.status).toBe(200);
    expect(res.body.logins.map((l) => [l.username, l.success, l.kind])).toEqual([
      ["admin", true, "login"],
      ["nobody", false, "login"],
      ["admin", false, "login"],
    ]);
    expect(res.body.logins[0].address).toMatch(/127\.0\.0\.1/);
    expect(res.body.logins[0].at).toBeDefined();
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);
  });

  test("the first-run setup shows as a sign-in", async () => {
    await resetDb();
    const setup = await request(app).post("/api/auth/setup").send({ username: "admin", password: PASSWORD });
    const res = await list(setup.headers["set-cookie"]);
    expect(res.body.logins.map((l) => [l.kind, l.success])).toEqual([["setup", true]]);
  });

  test("limit is honoured and capped at 100", async () => {
    const ok = await attempt(PASSWORD);
    await testPool.query(`INSERT INTO login_attempts (kind, username, address, success) SELECT 'login','admin','1.2.3.4',true FROM generate_series(1,150)`);
    const cookie = ok.headers["set-cookie"];
    expect((await list(cookie, "?limit=3")).body.logins).toHaveLength(3);
    expect((await list(cookie, "?limit=1000")).body.logins).toHaveLength(100);
    expect((await list(cookie, "?limit=abc")).body.logins).toHaveLength(20);
  });

  test("entries older than 30 days are deleted when a new attempt is recorded", async () => {
    await testPool.query(`INSERT INTO login_attempts (at, kind, username, address, success) VALUES (now() - interval '31 days','login','old','1.1.1.1',false)`);
    await attempt(PASSWORD);
    const { rows } = await testPool.query("SELECT count(*)::int AS n FROM login_attempts WHERE username = 'old'");
    expect(rows[0].n).toBe(0);
  });
});

describe("sign out everywhere", () => {
  test("needs a session", async () => {
    expect((await request(app).post("/api/auth/logout-all")).status).toBe(401);
  });

  test("ends every session, this one included", async () => {
    const a = (await attempt(PASSWORD)).headers["set-cookie"];
    const b = (await attempt(PASSWORD)).headers["set-cookie"];
    const res = await request(app).post("/api/auth/logout-all").set("Cookie", a);
    expect(res.status).toBe(204);
    expect((await request(app).get("/api/auth/me").set("Cookie", a)).status).toBe(401);
    expect((await request(app).get("/api/auth/me").set("Cookie", b)).status).toBe(401);
    const { rows } = await testPool.query(`SELECT count(*)::int AS n FROM "session"`);
    expect(rows[0].n).toBe(0);
  });
});
