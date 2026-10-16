// The worker's status helpers against real Postgres: every update is guarded so a final status sticks.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as d from "../src/db.js";
import { pool, ready, reset, makeApp, makeDeployment, getDeployment } from "./helpers.js";

before(ready);
beforeEach(reset);
after(() => pool.end());

const fresh = async () => makeDeployment(await makeApp());

test("queued -> building -> starting -> validating -> successful", async () => {
  const id = await fresh();
  await d.markBuilding(id);
  assert.ok((await getDeployment(id)).started_at);
  await d.setCommit(id, "abc123");
  await d.setStatus(id, "starting");
  await d.setStatus(id, "validating");
  assert.equal((await getDeployment(id)).status, "validating");
  await d.markSucceeded(id, "shipdok/t:img");
  const row = await getDeployment(id);
  assert.deepEqual([row.status, row.image_ref, row.commit_sha], ["successful", "shipdok/t:img", "abc123"]);
  assert.ok(row.finished_at);
});

test("a final status can never be overwritten", async () => {
  const id = await fresh();
  await d.markBuilding(id);
  await d.markSucceeded(id, "img");
  await d.markFailed(id, "late failure");
  await d.setStatus(id, "building");
  await d.recordEnvVersions(id, { LATE: "1" });
  const row = await getDeployment(id);
  assert.equal(row.status, "successful");
  assert.equal(row.error_summary, null);
  assert.equal(row.config_snapshot.env, undefined);
});

test("failure is recorded and the error text is capped at 500 characters", async () => {
  const id = await fresh();
  await d.markBuilding(id);
  await d.markFailed(id, "x".repeat(5000));
  const row = await getDeployment(id);
  assert.equal(row.status, "failed");
  assert.equal(row.error_summary.length, 500);
});

test("markBuilding only applies to queued rows", async () => {
  const id = await fresh();
  await d.markBuilding(id);
  await d.markFailed(id, "x");
  await d.markBuilding(id);
  assert.equal((await getDeployment(id)).status, "failed");
});

test("recordEnvVersions adds the env map and keeps the rest of the snapshot", async () => {
  const appId = await makeApp();
  const id = await makeDeployment(appId, { branch: "main", host_port: 8080 });
  await d.recordEnvVersions(id, { A: "5", B: "9" });
  assert.deepEqual((await getDeployment(id)).config_snapshot, {
    branch: "main",
    host_port: 8080,
    env: { A: "5", B: "9" },
  });
});

test("interruptActive marks only in-flight rows; queued and finished rows are untouched", async () => {
  const appId = await makeApp();
  const queued = await makeDeployment(appId);
  const building = await makeDeployment(appId);
  const validating = await makeDeployment(appId);
  const done = await makeDeployment(appId);
  await d.markBuilding(building);
  await d.markBuilding(validating);
  await d.setStatus(validating, "validating");
  await d.markBuilding(done);
  await d.markSucceeded(done, "i");

  assert.equal(await d.interruptActive(), 2);
  const status = async (id) => (await getDeployment(id)).status;
  assert.deepEqual(
    [await status(queued), await status(building), await status(validating), await status(done)],
    ["queued", "interrupted", "interrupted", "successful"],
  );
  const row = await getDeployment(building);
  assert.ok(row.finished_at);
  assert.match(row.error_summary, /worker stopped/);
});

test("a stall handler cannot turn 'interrupted' into 'failed'", async () => {
  const id = await fresh();
  await d.markBuilding(id);
  await d.interruptActive();
  await d.markFailed(id, "job stalled more than allowable limit");
  assert.equal((await getDeployment(id)).status, "interrupted");
});
