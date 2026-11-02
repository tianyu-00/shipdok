import request from "supertest";
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from "./helpers.js";
import { recordAudit, change, fact } from "../src/audit.js";

let app;
let cookie;
beforeEach(async () => {
  await resetDb();
  app = await makeApp();
  const setup = await request(app).post("/api/auth/setup").send({ username: "admin", password: PASSWORD });
  cookie = setup.headers["set-cookie"];
});
afterAll(closeDb);

const get = (query = "", c = cookie) => request(app).get(`/api/audit${query}`).set("Cookie", c);
const add = (extra = {}) => recordAudit(testPool, { category: "security", action: "x", summary: "Something", actor: "admin", address: "1.2.3.4", ...extra });

describe("the activity log route", () => {
  test("needs a session", async () => {
    expect((await request(app).get("/api/audit")).status).toBe(401);
  });

  test("lists entries newest first with their details, who, where from and the app", async () => {
    await add({ summary: "first", details: [change("Mode", "Local", "Full")] });
    await add({ summary: "second", category: "github", details: [fact("App", "Shipdok-ab12")], appName: "blog" });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e) => e.summary)).toEqual(["second", "first"]);
    expect(res.body.entries[1].details).toEqual([{ label: "Mode", from: "Local", to: "Full" }]);
    expect(res.body.entries[0]).toMatchObject({ category: "github", actor: "admin", address: "1.2.3.4", source: "user", appName: "blog", appId: null, details: [{ label: "App", value: "Shipdok-ab12" }] });
    expect(typeof res.body.entries[0].id).toBe("string");
    expect(res.body.keepDays).toBe(30);
  });

  test("an entry with no details has an empty list", async () => {
    await add();
    expect((await get()).body.entries[0].details).toEqual([]);
  });

  test("limit is honoured and capped at 500", async () => {
    await testPool.query(`INSERT INTO audit_log (category, action, summary, actor, address) SELECT 'security', 'x', 'row ' || g, 'admin', '1.2.3.4' FROM generate_series(1, 600) g`);
    expect((await get("?limit=3")).body.entries).toHaveLength(3);
    expect((await get("?limit=1000")).body.entries).toHaveLength(500);
    expect((await get("?limit=abc")).body.entries).toHaveLength(20);
  });

  test("a category narrows the list, and an unknown one is a 400", async () => {
    await add({ category: "security", summary: "a" });
    await add({ category: "github", summary: "b" });
    await add({ category: "backups", summary: "c" });
    expect((await get("?category=github")).body.entries.map((e) => e.summary)).toEqual(["b"]);
    expect((await get("?category=backups")).body.entries.map((e) => e.summary)).toEqual(["c"]);
    expect((await get("?category=nothing")).status).toBe(400);
  });

  test("a search finds a part of the summary in any case; % and _ are plain characters", async () => {
    await add({ summary: "Public access changed: Local only → Full" });
    await add({ summary: "100% sure" });
    await add({ summary: "a_b" });
    expect((await get("?q=LOCAL")).body.entries.map((e) => e.summary)).toEqual(["Public access changed: Local only → Full"]);
    expect((await get("?q=%25")).body.entries.map((e) => e.summary)).toEqual(["100% sure"]); // only the one that has a percent sign
    expect((await get("?q=a_b")).body.entries).toHaveLength(1);
    expect((await get("?q=" + "x".repeat(101))).status).toBe(400);
    expect((await get("?q=nomatch")).body.entries).toEqual([]);
  });

  test("a search and a category work together", async () => {
    await add({ category: "github", summary: "App one" });
    await add({ category: "security", summary: "App two" });
    expect((await get("?category=github&q=app")).body.entries.map((e) => e.summary)).toEqual(["App one"]);
  });

  test("what Shipdok did by itself is left out unless asked for", async () => {
    await add({ summary: "mine" });
    await add({ summary: "push", source: "webhook" });
    await add({ summary: "nightly", source: "schedule" });
    expect((await get()).body.entries.map((e) => e.summary)).toEqual(["mine"]);
    expect((await get("?automatic=1")).body.entries.map((e) => e.summary)).toEqual(["nightly", "push", "mine"]);
  });
});

describe("recording an entry", () => {
  test("refuses a category or a source that does not exist, and the database does too", async () => {
    await expect(add({ category: "nope" })).rejects.toThrow(/category/);
    await expect(add({ source: "nope" })).rejects.toThrow(/source/);
    await expect(testPool.query("INSERT INTO audit_log (category, action, summary, actor, address) VALUES ('nope', 'x', 'x', 'a', 'b')")).rejects.toThrow();
  });

  test("keeps at most 20 details, each text at most 300 characters", async () => {
    await add({ details: Array.from({ length: 30 }, (_, i) => fact(`F${i}`, "v".repeat(500))) });
    const { entries } = (await get()).body;
    expect(entries[0].details).toHaveLength(20);
    expect(entries[0].details[0].value).toHaveLength(300);
  });

  test("removes entries older than the kept time when something new is recorded", async () => {
    await testPool.query(`INSERT INTO audit_log (at, category, action, summary, actor, address) VALUES (now() - interval '31 days', 'security', 'x', 'old', 'admin', '1.2.3.4')`);
    await add({ summary: "new" });
    expect((await get("?limit=50")).body.entries.map((e) => e.summary)).toEqual(["new"]);
  });
});
