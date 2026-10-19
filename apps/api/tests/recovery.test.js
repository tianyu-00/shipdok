import request from "supertest";
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from "./helpers.js";
import { generateCodes, normalizeCode, hashCode, CODE_COUNT } from "../src/recovery.js";
import { resetAdminPassword } from "../src/resetpassword.js";
import { passwordProblem } from "@shipdok/shared";

let app;
let codes;
let cookie;
beforeEach(async () => {
  await resetDb();
  app = await makeApp();
  const res = await request(app).post("/api/auth/setup").send({ username: "admin", password: PASSWORD });
  codes = res.body.recoveryCodes;
  cookie = res.headers["set-cookie"];
  await testPool.query("DELETE FROM login_attempts");
});
afterAll(closeDb);

const NEW = "a-brand-new-long-password";
const recover = (body, a = app) => request(a).post("/api/auth/recover").send({ username: "admin", newPassword: NEW, ...body });
const login = (password) => request(app).post("/api/auth/login").send({ username: "admin", password });

describe("the codes themselves", () => {
  test("ten different codes, 16 characters in groups of four, from an alphabet without look-alikes", () => {
    const made = generateCodes();
    expect(CODE_COUNT).toBe(10);
    expect(made).toHaveLength(10);
    expect(new Set(made).size).toBe(10);
    for (const c of made) expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
  });

  test("a new set differs from the last", () => {
    const a = generateCodes();
    const b = generateCodes();
    expect(a.filter((c) => b.includes(c))).toEqual([]);
  });

  test("typing is forgiving: case, spaces, dashes and look-alike letters", () => {
    const code = "ABCD-EFGH-JKMN-PQRS";
    for (const typed of ["abcd-efgh-jkmn-pqrs", "ABCDEFGHJKMNPQRS", " abcd efgh jkmn pqrs ", "abcd–efgh–jkmn–pqrs"]) {
      expect(normalizeCode(typed)).toBe(normalizeCode(code));
    }
    expect(normalizeCode("0123-4567-89AB-CDEF")).toBe(normalizeCode("o123-4567-89ab-cdef"));
    expect(normalizeCode("1111-1111-1111-1111")).toBe(normalizeCode("iiii-llll-IIII-LLLL"));
  });

  test("anything that cannot be a code is rejected before it is hashed", () => {
    for (const bad of ["", "short", "ABCD-EFGH-JKMN-PQRS-TVWX", "ABCD-EFGH-JKMN-PQR!", null, undefined, 12345, {}]) {
      expect(normalizeCode(bad)).toBeNull();
    }
  });

  test("the hash is stable, and different codes give different hashes", () => {
    const [a, b] = generateCodes();
    expect(hashCode(normalizeCode(a))).toBe(hashCode(normalizeCode(a)));
    expect(hashCode(normalizeCode(a))).not.toBe(hashCode(normalizeCode(b)));
    expect(hashCode(normalizeCode(a))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("creating the account", () => {
  test("hands out ten codes once, and stores only hashes", async () => {
    expect(codes).toHaveLength(10);
    const { rows } = await testPool.query("SELECT code_hash, used_at FROM recovery_codes");
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r.used_at === null)).toBe(true);
    const stored = rows.map((r) => r.code_hash).join(" ");
    for (const c of codes) {
      expect(stored).not.toContain(c);
      expect(stored).not.toContain(normalizeCode(c));
    }
  });

  test("a refused setup creates no codes", async () => {
    await resetDb();
    const res = await request(app).post("/api/auth/setup").send({ username: "admin", password: "abababababababab" });
    expect(res.status).toBe(400);
    expect(res.body.recoveryCodes).toBeUndefined();
    expect((await testPool.query("SELECT count(*)::int AS n FROM recovery_codes")).rows[0].n).toBe(0);
  });
});

describe("the status", () => {
  test("needs a session", async () => {
    expect((await request(app).get("/api/auth/recovery")).status).toBe(401);
  });

  test("says how many are left and when they were made, and never the codes", async () => {
    const res = await request(app).get("/api/auth/recovery").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.remaining).toBe(10);
    expect(res.body.createdAt).toBeDefined();
    expect(JSON.stringify(res.body)).not.toContain(codes[0]);
    await recover({ code: codes[0] });
    const after = await request(app).get("/api/auth/recovery").set("Cookie", cookie);
    // using a code ended that session, so ask again from a new one
    expect(after.status).toBe(401);
    const fresh = (await login(NEW)).headers["set-cookie"];
    expect((await request(app).get("/api/auth/recovery").set("Cookie", fresh)).body.remaining).toBe(9);
  });
});

describe("making a new set", () => {
  const regen = (c, body) => request(app).post("/api/auth/recovery").set("Cookie", c ?? []).send(body);

  test("needs a session and the current password", async () => {
    expect((await regen(null, { password: PASSWORD })).status).toBe(401);
    const wrong = await regen(cookie, { password: "not-the-password-xx" });
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe("wrong_password");
    expect((await regen(cookie, {})).status).toBe(400);
    expect((await testPool.query("SELECT count(*)::int AS n FROM recovery_codes WHERE used_at IS NULL")).rows[0].n).toBe(10);
  });

  test("replaces the old set: the old codes stop working, the new ones work", async () => {
    const res = await regen(cookie, { password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.codes).toHaveLength(10);
    expect(res.body.codes.filter((c) => codes.includes(c))).toEqual([]);
    expect((await testPool.query("SELECT count(*)::int AS n FROM recovery_codes")).rows[0].n).toBe(10);
    expect((await recover({ code: codes[0] })).status).toBe(401);
    expect((await recover({ code: res.body.codes[0] })).status).toBe(200);
  });

  test("a set made after some codes were used is a full set of ten again", async () => {
    await recover({ code: codes[0] });
    const fresh = (await login(NEW)).headers["set-cookie"];
    const res = await regen(fresh, { password: NEW });
    expect(res.body.codes).toHaveLength(10);
    expect((await request(app).get("/api/auth/recovery").set("Cookie", fresh)).body.remaining).toBe(10);
  });

  test("a wrong password is not counted as a login failure but is limited", async () => {
    for (let i = 0; i < 10; i++) expect((await regen(cookie, { password: "nope-nope-nope-1" })).status).toBe(403);
    expect((await regen(cookie, { password: "nope-nope-nope-1" })).status).toBe(429);
  });
});

describe("using a code", () => {
  test("sets the new password, signs in, and the code is spent", async () => {
    const res = await recover({ code: codes[3] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ username: "admin" });
    expect(res.headers["set-cookie"].join(";")).toMatch(/shipdok\.sid=/);
    const me = await request(app).get("/api/auth/me").set("Cookie", res.headers["set-cookie"]);
    expect(me.status).toBe(200);
    expect((await login(PASSWORD)).status).toBe(401);
    expect((await login(NEW)).status).toBe(200);
    // single use
    const again = await recover({ code: codes[3] });
    expect(again.status).toBe(401);
    expect((await login(NEW)).status).toBe(200);
  });

  test("ends every other session", async () => {
    const other = (await login(PASSWORD)).headers["set-cookie"];
    expect((await request(app).get("/api/auth/me").set("Cookie", other)).status).toBe(200);
    await recover({ code: codes[0] });
    expect((await request(app).get("/api/auth/me").set("Cookie", other)).status).toBe(401);
    expect((await request(app).get("/api/auth/me").set("Cookie", cookie)).status).toBe(401);
  });

  test("works however the code is typed", async () => {
    const typed = codes[1].toLowerCase().replace(/-/g, " ");
    expect((await recover({ code: typed })).status).toBe(200);
  });

  test("a wrong code and an unknown name get the same answer", async () => {
    const wrong = await recover({ code: "ABCD-EFGH-JKMN-PQRS" });
    const unknown = await recover({ code: codes[0], username: "nobody" });
    const garbage = await recover({ code: "nonsense" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(garbage.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
    expect(garbage.body).toEqual(wrong.body);
    expect((await login(PASSWORD)).status).toBe(200); // nothing changed
  });

  test("a weak new password is refused WITHOUT spending the code", async () => {
    for (const newPassword of ["short", "abababababababab", "my-admin-secret-phrase", PASSWORD.slice(0, 5)]) {
      const res = await recover({ code: codes[0], newPassword });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("weak_password");
    }
    expect((await recover({ code: codes[0] })).status).toBe(200);
  });

  test("a new password is required", async () => {
    expect((await recover({ code: codes[0], newPassword: undefined })).status).toBe(400);
    expect((await recover({ code: codes[0], newPassword: 12345678901234 })).status).toBe(400);
    expect((await recover({ code: codes[0], username: undefined })).status).toBe(400);
  });

  test("is shown in the recent sign-ins as a recovery code", async () => {
    await recover({ code: "ABCD-EFGH-JKMN-PQRS" });
    const res = await recover({ code: codes[0] });
    const list = await request(app).get("/api/auth/logins").set("Cookie", res.headers["set-cookie"]);
    expect(list.body.logins.map((l) => [l.kind, l.success])).toEqual([["recovery", true], ["recovery", false]]);
  });

  test("two parallel uses of the same code: exactly one wins", async () => {
    const results = await Promise.all([
      recover({ code: codes[5], newPassword: "first-new-long-password" }),
      recover({ code: codes[5], newPassword: "second-new-long-password" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });
});

describe("guessing codes", () => {
  const wrongCode = () => recover({ code: "ABCD-EFGH-JKMN-PQRS" });

  test("is locked like logins: five wrong tries, then a wait, and the right code is refused meanwhile", async () => {
    for (let i = 0; i < 5; i++) expect((await wrongCode()).status).toBe(401);
    const locked = await wrongCode();
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe("locked");
    expect(locked.body.retryAfterSeconds).toBeGreaterThan(0);
    expect((await recover({ code: codes[0] })).status).toBe(429);
    expect((await login(PASSWORD)).status).toBe(429); // the wait is shared with the login form
  });

  test("failed logins count towards the same wait", async () => {
    for (let i = 0; i < 5; i++) await login("wrong-password-123");
    expect((await recover({ code: codes[0] })).status).toBe(429);
  });

  test("a success clears the count", async () => {
    for (let i = 0; i < 3; i++) await wrongCode();
    expect((await recover({ code: codes[0] })).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await wrongCode()).status).toBe(401);
  });
});

describe("the host-side reset", () => {
  test("sets a new random password that follows the rules, and returns it", async () => {
    const out = await resetAdminPassword(testPool);
    expect(out.username).toBe("admin");
    expect(passwordProblem(out.password, { username: "admin" })).toBeNull();
    expect(out.password.length).toBeGreaterThanOrEqual(24);
    expect((await login(PASSWORD)).status).toBe(401);
    expect((await login(out.password)).status).toBe(200);
  });

  test("a different password every time", async () => {
    const a = await resetAdminPassword(testPool);
    const b = await resetAdminPassword(testPool);
    expect(a.password).not.toBe(b.password);
  });

  test("signs everybody out", async () => {
    const other = (await login(PASSWORD)).headers["set-cookie"];
    await resetAdminPassword(testPool);
    expect((await request(app).get("/api/auth/me").set("Cookie", other)).status).toBe(401);
    expect((await request(app).get("/api/auth/me").set("Cookie", cookie)).status).toBe(401);
  });

  test("clears a lockout, so the administrator can get in straight away", async () => {
    for (let i = 0; i < 6; i++) await login("wrong-password-123");
    expect((await login(PASSWORD)).status).toBe(429);
    const out = await resetAdminPassword(testPool);
    expect((await login(out.password)).status).toBe(200);
  });

  test("keeps the failed tries in the list, and records the reset itself", async () => {
    for (let i = 0; i < 6; i++) await login("wrong-password-123");
    const out = await resetAdminPassword(testPool);
    const session = (await login(out.password)).headers["set-cookie"];
    const list = (await request(app).get("/api/auth/logins").set("Cookie", session)).body.logins;
    expect(list.filter((l) => l.kind === "login" && !l.success)).toHaveLength(5); // the sixth was refused, not recorded
    expect(list.some((l) => l.kind === "reset" && l.success && l.address === "host")).toBe(true);
  });

  test("leaves the unused recovery codes alone", async () => {
    await resetAdminPassword(testPool);
    expect((await testPool.query("SELECT count(*)::int AS n FROM recovery_codes WHERE used_at IS NULL")).rows[0].n).toBe(10);
  });

  test("with no administrator yet it says so and changes nothing", async () => {
    await resetDb();
    await expect(resetAdminPassword(testPool)).rejects.toThrow(/no administrator/i);
  });
});
