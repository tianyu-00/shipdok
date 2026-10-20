import { generateKeyPairSync } from "node:crypto";
import { testPool, resetDb, closeDb } from "./helpers.js";
import { saveGithubApp, loadGithubApp, loadGithubApps, listGithubApps, githubAppSummary, deleteGithubApp, createGithubProvider, GithubStoreError, parseMasterKey, encryptSecret, decryptSecret, githubFieldContext } from "@shipdok/shared";

const KEY = parseMasterKey("a1".repeat(32));
const OTHER = parseMasterKey("b2".repeat(32));
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" });
const SECRET = "a-webhook-secret-0123456789";
const SECOND = "second-webhook-secret-9876543210";
const app = (over = {}) => ({ appId: "123456", slug: "shipdok-ab12", name: "Shipdok-ab12", ownerLogin: "tianyu-00", htmlUrl: "https://github.com/apps/shipdok-ab12", clientId: "Iv1.abc", privateKeyPem: PEM, webhookSecret: SECRET, clientSecret: "client-secret-value", source: "manifest", ...over });
const second = (over = {}) => app({ appId: "654321", slug: "shipdok-cd34", name: "Shipdok-cd34", ownerLogin: "my-org", webhookSecret: SECOND, source: "manual", clientSecret: undefined, ...over });

beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await resetDb();
  await closeDb();
});

describe("saving and loading", () => {
  test("nothing is connected at first", async () => {
    expect(await listGithubApps(testPool)).toEqual([]);
    expect(await loadGithubApps(testPool, KEY)).toEqual([]);
    expect(await loadGithubApp(testPool, KEY, "00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(await githubAppSummary(testPool, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  test("what is saved comes back, secrets decrypted, key usable", async () => {
    const { id, created } = await saveGithubApp(testPool, KEY, app());
    expect(created).toBe(true);
    const got = await loadGithubApp(testPool, KEY, id);
    expect(got).toMatchObject({ id, appId: "123456", slug: "shipdok-ab12", name: "Shipdok-ab12", ownerLogin: "tianyu-00", source: "manifest", webhookSecret: SECRET });
    expect(got.privateKey.asymmetricKeyType).toBe("rsa");
  });

  test("several apps live side by side, each with its own secrets", async () => {
    const a = await saveGithubApp(testPool, KEY, app());
    const b = await saveGithubApp(testPool, KEY, second());
    expect(a.id).not.toBe(b.id);
    expect((await listGithubApps(testPool)).map((x) => x.name)).toEqual(["Shipdok-ab12", "Shipdok-cd34"]);
    expect((await loadGithubApp(testPool, KEY, a.id)).webhookSecret).toBe(SECRET);
    expect((await loadGithubApp(testPool, KEY, b.id)).webhookSecret).toBe(SECOND);
  });

  test("there is no limit on how many are connected", async () => {
    for (let i = 0; i < 12; i += 1) await saveGithubApp(testPool, KEY, second({ appId: String(1000 + i), name: `App ${i}` }));
    expect(await listGithubApps(testPool)).toHaveLength(12);
  });

  test("the secrets are encrypted in the table, not readable there", async () => {
    await saveGithubApp(testPool, KEY, app());
    const { rows } = await testPool.query("SELECT * FROM github_apps");
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
    const { id } = await saveGithubApp(testPool, KEY, app());
    const s = await githubAppSummary(testPool, id);
    expect(s).toMatchObject({ id, appId: "123456", name: "Shipdok-ab12", ownerLogin: "tianyu-00", htmlUrl: "https://github.com/apps/shipdok-ab12", source: "manifest" });
    const text = JSON.stringify([s, await listGithubApps(testPool)]);
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(/private|secret/i);
  });

  test("the same GitHub App saved again replaces its credentials: same id, still one row", async () => {
    const first = await saveGithubApp(testPool, KEY, app());
    const again = await saveGithubApp(testPool, KEY, app({ webhookSecret: "another-secret-0123456789", source: "manual", clientSecret: undefined, name: "Renamed" }));
    expect(again).toEqual({ id: first.id, created: false });
    expect((await testPool.query("SELECT count(*)::int AS n FROM github_apps")).rows[0].n).toBe(1);
    expect(await loadGithubApp(testPool, KEY, first.id)).toMatchObject({ name: "Renamed", webhookSecret: "another-secret-0123456789", source: "manual" });
    expect((await testPool.query("SELECT client_secret_enc FROM github_apps")).rows[0].client_secret_enc).toBeNull();
  });

  test("a different platform key cannot read it, and the error says so without any secret", async () => {
    const { id } = await saveGithubApp(testPool, KEY, app());
    const err = await loadGithubApp(testPool, OTHER, id).catch((e) => e);
    expect(err).toBeInstanceOf(GithubStoreError);
    expect(err.code).toBe("cannot_decrypt");
    expect(err.message).not.toContain(SECRET);
  });

  test("a secret moved into another field does not decrypt there", async () => {
    const { id } = await saveGithubApp(testPool, KEY, app());
    const { rows } = await testPool.query("SELECT webhook_secret_enc FROM github_apps");
    await testPool.query("UPDATE github_apps SET private_key_enc = $1", [rows[0].webhook_secret_enc]);
    await expect(loadGithubApp(testPool, KEY, id)).rejects.toThrow(GithubStoreError);
    // and a value really encrypted for the right field and app works
    await testPool.query("UPDATE github_apps SET private_key_enc = $1", [encryptSecret(PEM, KEY, githubFieldContext("private_key", id))]);
    expect((await loadGithubApp(testPool, KEY, id)).appId).toBe("123456");
  });

  test("a secret copied from one app into another does not decrypt there (each is bound to its own row)", async () => {
    const a = await saveGithubApp(testPool, KEY, app());
    const b = await saveGithubApp(testPool, KEY, second());
    const { rows } = await testPool.query("SELECT private_key_enc FROM github_apps WHERE id = $1", [a.id]);
    await testPool.query("UPDATE github_apps SET private_key_enc = $1 WHERE id = $2", [rows[0].private_key_enc, b.id]);
    await expect(loadGithubApp(testPool, KEY, b.id)).rejects.toThrow(GithubStoreError);
    expect((await loadGithubApp(testPool, KEY, a.id)).appId).toBe("123456");
  });

  test("the app that was connected before there could be several (encrypted for the field name alone) is still readable, until it is saved again", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    await testPool.query(
      `INSERT INTO github_apps (id, app_id, name, private_key_enc, webhook_secret_enc, source, legacy_context) VALUES ($1, 55, 'Old', $2, $3, 'manifest', true)`,
      [id, encryptSecret(PEM, KEY, githubFieldContext("private_key")), encryptSecret(SECRET, KEY, githubFieldContext("webhook_secret"))],
    );
    expect(await loadGithubApp(testPool, KEY, id)).toMatchObject({ appId: "55", webhookSecret: SECRET });
    await saveGithubApp(testPool, KEY, app({ appId: "55" }));
    expect((await testPool.query("SELECT legacy_context FROM github_apps WHERE id = $1", [id])).rows[0].legacy_context).toBe(false);
    expect(await loadGithubApp(testPool, KEY, id)).toMatchObject({ appId: "55", webhookSecret: SECRET });
    // saved the new way now: the old binding no longer opens it
    const { rows } = await testPool.query("SELECT webhook_secret_enc FROM github_apps WHERE id = $1", [id]);
    expect(() => decryptSecret(rows[0].webhook_secret_enc, KEY, githubFieldContext("webhook_secret"))).toThrow();
    expect(decryptSecret(rows[0].webhook_secret_enc, KEY, githubFieldContext("webhook_secret", id))).toBe(SECRET);
  });

  test("loadGithubApps lists an app that cannot be read, with the problem and no secret, and still reads the others", async () => {
    await saveGithubApp(testPool, KEY, app());
    await saveGithubApp(testPool, OTHER, second());
    const all = await loadGithubApps(testPool, KEY);
    expect(all.map((a) => [a.name, a.problem ?? null])).toEqual([["Shipdok-ab12", null], ["Shipdok-cd34", "cannot_decrypt"]]);
    expect(JSON.stringify(all[1])).not.toContain(SECOND);
    expect(all[1].webhookSecret).toBeUndefined();
  });
});

describe("removing an app", () => {
  const project = (name, port, githubAppId, installation = null) =>
    testPool.query("INSERT INTO apps (name, slug, repo, container_port, host_port, github_app_id, github_installation_id) VALUES ($1, $1, 'o/r', 3000, $2, $3, $4)", [name, port, githubAppId, installation]);

  test("delete removes it and says it was there", async () => {
    const { id } = await saveGithubApp(testPool, KEY, app());
    expect(await deleteGithubApp(testPool, id)).toEqual([]);
    expect(await loadGithubApp(testPool, KEY, id)).toBeNull();
    expect(await deleteGithubApp(testPool, id)).toBeNull();
  });

  test("the projects that used it are returned, and left with no GitHub app and no remembered installation", async () => {
    const a = await saveGithubApp(testPool, KEY, app());
    const b = await saveGithubApp(testPool, KEY, second());
    await project("alpha", 21000, a.id, 7);
    await project("beta", 21001, a.id, 8);
    await project("gamma", 21002, b.id, 9);
    const used = await deleteGithubApp(testPool, a.id);
    expect(used.map((p) => p.name)).toEqual(["alpha", "beta"]);
    const rows = (await testPool.query("SELECT slug, github_app_id, github_installation_id FROM apps ORDER BY slug")).rows;
    expect(rows.map((r) => [r.slug, r.github_app_id, r.github_installation_id === null ? null : Number(r.github_installation_id)])).toEqual([["alpha", null, null], ["beta", null, null], ["gamma", b.id, 9]]);
  });

  test("the database itself forgets the assignment if a row is removed by other means", async () => {
    const a = await saveGithubApp(testPool, KEY, app());
    await project("alpha", 21000, a.id);
    await testPool.query("DELETE FROM github_apps WHERE id = $1", [a.id]);
    expect((await testPool.query("SELECT github_app_id FROM apps")).rows[0].github_app_id).toBeNull();
  });
});

describe("the provider the API and the worker use", () => {
  const fetchOk = async () => new Response(JSON.stringify({ id: 1, slug: "s", name: "n", html_url: "u" }), { status: 200 });

  test("no apps: no client, no secrets, nothing listed", async () => {
    const p = createGithubProvider(testPool, KEY, { ttlMs: 0 });
    expect(await p.client("11111111-1111-4111-8111-111111111111")).toBeNull();
    expect(await p.client(undefined)).toBeNull();
    expect(await p.webhookSecrets()).toEqual([]);
    expect(await p.clients()).toEqual([]);
    expect(await p.status()).toEqual({ apps: [] });
  });

  test("each app gets its own client, and the secrets of all are offered with the app they belong to", async () => {
    const a = await saveGithubApp(testPool, KEY, app());
    const b = await saveGithubApp(testPool, KEY, second());
    const p = createGithubProvider(testPool, KEY, { ttlMs: 0, fetch: fetchOk });
    const ca = await p.client(a.id);
    const cb = await p.client(b.id);
    expect(typeof ca.getApp).toBe("function");
    expect(cb).not.toBe(ca);
    expect(await p.webhookSecrets()).toEqual([{ id: a.id, secret: SECRET }, { id: b.id, secret: SECOND }]);
    expect((await p.clients()).map((c) => [c.id, c.name])).toEqual([[a.id, "Shipdok-ab12"], [b.id, "Shipdok-cd34"]]);
  });

  test("the status has no secrets in it", async () => {
    const a = await saveGithubApp(testPool, KEY, app());
    const st = await createGithubProvider(testPool, KEY, { ttlMs: 0, fetch: fetchOk }).status();
    expect(st.apps).toHaveLength(1);
    expect(st.apps[0]).toMatchObject({ id: a.id, appId: "123456", problem: null });
    expect(JSON.stringify(st)).not.toContain(SECRET);
    expect(st.apps[0].privateKey).toBeUndefined();
    expect(st.apps[0].webhookSecret).toBeUndefined();
  });

  test("a change made elsewhere is seen after the cache time, not before", async () => {
    let t = 1_000_000;
    const p = createGithubProvider(testPool, KEY, { ttlMs: 5000, now: () => t });
    expect(await p.webhookSecrets()).toEqual([]);
    const { id } = await saveGithubApp(testPool, KEY, app());
    expect(await p.webhookSecrets()).toEqual([]); // still cached
    t += 5001;
    expect(await p.webhookSecrets()).toEqual([{ id, secret: SECRET }]);
    await deleteGithubApp(testPool, id);
    t += 5001;
    expect(await p.webhookSecrets()).toEqual([]);
    expect(await p.client(id)).toBeNull();
  });

  test("invalidate makes the next read see the change at once", async () => {
    const p = createGithubProvider(testPool, KEY, { ttlMs: 60_000 });
    expect(await p.webhookSecrets()).toEqual([]);
    const { id } = await saveGithubApp(testPool, KEY, app());
    p.invalidate();
    expect(await p.webhookSecrets()).toEqual([{ id, secret: SECRET }]);
  });

  test("the same client (and its token cache) is kept while an app does not change, and replaced when it is saved again", async () => {
    const a = await saveGithubApp(testPool, KEY, app());
    const b = await saveGithubApp(testPool, KEY, second());
    const p = createGithubProvider(testPool, KEY, { ttlMs: 0, fetch: fetchOk });
    const ca = await p.client(a.id);
    const cb = await p.client(b.id);
    expect(await p.client(a.id)).toBe(ca);
    await new Promise((r) => setTimeout(r, 5));
    await saveGithubApp(testPool, KEY, app({ name: "Renamed" })); // only the first changes
    expect(await p.client(a.id)).not.toBe(ca);
    expect(await p.client(b.id)).toBe(cb);
  });

  test("an app whose credentials cannot be decrypted has no client and no secret, is reported, and the others keep working", async () => {
    await saveGithubApp(testPool, OTHER, app());
    const good = await saveGithubApp(testPool, KEY, second());
    const seen = [];
    const p = createGithubProvider(testPool, KEY, { ttlMs: 0, onProblem: (e) => seen.push(e.code) });
    const st = await p.status();
    expect(st.apps.map((a) => [a.name, a.problem])).toEqual([["Shipdok-ab12", "cannot_decrypt"], ["Shipdok-cd34", null]]);
    expect(await p.webhookSecrets()).toEqual([{ id: good.id, secret: SECOND }]);
    expect((await p.clients()).map((c) => c.id)).toEqual([good.id]);
    expect(await p.client((await listGithubApps(testPool))[0].id)).toBeNull();
    expect(seen).toContain("cannot_decrypt");
  });

  test("when the database fails, what was known keeps working", async () => {
    const { id } = await saveGithubApp(testPool, KEY, app());
    let broken = false;
    const flaky = { query: (...a) => (broken ? Promise.reject(new Error("db down")) : testPool.query(...a)) };
    const p = createGithubProvider(flaky, KEY, { ttlMs: 0 });
    expect(await p.webhookSecrets()).toEqual([{ id, secret: SECRET }]);
    broken = true;
    expect(await p.webhookSecrets()).toEqual([{ id, secret: SECRET }]);
  });

  test("when the database fails and nothing was known, the error is passed on", async () => {
    const down = { query: () => Promise.reject(new Error("db down")) };
    await expect(createGithubProvider(down, KEY, { ttlMs: 0 }).client("11111111-1111-4111-8111-111111111111")).rejects.toThrow("db down");
  });
});
