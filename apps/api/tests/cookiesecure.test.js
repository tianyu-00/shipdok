// COOKIE_SECURE=auto: the Secure flag follows how the request really arrived (https through a trusted proxy), so one install works on plain
// http locally and behind an https proxy. Set before the app (and its config) is first loaded.
process.env.COOKIE_SECURE = "auto";
import request from "supertest";
import { makeApp, resetDb, closeDb, PASSWORD } from "./helpers.js";

let app;
beforeEach(async () => {
  await resetDb();
  app = await makeApp();
});
afterAll(closeDb);

const setup = (headers = {}) => request(app).post("/api/auth/setup").set(headers).send({ username: "admin", password: PASSWORD });

describe("COOKIE_SECURE=auto", () => {
  test("over plain http the cookie is set, without Secure (so it works locally)", async () => {
    const res = await setup();
    expect(res.status).toBe(201);
    const cookie = res.headers["set-cookie"].join(";");
    expect(cookie).toMatch(/shipdok\.sid=/);
    expect(cookie).not.toMatch(/;\s*Secure/i);
  });

  test("when a trusted proxy says the visitor used https, the cookie is Secure", async () => {
    const res = await setup({ "X-Forwarded-Proto": "https", "X-Forwarded-For": "192.168.1.20" });
    expect(res.status).toBe(201);
    expect(res.headers["set-cookie"].join(";")).toMatch(/;\s*Secure/i);
  });
});
