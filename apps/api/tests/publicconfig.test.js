import { config, assertConfig } from "../src/config.js";

const saved = { mode: config.publicModeEnv, url: config.publicUrlEnv };
afterEach(() => {
  config.publicModeEnv = saved.mode;
  config.publicUrlEnv = saved.url;
});

describe("SHIPDOK_PUBLIC and PUBLIC_URL are checked at startup", () => {
  test("nothing set is fine", () => {
    config.publicModeEnv = null;
    config.publicUrlEnv = null;
    expect(() => assertConfig()).not.toThrow();
  });

  test.each(["local", "webhook", "full"])("mode %s is accepted", (mode) => {
    config.publicModeEnv = mode;
    expect(() => assertConfig()).not.toThrow();
  });

  test.each(["off", "FULL", "everything", "public"])("mode %s is refused, naming the choices", (mode) => {
    config.publicModeEnv = mode;
    expect(() => assertConfig()).toThrow(/SHIPDOK_PUBLIC must be one of: local, webhook, full/);
  });

  test("the address is tidied to an origin", () => {
    config.publicUrlEnv = "HTTPS://Shipdok.Example.com/";
    assertConfig();
    expect(config.publicUrlEnv).toBe("https://shipdok.example.com");
  });

  test.each(["shipdok.example.com", "https://shipdok.example.com/path", "ftp://x.example.com"])("the address %s is refused", (url) => {
    config.publicUrlEnv = url;
    expect(() => assertConfig()).toThrow(/PUBLIC_URL is not usable/);
  });
});
