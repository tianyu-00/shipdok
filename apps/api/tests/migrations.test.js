import { resetDb, closeDb, testPool } from "./helpers.js";

beforeEach(resetDb);
afterAll(closeDb);

let n = 0;
async function insertApp() {
  n += 1;
  const { rows } = await testPool.query(
    `INSERT INTO apps (name, slug, repo, container_port, host_port)
     VALUES ($1, $1, 'o/r', 3000, $2) RETURNING id`,
    [`app-${n}`, 20000 + n],
  );
  return rows[0].id;
}
const insertVar = (appId, key, value = "v1:aaa:bbb:ccc") =>
  testPool.query("INSERT INTO app_env_vars (app_id, key, value_encrypted) VALUES ($1, $2, $3)", [appId, key, value]);
const count = async () => (await testPool.query("SELECT count(*)::int AS n FROM app_env_vars")).rows[0].n;

describe("app_env_vars (migration 003)", () => {
  test("stores a variable", async () => {
    const id = await insertApp();
    await insertVar(id, "DATABASE_URL");
    expect(await count()).toBe(1);
  });

  test("a key is unique within an app but can repeat across apps", async () => {
    const a = await insertApp();
    const b = await insertApp();
    await insertVar(a, "API_KEY");
    await expect(insertVar(a, "API_KEY")).rejects.toMatchObject({ code: "23505" });
    await insertVar(b, "API_KEY");
    expect(await count()).toBe(2);
  });

  test.each(["1STARTS_WITH_DIGIT", "has space", "with-dash", "semi;colon", "", "A".repeat(129)])(
    "rejects the invalid variable name %j",
    async (key) => {
      const id = await insertApp();
      await expect(insertVar(id, key)).rejects.toMatchObject({ code: "23514" });
    },
  );

  test("accepts the usual names, including underscores and lowercase", async () => {
    const id = await insertApp();
    for (const key of ["DATABASE_URL", "_PRIVATE", "lower_case_ok", "A1_B2", "A".repeat(128)]) {
      await insertVar(id, key);
    }
    expect(await count()).toBe(5);
  });

  test("refuses a value that is not in the encrypted v1 format (no plaintext in the table)", async () => {
    const id = await insertApp();
    await expect(insertVar(id, "PASSWORD", "hunter2")).rejects.toMatchObject({ code: "23514" });
    expect(await count()).toBe(0);
  });

  test("rejects variables for an app that does not exist", async () => {
    await expect(insertVar("00000000-0000-0000-0000-000000000000", "X")).rejects.toMatchObject({ code: "23503" });
  });

  test("deleting an app deletes its variables, and only its own", async () => {
    const a = await insertApp();
    const b = await insertApp();
    await insertVar(a, "ONE");
    await insertVar(b, "TWO");
    await testPool.query("DELETE FROM apps WHERE id = $1", [a]);
    const { rows } = await testPool.query("SELECT app_id FROM app_env_vars");
    expect(rows).toEqual([{ app_id: b }]);
  });
});
