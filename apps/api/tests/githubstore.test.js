import { generateKeyPairSync } from "node:crypto";
import { testPool, resetDb, closeDb } from "./helpers.js";
import { saveGithubApp, loadGithubApp, githubAppSummary, deleteGithubApp, createGithubProvider, GithubStoreError, parseMasterKey, encryptSecret, githubFieldContext } from "@shipdok/shared";

const KEY = parseMasterKey("a1".repeat(32));
const OTHER = parseMasterKey("b2".repeat(32));
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" });
const SECRET = "a-webhook-secret-0123456789";
const app = (over = {}) => ({ appId: "123456", slug: "shipdok-ab12", name: "Shipdok-ab12", ownerLogin: "tianyu-00", htmlUrl: "https://github.com/apps/shipdok-ab12", clientId: "Iv1.abc", privateKeyPem: PEM, webhookSecret: SECRET, clientSecret: "client-secret-value", source: "manifest", ...over });

beforeEach(async () => {
  await resetDb();
  await testPool.query("DELETE FROM github_app");
});
afterAll(async () => {
  await testPool.query("DELETE FROM github_app");
  await closeDb();
});

describe("saving and loading", () => {
  test("nothing is connected at first", async () => {
    expect(await loadGithubApp(testPool, KEY)).toBeNull();
    expect(await githubAppSummary(testPool)).toBeNull();
  });

  test("what is saved comes back, secrets decrypted, key usable", async () => {
    await saveGithubApp(testPool, KEY, app());
    const got = await loadGithubApp(testPool, KEY);
    expect(got).toMatchObject({ appId: "123456", slug: "shipdok-ab12", name: "Shipdok-ab12", ownerLogin: "tianyu-00", source: "manifest", webhookSecret: SECRET });
    expect(got.privateKey.asymmetricKeyType).toBe("rsa");
  });

  test("the secrets are encrypted in the table, not readable there", async () => {
    await saveGithubApp(testPool, KEY, app());
    const { rows } = await testPool.query("SELECT * FROM github_app");
    const all = JSON.stringify(rows[0]);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain("client-secret-value");
    expect(all).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(all).not.toContain(PEM.split("\n")[1]);
    expect(rows[0].private_key_enc).toMatch(/^v1:/);
    expect(rows[0].webhook_secret_enc).toMatch(/^v1:/);
    expect(rows[0].client_secret_enc).toMatch(/^v1:/);
  });

  test("the summary has no secrets in it, and needs no key", async () => {
    await saveGithubApp(testPool, KEY, app());
    const s = await githubAppSummary(testPool);
    expect(s).toMatchObject({ appId: "123456", name: "Shipdok-ab12", ownerLogin: "tianyu-00", htmlUrl: "https://github.com/apps/shipdok-ab12", source: "manifest" });
    const text = JSON.stringify(s);
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(/private|secret/i);
  });

  test("saving again replaces the app (there is only ever one)", async () => {
    await saveGithubApp(testPool, KEY, app());
    await saveGithubApp(testPool, KEY, app({ appId: "999", webhookSecret: "another-secret-0123456789", source: "manual", clientSecret: undefined }));
    expect((await testPool.query("SELECT count(*)::int AS n FROM github_app")).rows[0].n).toBe(1);
    const got = await loadGithubApp(testPool, KEY);
    expect(got).toMatchObject({ appId: "999", webhookSecret: "another-secret-0123456789", source: "manual" });
    expect((await testPool.query("SELECT client_secret_enc FROM github_app")).rows[0].client_secret_enc).toBeNull();
  });

  test("the table refuses a second row", async () => {
    await saveGithubApp(testPool, KEY, app());
    await expect(testPool.query("INSERT INTO github_app (id, app_id, private_key_enc, webhook_secret_enc, source) VALUES (2, 1, 'x', 'y', 'manual')")).rejects.toThrow();
  });

  test("a different platform key cannot read it, and the error says so without any secret", async () => {
    await saveGithubApp(testPool, KEY, app());
    const err = await loadGithubApp(testPool, OTHER).catch((e) => e);
    expect(err).toBeInstanceOf(GithubStoreError);
    expect(err.code).toBe("cannot_decrypt");
    expect(err.message).not.toContain(SECRET);
  });

  test("a secret moved into another field does not decrypt there", async () => {
    await saveGithubApp(testPool, KEY, app());
    const { rows } = await testPool.query("SELECT webhook_secret_enc FROM github_app");
    await testPool.query("UPDATE github_app SET private_key_enc = $1", [rows[0].webhook_secret_enc]);
    await expect(loadGithubApp(testPool, KEY)).rejects.toThrow(GithubStoreError);
    // and a value really encrypted for the right field works
    await testPool.query("UPDATE github_app SET private_key_enc = $1", [encryptSecret(PEM, KEY, githubFieldContext("private_key"))]);
    expect((await loadGithubApp(testPool, KEY)).appId).toBe("123456");
  });

  test("delete removes it", async () => {
    await saveGithubApp(testPool, KEY, app());
    expect(await deleteGithubApp(testPool)).toBe(true);
    expect(await loadGithubApp(testPool, KEY)).toBeNull();
    expect(await deleteGithubApp(testPool)).toBe(false);
  });
});

describe("the provider the API and the worker use", () => {
  const fetchOk = async () => new Response(JSON.stringify({ id: 1, slug: "s", name: "n", html_url: "u" }), { status: 200 });

  test("no app: no client, no secret", async () => {
    const p = createGithubProvider(testPool, KEY, { ttlMs: 0 });
    expect(await p.client()).toBeNull();
    expect(await p.webhookSecret()).toBeNull();
    expect(await p.status()).toEqual({ app: null, problem: null });
  });

  test("an app: a client that signs as it, the secret, a status without secrets", async () => {
    await saveGithubApp(testPool, KEY, app());
    const p = createGithubProvider(testPool, KEY, { ttlMs: 0, fetch: fetchOk });
    const client = await p.client();
    expect(typeof client.getApp).toBe("function");
    expect(await p.webhookSecret()).toBe(SECRET);
    const st = await p.status();
    expect(st.problem).toBeNull();
    expect(JSON.stringify(st)).not.toContain(SECRET);
    expect(st.app).toMatchObject({ appId: "123456" });
    expect(st.app.privateKey).toBeUndefined();
    expect(st.app.webhookSecret).toBeUndefined();
  });

  test("a change made elsewhere is seen after the cache time, not before", async () => {
    let t = 1_000_000;
    const p = createGithubProvider(testPool, KEY, { ttlMs: 5000, now: () => t });
    expect(await p.webhookSecret()).toBeNull();
    await saveGithubApp(testPool, KEY, app());
    expect(await p.webhookSecret()).toBeNull(); // still cached
    t += 5001;
    expect(await p.webhookSecret()).toBe(SECRET);
    await deleteGithubApp(testPool);
    t += 5001;
    expect(await p.webhookSecret()).toBeNull();
  });

  test("invalidate makes the next read see the change at once", async () => {
    const p = createGithubProvider(testPool, KEY, { ttlMs: 60_000 });
    expect(await p.webhookSecret()).toBeNull();
    await saveGithubApp(testPool, KEY, app());
    p.invalidate();
    expect(await p.webhookSecret()).toBe(SECRET);
  });

  test("the same client (and its token cache) is kept while nothing changes, and replaced when the app is replaced", async () => {
    await saveGithubApp(testPool, KEY, app());
    const p = createGithubProvider(testPool, KEY, { ttlMs: 0, fetch: fetchOk });
    const a = await p.client();
    expect(await p.client()).toBe(a);
    await saveGithubApp(testPool, KEY, app({ appId: "777" }));
    expect(await p.client()).not.toBe(a);
  });

  test("credentials that cannot be decrypted: no client, no secret, and the problem is reported once per read", async () => {
    await saveGithubApp(testPool, OTHER, app());
    const seen = [];
    const p = createGithubProvider(testPool, KEY, { ttlMs: 0, onProblem: (e) => seen.push(e.code) });
    expect(await p.client()).toBeNull();
    expect(await p.webhookSecret()).toBeNull();
    expect((await p.status()).problem).toBe("cannot_decrypt");
    expect(seen).toContain("cannot_decrypt");
  });

  test("when the database fails, what was known keeps working", async () => {
    await saveGithubApp(testPool, KEY, app());
    let broken = false;
    const flaky = { query: (...a) => (broken ? Promise.reject(new Error("db down")) : testPool.query(...a)) };
    const p = createGithubProvider(flaky, KEY, { ttlMs: 0 });
    expect(await p.webhookSecret()).toBe(SECRET);
    broken = true;
    expect(await p.webhookSecret()).toBe(SECRET);
  });

  test("when the database fails and nothing was known, the error is passed on", async () => {
    const down = { query: () => Promise.reject(new Error("db down")) };
    await expect(createGithubProvider(down, KEY, { ttlMs: 0 }).client()).rejects.toThrow("db down");
  });
});
