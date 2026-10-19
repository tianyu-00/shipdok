import request from "supertest";
import { makeApp, resetDb, closeDb, PASSWORD } from "./helpers.js";
import { setupTokenNotice } from "../src/setupnotice.js";

const TOKEN = "ABCDE-FGHJK-LMNPQ-RSTUV";

describe("setupTokenNotice (the line printed in the log)", () => {
  test("no administrator yet and a token: says what to do and shows the token", () => {
    const text = setupTokenNotice({ token: TOKEN, hasAdmin: false });
    expect(text).toContain(TOKEN);
    expect(text).toMatch(/setup token/i);
    expect(text).toMatch(/create the administrator|first administrator/i);
  });

  test("an administrator exists: nothing is printed (the token is not repeated for no reason)", () => {
    expect(setupTokenNotice({ token: TOKEN, hasAdmin: true })).toBeNull();
  });

  test("no token configured: nothing to print", () => {
    expect(setupTokenNotice({ token: null, hasAdmin: false })).toBeNull();
    expect(setupTokenNotice({ token: "", hasAdmin: false })).toBeNull();
  });

  test("tells the administrator how to find it again", () => {
    expect(setupTokenNotice({ token: TOKEN, hasAdmin: false })).toMatch(/logs/i);
  });
});

describe("the status tells the dashboard whether a token is asked for", () => {
  afterAll(closeDb);
  const status = async (token) => {
    await resetDb();
    const { config } = await import("../src/config.js");
    const saved = config.setupToken;
    config.setupToken = token;
    try {
      const app = await makeApp();
      return { app, body: (await request(app).get("/api/auth/status")).body };
    } finally {
      config.setupToken = saved;
    }
  };

  test("a token is configured and nobody has set up yet: required", async () => {
    expect((await status(TOKEN)).body).toEqual({ needsSetup: true, authenticated: false, setupTokenRequired: true });
  });

  test("no token configured: not required", async () => {
    expect((await status(null)).body).toEqual({ needsSetup: true, authenticated: false, setupTokenRequired: false });
  });

  test("after setup it is never required, and the token is not mentioned", async () => {
    const { config } = await import("../src/config.js");
    await resetDb();
    config.setupToken = TOKEN;
    try {
      const app = await makeApp();
      await request(app).post("/api/auth/setup").send({ username: "admin", password: PASSWORD, setupToken: TOKEN });
      const res = await request(app).get("/api/auth/status");
      expect(res.body.setupTokenRequired).toBe(false);
      expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    } finally {
      config.setupToken = null;
    }
  });

  test("the answer never contains the token itself", async () => {
    expect(JSON.stringify((await status(TOKEN)).body)).not.toContain(TOKEN);
  });
});
