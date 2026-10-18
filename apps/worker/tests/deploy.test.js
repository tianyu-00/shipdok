// deploy()'s orchestration against a fake engine: order of steps, cleanup, swap, rollback and cancellation.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { deploy } from "../src/deploy.js";
import { fakeEngine, abortError } from "./fake-engine.js";

const BASE = {
  repo: "https://github.com/o/r.git",
  appId: "app-1",
  slug: "my-app",
  deploymentId: "dep-1",
  containerPort: 3000,
  hostPort: 8080,
  log: () => {},
};
const IMAGE = "shipdok/my-app:dep-1";
const run = (opts, eng) => deploy({ ...BASE, ...opts }, eng);

describe("a normal deployment", () => {
  test("runs the steps in order and replaces the old container only after the candidate is healthy", async () => {
    const eng = fakeEngine({ previous: ["old"] });
    const r = await run({}, eng);
    assert.equal(r.ok, true);
    assert.deepEqual(eng.events, [
      "run git clone",
      "run docker build",
      "create shipdok-my-app-dep-1-candidate port=temp",
      "start shipdok-my-app-dep-1-candidate",
      "health shipdok-my-app-dep-1-candidate",
      "remove shipdok-my-app-dep-1-candidate",
      "stop old",
      "create shipdok-my-app-dep-1-live port=8080",
      "start shipdok-my-app-dep-1-live",
      "health shipdok-my-app-dep-1-live",
      "remove old",
    ]);
  });

  test("reports progress and the resolved commit through its hooks, and cleans up the temp directory", async () => {
    const eng = fakeEngine();
    const seen = [];
    await run({ onStatus: (s) => seen.push(s), onCommit: (c) => seen.push(`commit:${c}`) }, eng);
    assert.deepEqual(seen, ["commit:abc123def", "starting", "validating"]);
    assert.ok(eng.workDir && !existsSync(eng.workDir), "the clone directory must be removed");
  });

  test("a hook that throws cannot break the deployment", async () => {
    const r = await run(
      {
        onStatus: () => {
          throw new Error("boom");
        },
      },
      fakeEngine(),
    );
    assert.equal(r.ok, true);
  });
});

describe("building an exact commit (webhook pushes)", () => {
  const COMMIT = "c".repeat(40);

  test("fetches that commit instead of cloning the branch head", async () => {
    const eng = fakeEngine({ head: COMMIT });
    const r = await run({ commit: COMMIT }, eng);
    assert.equal(r.ok, true);
    assert.deepEqual(eng.events.slice(0, 5), [
      "run git init",
      "run git remote",
      "run git fetch",
      "run git checkout",
      "run docker build",
    ]);
    assert.ok(!eng.events.includes("run git clone"));
    const fetch = eng.runs.find((x) => x.args.includes("fetch"));
    assert.ok(fetch.args.includes(COMMIT), "the exact commit is what gets fetched");
    assert.equal(fetch.args.at(-2), "--", "the commit must come after -- so git can never read it as an option");
    assert.equal(fetch.args.at(-1), COMMIT);
    assert.deepEqual(eng.runs.find((x) => x.args.includes("remote")).args.slice(-3), ["add", "origin", BASE.repo]);
    assert.ok(!existsSync(eng.workDir));
  });

  test("records the commit that was really checked out", async () => {
    const seen = [];
    await run({ commit: COMMIT, onCommit: (c) => seen.push(c) }, fakeEngine({ head: COMMIT }));
    assert.deepEqual(seen, [COMMIT]);
  });

  test("refuses to build if git ends up on a different commit, before anything is built or started", async () => {
    const eng = fakeEngine({ previous: ["old"], head: "d".repeat(40) });
    const r = await run({ commit: COMMIT }, eng);
    assert.equal(r.ok, false);
    assert.match(r.error, /does not match the requested one/);
    assert.ok(!eng.events.includes("run docker build"));
    assert.ok(!eng.events.some((e) => e.includes("old") || e.startsWith("create")));
    assert.ok(!existsSync(eng.workDir));
  });

  for (const [label, commit] of [
    ["a git option", "--upload-pack=evil"],
    ["a branch name", "main"],
    ["an abbreviated commit", "abc1234"],
    ["uppercase hex", "C".repeat(40)],
    ["a commit with a trailing newline", `${"c".repeat(40)}\n`],
    ["a commit with a space", `${"c".repeat(39)} `],
    ["an empty string", ""],
    ["a number", 12345],
  ]) {
    test(`rejects ${label} before any side effect`, async () => {
      const eng = fakeEngine();
      const r = await run({ commit }, eng);
      assert.deepEqual([r.ok, r.error], [false, "Invalid commit id"]);
      assert.deepEqual(eng.events, []);
    });
  }

  test("a 64-character (SHA-256) commit id is accepted", async () => {
    const sha256 = "e".repeat(64);
    assert.equal((await run({ commit: sha256 }, fakeEngine({ head: sha256 }))).ok, true);
  });

  test("without a commit the old clone behaviour is unchanged", async () => {
    const eng = fakeEngine();
    await run({}, eng);
    assert.equal(eng.events[0], "run git clone");
  });

  test("a stop during the fetch is clean, like any other stage", async () => {
    const ctl = new AbortController();
    const eng = fakeEngine({
      onRun: (cmd, args) => {
        if (args.includes("fetch")) {
          ctl.abort();
          throw abortError();
        }
      },
    });
    const r = await run({ commit: COMMIT, signal: ctl.signal }, eng);
    assert.deepEqual([r.ok, r.stopped], [false, true]);
    assert.ok(!existsSync(eng.workDir));
  });
});

describe("failures leave the running version alone", () => {
  test("a failed build never touches the live container", async () => {
    const eng = fakeEngine({
      previous: ["old"],
      onRun: (cmd) => {
        if (cmd === "docker") throw new Error("build failed");
      },
    });
    const r = await run({}, eng);
    assert.deepEqual([r.ok, r.error], [false, "build failed"]);
    assert.ok(!eng.events.some((e) => e.includes("old")));
    assert.ok(!existsSync(eng.workDir));
  });

  test("an unhealthy candidate is removed and the old container is never stopped", async () => {
    const eng = fakeEngine({
      previous: ["old"],
      health: {
        candidate: async () => {
          throw new Error("Health check timed out");
        },
      },
    });
    const r = await run({}, eng);
    assert.equal(r.ok, false);
    assert.match(r.error, /timed out/);
    assert.ok(eng.events.includes("remove shipdok-my-app-dep-1-candidate"));
    assert.ok(!eng.events.includes("stop old"));
    assert.ok(!existsSync(eng.workDir));
  });

  test("if the new live container is unhealthy, it is removed and the old one is restarted", async () => {
    const eng = fakeEngine({
      previous: ["old"],
      health: {
        live: async () => {
          throw new Error("Container exited early");
        },
      },
    });
    const r = await run({}, eng);
    assert.equal(r.ok, false);
    const tail = eng.events.slice(eng.events.indexOf("stop old"));
    assert.deepEqual(tail, [
      "stop old",
      "create shipdok-my-app-dep-1-live port=8080",
      "start shipdok-my-app-dep-1-live",
      "health shipdok-my-app-dep-1-live",
      "remove shipdok-my-app-dep-1-live",
      "start old",
    ]);
    assert.ok(!eng.events.includes("remove old"));
  });

  test("an escaping root directory is refused before anything happens", async () => {
    const eng = fakeEngine();
    const r = await run({ dir: "../x" }, eng);
    assert.equal(r.ok, false);
    assert.match(r.error, /inside the repository/);
    assert.deepEqual(eng.events, []);
  });
});

describe("cancellation before the swap", () => {
  test("aborting during the build stops cleanly: unused image removed, old container untouched", async () => {
    const ctl = new AbortController();
    const eng = fakeEngine({
      previous: ["old"],
      onRun: (cmd) => {
        if (cmd === "docker") {
          ctl.abort();
          throw abortError();
        }
      },
    });
    const r = await run({ signal: ctl.signal }, eng);
    assert.deepEqual([r.ok, r.stopped], [false, true]);
    assert.ok(eng.events.includes(`rmi ${IMAGE}`));
    assert.ok(!eng.events.some((e) => e.includes("old") || e.includes("candidate")));
    assert.ok(!existsSync(eng.workDir));
  });

  test("aborting while the candidate is starting removes the candidate and the image", async () => {
    const ctl = new AbortController();
    const eng = fakeEngine({
      previous: ["old"],
      health: {
        candidate: async () => {
          ctl.abort();
          throw abortError();
        },
      },
    });
    const r = await run({ signal: ctl.signal }, eng);
    assert.deepEqual([r.ok, r.stopped], [false, true]);
    assert.ok(eng.events.includes("remove shipdok-my-app-dep-1-candidate"));
    assert.ok(
      eng.events.includes(`rmi ${IMAGE}`),
      `the image must really be removed: ${eng.events.filter((e) => e.startsWith("rmi"))}`,
    );
    assert.ok(
      eng.events.indexOf("remove shipdok-my-app-dep-1-candidate") < eng.events.indexOf(`rmi ${IMAGE}`),
      "candidate must go first",
    );
    assert.ok(!eng.events.some((e) => e.startsWith("rmi-BLOCKED")));
    assert.ok(!eng.events.includes("stop old"));
    assert.ok(!existsSync(eng.workDir));
  });

  test("an abort that arrives between steps is noticed before the candidate starts", async () => {
    const ctl = new AbortController();
    const eng = fakeEngine({
      onRun: (cmd) => {
        if (cmd === "docker") ctl.abort();
      },
    }); // build "finishes" but the signal fired
    const r = await run({ signal: ctl.signal }, eng);
    assert.equal(r.stopped, true);
    assert.ok(!eng.events.some((e) => e.startsWith("create")));
  });

  test("a stop is not reported as a failure", async () => {
    const ctl = new AbortController();
    const eng = fakeEngine({
      health: {
        candidate: async () => {
          ctl.abort();
          throw abortError();
        },
      },
    });
    const r = await run({ signal: ctl.signal }, eng);
    assert.equal(r.error, undefined);
  });

  test("the gate can refuse the swap: candidate gone, image removed, old container untouched", async () => {
    const eng = fakeEngine({ previous: ["old"] });
    const r = await run({ beforeSwap: async () => ({ proceed: false, outcome: "superseded", by: "newer-id" }) }, eng);
    assert.deepEqual([r.ok, r.stopped, r.outcome, r.by], [false, true, "superseded", "newer-id"]);
    assert.ok(eng.events.includes("remove shipdok-my-app-dep-1-candidate"));
    assert.ok(eng.events.includes(`rmi ${IMAGE}`), "the image must really be removed");
    assert.ok(!eng.events.some((e) => e.startsWith("rmi-BLOCKED")));
    assert.ok(!eng.events.includes("stop old"));
    assert.ok(!eng.events.some((e) => e.includes("-live")));
    assert.ok(!existsSync(eng.workDir));
  });

  test("the gate runs after the candidate is healthy and before the old container is stopped", async () => {
    const eng = fakeEngine({ previous: ["old"] });
    await run(
      {
        beforeSwap: async () => {
          eng.events.push("GATE");
          return { proceed: true };
        },
      },
      eng,
    );
    const i = (e) => eng.events.indexOf(e);
    assert.ok(i("health shipdok-my-app-dep-1-candidate") < i("GATE"));
    assert.ok(i("GATE") < i("stop old"));
  });
});

describe("the swap is the point of no return", () => {
  test("an abort during the swap is ignored and the deployment completes", async () => {
    const ctl = new AbortController();
    const eng = fakeEngine({ previous: ["old"] });
    const r = await run(
      {
        signal: ctl.signal,
        beforeSwap: async () => {
          setImmediate(() => ctl.abort());
          return { proceed: true };
        }, // cancel lands right after the gate
      },
      eng,
    );
    assert.equal(r.ok, true);
    assert.ok(eng.events.includes("remove old"));
    assert.ok(!eng.events.includes("rmi shipdok/my-app:dep-1"));
  });

  test("a failure after the gate is a normal failure (with rollback), even if a stop was requested", async () => {
    const ctl = new AbortController();
    const eng = fakeEngine({
      previous: ["old"],
      health: {
        live: async () => {
          ctl.abort();
          throw new Error("Container exited early");
        },
      },
    });
    const r = await run({ signal: ctl.signal, beforeSwap: async () => ({ proceed: true }) }, eng);
    assert.equal(r.ok, false);
    assert.equal(r.stopped, undefined);
    assert.match(r.error, /exited early/);
    assert.ok(eng.events.includes("start old"));
    assert.ok(!eng.events.includes(`rmi ${IMAGE}`)); // a failed swap does not delete the image
  });
});
