import request from "supertest";
import { jest } from "@jest/globals";
import { makeApp, resetDb, closeDb, testPool, PASSWORD } from "./helpers.js";

const VALID = {
  name: "My App",
  repo: "tianyu-00/shipdok-test-app",
  container_port: 3000,
  host_port: 8080,
  health_path: "/health",
};

let queue;
let app;
let agent; // supertest agent that keeps the admin's session cookie

beforeEach(async () => {
  await resetDb();
  queue = { add: jest.fn(async () => ({ id: "42" })) };
  app = await makeApp({ queue });
  agent = request.agent(app);
  await agent.post("/api/auth/setup").send({ username: "admin", password: PASSWORD });
});
afterEach(() => {
  jest.restoreAllMocks();
});
afterAll(closeDb);

const createApp = (over = {}) => agent.post("/api/apps").send({ ...VALID, ...over });

describe("authentication", () => {
  test("every apps and deployments route requires a session", async () => {
    const anon = request(app);
    expect((await anon.get("/api/apps")).status).toBe(401);
    expect((await anon.post("/api/apps").send(VALID)).status).toBe(401);
    expect((await anon.get("/api/apps/00000000-0000-0000-0000-000000000000")).status).toBe(401);
    expect((await anon.post("/api/apps/00000000-0000-0000-0000-000000000000/deployments")).status).toBe(401);
    expect((await anon.get("/api/deployments/00000000-0000-0000-0000-000000000000")).status).toBe(401);
  });
});

describe("creating apps", () => {
  test("creates an app with a slug and sensible defaults", async () => {
    const res = await createApp({ name: "My Cool App!" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: "My Cool App!",
      slug: "my-cool-app",
      repo: "tianyu-00/shipdok-test-app",
      branch: "main",
      root_dir: ".",
      memory_mb: 512,
      desired_state: "running",
    });
    expect(Number(res.body.cpus)).toBe(1);
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test.each([
    ["a full URL instead of owner/repo", { repo: "https://github.com/a/b.git" }],
    ["a root dir that escapes the repo", { root_dir: "../etc" }],
    ["an absolute root dir", { root_dir: "/etc" }],
    ["a branch that looks like a git option", { branch: "--upload-pack=evil" }],
    ["a container port out of range", { container_port: 70000 }],
    ["a privileged host port", { host_port: 80 }],
    ["a health path without a leading slash", { health_path: "health" }],
    ["an unknown field", { privileged: true }],
    ["memory below the minimum", { memory_mb: 8 }],
  ])("rejects %s", async (_label, over) => {
    const res = await createApp(over);
    expect(res.status).toBe(400);
    const { rows } = await testPool.query("SELECT count(*)::int AS n FROM apps");
    expect(rows[0].n).toBe(0);
  });

  test("rejects a missing host port", async () => {
    const { host_port, ...rest } = VALID;
    const res = await agent.post("/api/apps").send(rest);
    expect(res.status).toBe(400);
  });

  test("a duplicate name is a 409", async () => {
    await createApp();
    const res = await createApp({ host_port: 8081 });
    expect(res.status).toBe(409);
  });

  test("names that normalise to the same slug collide", async () => {
    await createApp({ name: "My App" });
    const res = await createApp({ name: "my-app", host_port: 8081 });
    expect(res.status).toBe(409);
  });

  test("a host port can only belong to one app", async () => {
    await createApp({ name: "First" });
    const res = await createApp({ name: "Second" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/port/i);
  });

  test("a name with no letters or numbers is rejected", async () => {
    const res = await createApp({ name: "!!!" });
    expect(res.status).toBe(400);
  });
});

describe("reading apps", () => {
  test("lists apps with their latest deployment", async () => {
    const created = (await createApp()).body;
    let list = (await agent.get("/api/apps")).body;
    expect(list).toHaveLength(1);
    expect(list[0].latest_deployment).toBeNull();

    await agent.post(`/api/apps/${created.id}/deployments`);
    list = (await agent.get("/api/apps")).body;
    expect(list[0].latest_deployment.status).toBe("queued");
  });

  test("gets one app by id", async () => {
    const created = (await createApp()).body;
    const res = await agent.get(`/api/apps/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.id);
  });

  test("unknown and malformed ids are both a 404, not a 500", async () => {
    expect((await agent.get("/api/apps/00000000-0000-0000-0000-000000000000")).status).toBe(404);
    expect((await agent.get("/api/apps/not-a-uuid")).status).toBe(404);
    expect((await agent.get("/api/apps/1'%20OR%20'1'='1")).status).toBe(404);
  });
});

describe("requesting a deployment", () => {
  let created;
  beforeEach(async () => {
    created = (await createApp()).body;
  });

  test("persists a queued row, enqueues a job, and returns 202", async () => {
    const res = await agent.post(`/api/apps/${created.id}/deployments`);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ app_id: created.id, status: "queued", trigger: "manual", job_id: "42" });

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, data] = queue.add.mock.calls[0];
    expect(name).toBe("deploy");
    expect(data).toMatchObject({
      deploymentId: res.body.id,
      appId: created.id,
      slug: "my-app",
      repo: "https://github.com/tianyu-00/shipdok-test-app.git", // built by the server, never taken from the client
      ref: "main",
      dir: ".",
      containerPort: 3000,
      hostPort: 8080,
      health: "/health",
      memoryMb: 512,
      cpus: 1,
    });
  });

  test("snapshots the settings used, so later edits cannot rewrite history", async () => {
    const res = await agent.post(`/api/apps/${created.id}/deployments`);
    expect(res.body.config_snapshot).toMatchObject({
      repo: "tianyu-00/shipdok-test-app",
      branch: "main",
      container_port: 3000,
      host_port: 8080,
      health_path: "/health",
    });
    await testPool.query(`UPDATE apps SET branch = 'other' WHERE id = $1`, [created.id]);
    const again = await agent.get(`/api/deployments/${res.body.id}`);
    expect(again.body.config_snapshot.branch).toBe("main");
  });

  test("if enqueueing fails the row is marked failed and the client gets a 503", async () => {
    const logSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    queue.add.mockRejectedValueOnce(new Error("redis is down"));
    const res = await agent.post(`/api/apps/${created.id}/deployments`);
    expect(res.status).toBe(503);

    const { rows } = await testPool.query("SELECT status, error_summary, finished_at FROM deployments");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error_summary).toMatch(/enqueue/i);
    expect(rows[0].finished_at).not.toBeNull();
    expect(JSON.stringify(res.body)).not.toMatch(/redis is down/); // internals are not leaked
    expect(logSpy).toHaveBeenCalledWith("Enqueue failed:", "redis is down"); // but they are logged server-side
  });

  test("without a queue configured it is a 503 and creates no row", async () => {
    const noQueueAgent = request.agent(await makeApp());
    await noQueueAgent.post("/api/auth/login").send({ username: "admin", password: PASSWORD });
    const res = await noQueueAgent.post(`/api/apps/${created.id}/deployments`);
    expect(res.status).toBe(503);
    const { rows } = await testPool.query("SELECT count(*)::int AS n FROM deployments");
    expect(rows[0].n).toBe(0);
  });

  test("an unknown app is a 404 and enqueues nothing", async () => {
    const res = await agent.post("/api/apps/00000000-0000-0000-0000-000000000000/deployments");
    expect(res.status).toBe(404);
    expect(queue.add).not.toHaveBeenCalled();
  });

  test("history lists newest first", async () => {
    const first = (await agent.post(`/api/apps/${created.id}/deployments`)).body;
    const second = (await agent.post(`/api/apps/${created.id}/deployments`)).body;
    const res = await agent.get(`/api/apps/${created.id}/deployments`);
    expect(res.status).toBe(200);
    expect(res.body.map((d) => d.id)).toEqual([second.id, first.id]);
  });

  test("a single deployment can be fetched, unknown ones are 404", async () => {
    const dep = (await agent.post(`/api/apps/${created.id}/deployments`)).body;
    expect((await agent.get(`/api/deployments/${dep.id}`)).status).toBe(200);
    expect((await agent.get("/api/deployments/00000000-0000-0000-0000-000000000000")).status).toBe(404);
    expect((await agent.get("/api/deployments/nope")).status).toBe(404);
  });

  test("state-changing requests from a foreign origin are rejected", async () => {
    const res = await agent.post(`/api/apps/${created.id}/deployments`).set("Origin", "http://evil.example");
    expect(res.status).toBe(403);
    expect(queue.add).not.toHaveBeenCalled();
  });
});
