// Collects the app's own output into the app's log directory (one pair per APP, not per deployment):
//   runtime.log           the CURRENT run of the container (reset whenever it starts again, a new deployment included)
//   runtime.previous.log  the run before that (one generation), so the output of the run that crashed survives its restart
// The monitor calls sync() for every container it visits. A "run" is one start of a container: Docker keeps one log
// across restarts, so a run is told apart by the container's StartedAt (and by the container itself: a new deployment
// is a new container).
//
// Everything is resumable from the files themselves: the time of the last line written says where to continue, so a
// restart of the worker (or a dropped connection) neither loses lines nor repeats them.
import { rename, stat } from 'node:fs/promises';
import { createRedactor, runtimeLogPath, readTail } from '@shipdok/shared';
import { createLogSink } from './buildlog.js';
import { createDemuxer, parsePayload } from './dockerlogs.js';

export const DEFAULT_RUNTIME_MAX_BYTES = 100 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {object} o
 * @param {string} o.root                                   the log directory
 * @param {object} o.db                                     getRuntimeLog, openRuntimeLog, reopenRuntimeLog, recordPreviousLog, updateRuntimeLogBytes, closeRuntimeLog
 * @param {object} o.eng                                    followLogs, fetchLogs, containerFacts
 * @param {(appId: string) => Promise<string[]>} o.loadSecrets   values to mask in this app's output
 */
export function createCollector({ root, db, eng, loadSecrets, maxBytes = DEFAULT_RUNTIME_MAX_BYTES, now = Date.now, log = console.log }) {
  const runs = new Map(); // app id -> the run being collected (an app has one log, so one run at a time)
  const chains = new Map(); // app id -> the last operation on it, so two never overlap
  const settled = new Set(); // "container:run" whose output was brought up to date once since the worker started

  const serial = (key, fn) => {
    const previous = chains.get(key) ?? Promise.resolve();
    const result = previous.then(() => fn());
    chains.set(key, result.catch(() => {}));
    return result;
  };

  const sizeOf = async (file) => stat(file).then((s) => s.size, () => 0);

  // The time of the last line in the file: where to continue from.
  async function lastWrittenMs(file) {
    const tail = await readTail(file, 1);
    if (!tail?.text) return 0;
    const ms = Date.parse(tail.text.split(' ', 1)[0]);
    return Number.isFinite(ms) ? ms : 0;
  }

  // Feeds Docker's frames into the run's log. Lines at or before `floor` are already stored (a resume).
  function ingest(run, streamName, payload, floor) {
    for (const { date, text } of parsePayload(payload.toString('utf8'), new Date(now()))) {
      const ms = date.getTime();
      if (ms <= floor) continue;
      run.sink.line(streamName, text, date);
      if (ms > run.lastMs) run.lastMs = ms;
    }
    if (!run.capped && run.sink.stats().truncated) {
      run.capped = true; // stop reading; the log says it was cut short
      run.stream?.destroy?.();
    }
  }

  async function attach(run) {
    const floor = run.lastMs;
    const stream = await eng.followLogs(run.container, { since: floor ? floor + 1 : run.startedAt });
    const demux = createDemuxer((name, payload) => ingest(run, name, payload, floor));
    run.stream = stream;
    run.ended = false;
    stream.on('data', (chunk) => {
      try { demux.push(chunk); } catch { run.ended = true; stream.destroy?.(); } // corrupt stream: reconnect on the next look
    });
    for (const event of ['end', 'close', 'error']) stream.on(event, () => { if (run.stream === stream) run.ended = true; });
  }

  // Starts (or resumes) collecting one run of a container.
  async function begin(app, container, facts, { follow = true } = {}) {
    const { deploymentId } = facts;
    const file = runtimeLogPath(root, app.id, 'runtime');
    const row = await db.getRuntimeLog(app.id, 'runtime');
    const sameRun = row !== null && row.runStartedAt === facts.startedAt && row.containerId === container.id;
    const secrets = await loadSecrets(app.id); // first: if this fails nothing has been touched

    let lastMs = 0;
    if (sameRun) {
      lastMs = await lastWrittenMs(file);
      await db.reopenRuntimeLog(app.id);
    } else {
      // A new run: the log so far becomes "the previous run" (replacing any older one), and this run starts empty.
      const size = await sizeOf(file);
      if (size > 0) {
        await rename(file, runtimeLogPath(root, app.id, 'runtime_previous'));
        await db.recordPreviousLog(app.id, { deploymentId: row?.deploymentId ?? null, bytes: size, truncated: row?.truncated ?? false });
      }
      await db.openRuntimeLog(app.id, { deploymentId, containerId: container.id, startedAtMs: facts.startedAt });
    }

    const sink = createLogSink({
      file, redact: createRedactor(secrets), maxBytes, now: () => new Date(now()),
      startBytes: sameRun ? await sizeOf(file) : 0, startTruncated: sameRun && row.truncated,
    });
    const run = {
      container, appId: app.id, deploymentId, startedAt: facts.startedAt, sink, lastMs,
      stream: null, ended: false, capped: sameRun && row.truncated, flushedBytes: -1,
    };
    runs.set(app.id, run);
    if (follow && !run.capped) await attach(run);
    return run;
  }

  // Ends a run: reads whatever Docker still has that we do not (up to `until`, the moment the next run began), then closes.
  async function finish(run, { until = null } = {}) {
    run.stream?.destroy?.();
    run.stream = null;
    try {
      const buffer = await eng.fetchLogs(run.container, { since: run.lastMs ? run.lastMs + 1 : run.startedAt, until: until ?? undefined });
      const floor = run.lastMs;
      const demux = createDemuxer((name, payload) => ingest(run, name, payload, floor));
      demux.push(buffer);
    } catch (err) {
      log(`runtime log: could not read the rest of the output (${err.statusCode ?? err.message}); keeping what was collected`); // e.g. the container is gone
    }
    const stats = await run.sink.close();
    await db.closeRuntimeLog(run.appId, stats);
    runs.delete(run.appId);
    settled.add(`${run.container.id}:${run.startedAt}`);
  }

  // Bring up to date, once, an earlier run nobody is following (the worker restarted, or the container restarted
  // while we were away), and close it.
  async function catchUp(app, container, facts, runStartedAt, until) {
    const row = await db.getRuntimeLog(app.id, 'runtime');
    if (!row || row.runStartedAt !== runStartedAt || row.containerId !== container.id) return; // another container's run: its container is gone
    const run = await begin(app, container, { ...facts, startedAt: runStartedAt }, { follow: false });
    await finish(run, { until });
  }

  async function flushBytes(run) {
    const stats = run.sink.stats();
    if (stats.bytes === run.flushedBytes) return;
    run.flushedBytes = stats.bytes;
    await db.updateRuntimeLogBytes(run.appId, stats);
  }

  async function syncNow(app, container, facts) {
    if (!UUID_RE.test(facts.deploymentId ?? '') || !facts.startedAt) return; // not one of ours, or never started
    const live = facts.status === 'running' || facts.status === 'restarting';
    const current = runs.get(app.id);
    const mine = current && current.container.id === container.id ? current : null;
    // The app has a new container (a new deployment): the run of the old one ends here.
    if (current && !mine) await finish(current);

    if (live) {
      if (mine && mine.startedAt === facts.startedAt) {
        if (mine.ended && !mine.capped) await attach(mine); // the connection dropped: continue where we stopped
        await flushBytes(mine);
        return;
      }
      if (mine) {
        await finish(mine, { until: facts.startedAt }); // restarted: the old run ends where the new one began
      } else if (!current) {
        const row = await db.getRuntimeLog(app.id, 'runtime');
        if (row && row.runStartedAt !== null && row.runStartedAt !== facts.startedAt) {
          await catchUp(app, container, facts, row.runStartedAt, facts.startedAt); // restarted while we were away
        }
      }
      await begin(app, container, facts);
      return;
    }

    // Not running: this run is over. Read it to its end, once. The read stops a moment after the container exited, so
    // a later run of the same container (Docker keeps one log across restarts) can never leak into this one.
    const until = facts.finishedAt ? facts.finishedAt + 1000 : null;
    if (mine && mine.startedAt === facts.startedAt) {
      await finish(mine, { until });
      return;
    }
    if (mine) await finish(mine, { until: facts.startedAt }); // we were still on an earlier run: it ended where this one began

    const key = `${container.id}:${facts.startedAt}`;
    if (settled.has(key)) return;
    settled.add(key);

    const row = await db.getRuntimeLog(app.id, 'runtime');
    if (row && row.runStartedAt === facts.startedAt && row.containerId === container.id) {
      await catchUp(app, container, facts, facts.startedAt, until); // a run we had followed before the worker restarted
      return;
    }
    // A run we never saw while it was alive: it began and ended between two looks (a crash loop does this).
    // Bring an older, unfinished run of this container up to date first, then collect this one whole.
    if (!mine && row && row.runStartedAt !== null) await catchUp(app, container, facts, row.runStartedAt, facts.startedAt);
    const whole = await begin(app, container, facts, { follow: false });
    await finish(whole, { until });
  }

  return {
    /** Called by the monitor for a container it has just looked at. Never throws into the caller's crash handling: it may reject, the caller catches. */
    sync: (app, container, facts) => serial(app.id, () => syncNow(app, container, facts)),

    /** Before a container is removed (a redeploy): read the rest of its output and close its log. */
    drain: (container, { appId }) => serial(appId, async () => {
      let run = runs.get(appId);
      if (run && run.container.id !== container.id) return; // another container's output is being collected: not this one's
      if (!run) {
        const facts = await eng.containerFacts(container);
        if (!UUID_RE.test(facts.deploymentId ?? '') || !facts.startedAt) return;
        run = await begin({ id: appId }, container, facts, { follow: false });
      }
      await finish(run);
    }),

    /** The app is being deleted: stop following its output and close the file, without writing anything to the database (its rows go too). */
    release: (appId) => serial(appId, async () => {
      const run = runs.get(appId);
      if (!run) return;
      run.stream?.destroy?.();
      run.stream = null;
      await run.sink.close().catch(() => {});
      runs.delete(appId);
    }),

    /** The worker is shutting down: close every file and record its size. */
    async stopAll() {
      for (const run of [...runs.values()]) {
        run.stream?.destroy?.();
        const stats = await run.sink.close();
        await db.closeRuntimeLog(run.appId, stats).catch(() => {});
        runs.delete(run.appId);
      }
    },
  };
}
