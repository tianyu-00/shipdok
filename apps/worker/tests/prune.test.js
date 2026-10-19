// Image retention: which images stay, which go, and what is never touched. The database is real, Docker is a stand-in.
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/db.js';
import { pruneApp, removeDeploymentImage, processPruneJob } from '../src/prune.js';
import { pool, ready, reset, makeApp, makeDeployment } from './helpers.js';

before(ready);
beforeEach(reset);
after(() => pool.end());

const MB = 1024 * 1024;
const noLog = () => {};

// A stand-in for Docker's images: `images` is what exists for the app (tag -> the space only that image takes), `live` the
// image a live container runs. Every image also shows the layers all versions share (SHARED) in the size Docker reports for it.
const SHARED = 200 * 1024 * 1024;
function fakeDocker({ images = {}, live = null, inUse = [], appOf = null, layersFail = false, growBy = 0 } = {}) {
  const removed = [];
  const eng = {
    removed,
    asked: [],
    async findContainers() { return live ? [{ image: live }] : []; },
    async containerImage(c) { return c.image; },
    async listAppImages(appId) {
      eng.asked.push(appId);
      if (appOf && appOf !== appId) return [];
      return Object.entries(images).map(([tag, size]) => ({ tag, size: size + SHARED, deploymentId: tag.split(':')[1] ?? null }));
    },
    async imageLayersSize() {
      if (layersFail) throw new Error('df failed');
      return SHARED + Object.values(images).reduce((n, size) => n + size, 0) + (removed.length ? growBy : 0); // shared layers once, plus what each image adds
    },
    async removeImageStrict(tag) {
      if (!(tag in images)) return 'gone';
      if (inUse.includes(tag)) return 'in-use';
      removed.push(tag); delete images[tag]; return 'removed';
    },
    async imageInfo(tag) { return tag in images ? { size: images[tag], labels: {} } : null; },
  };
  return eng;
}

const SLUG = 'my-app';
// Makes n successful deployments (oldest first) with images, as a real run would leave behind.
async function versions(appId, n, { bytes = 100 * MB } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const id = await makeDeployment(appId);
    const image = `shipdok/${SLUG}:${id}`;
    await store.markSucceeded(id, image, bytes);
    out.push({ id, image });
  }
  return out;
}
const imagesOf = (vs, size = 100 * MB) => Object.fromEntries(vs.map((v) => [v.image, size]));
const row = async (id) => (await pool.query('SELECT image_removed_at FROM deployments WHERE id = $1', [id])).rows[0];
const setKeep = (appId, n) => pool.query('UPDATE apps SET keep_previous_images = $2 WHERE id = $1', [appId, n]);
const prune = (appId, eng, trigger = 'manual') => pruneApp({ appId, trigger }, { eng, db: store, log: noLog });

describe('what stays', () => {
  test('the live version and the one before it (the default); older images go', async () => {
    const appId = await makeApp();
    const vs = await versions(appId, 4); // v1 oldest ... v4 live
    const eng = fakeDocker({ images: imagesOf(vs), live: vs[3].image });
    const res = await prune(appId, eng);
    assert.deepEqual(eng.removed.sort(), [vs[0].image, vs[1].image].sort());
    assert.deepEqual([res.removed, res.freedBytes, res.skipped], [2, 200 * MB, 0]);
  });

  test('the removed versions are marked in the history; the kept ones are not', async () => {
    const appId = await makeApp();
    const vs = await versions(appId, 3);
    await prune(appId, fakeDocker({ images: imagesOf(vs), live: vs[2].image }));
    assert.notEqual((await row(vs[0].id)).image_removed_at, null);
    assert.equal((await row(vs[1].id)).image_removed_at, null);
    assert.equal((await row(vs[2].id)).image_removed_at, null);
  });

  test('keep_previous_images decides how many earlier versions stay: 0, 1 and 3', async () => {
    for (const [keep, expectRemoved] of [[0, 4], [1, 3], [3, 1]]) {
      await reset();
      const appId = await makeApp();
      await setKeep(appId, keep);
      const vs = await versions(appId, 5);
      const eng = fakeDocker({ images: imagesOf(vs), live: vs[4].image });
      await prune(appId, eng);
      assert.equal(eng.removed.length, expectRemoved, `keep ${keep}`);
      assert.ok(!eng.removed.includes(vs[4].image), 'the live image is never removed');
    }
  });

  test('with fewer versions than the limit, nothing is removed', async () => {
    const appId = await makeApp();
    const vs = await versions(appId, 2);
    const eng = fakeDocker({ images: imagesOf(vs), live: vs[1].image });
    assert.equal((await prune(appId, eng)).removed, 0);
    assert.deepEqual(eng.removed, []);
  });

  test('failed and cancelled deployments do not count as retained versions', async () => {
    const appId = await makeApp();
    const vs = await versions(appId, 2); // v1, v2 live
    const failed = await makeDeployment(appId);
    await store.markFailed(failed, 'boom');
    const eng = fakeDocker({ images: imagesOf(vs), live: vs[1].image });
    await prune(appId, eng);
    assert.deepEqual(eng.removed, [], 'the failed one took no slot: v1 is still the "previous"');
  });

  test('after a rollback the same image serves two deployments, and the newest TWO DISTINCT images are kept', async () => {
    const appId = await makeApp();
    const vs = await versions(appId, 3); // v1, v2, v3
    const back = await makeDeployment(appId); // rolled back to v2
    await store.markSucceeded(back, vs[1].image, 100 * MB);
    const eng = fakeDocker({ images: imagesOf(vs), live: vs[1].image });
    await prune(appId, eng);
    assert.deepEqual(eng.removed, [vs[0].image], 'v2 (live) and v3 (previous) stay');
  });
});

describe('going back and forth', () => {
  test('rolling back and forward again does not use up the slots of older versions', async () => {
    const appId = await makeApp();
    await setKeep(appId, 2);
    const vs = await versions(appId, 3); // v1, v2, v3
    for (const target of [vs[1], vs[2]]) { // back to v2, then forward to v3
      const id = await makeDeployment(appId);
      await store.markSucceeded(id, target.image, 100 * MB);
    }
    const eng = fakeDocker({ images: imagesOf(vs), live: vs[2].image });
    await prune(appId, eng);
    assert.deepEqual(eng.removed, [], 'live v3, then v2 and v1 are the three newest distinct versions');
  });
});

describe('what is never removed', () => {
  test('whatever the live container runs, even if the history does not list it', async () => {
    const appId = await makeApp();
    const vs = await versions(appId, 4);
    const stray = `shipdok/${SLUG}:99999999-9999-4999-8999-999999999999`;
    const eng = fakeDocker({ images: { ...imagesOf(vs), [stray]: 50 * MB }, live: stray });
    await prune(appId, eng);
    assert.ok(!eng.removed.includes(stray));
  });

  test('the image of a deployment that is still being built', async () => {
    const appId = await makeApp();
    const vs = await versions(appId, 3);
    const building = await makeDeployment(appId);
    await pool.query(`UPDATE deployments SET status = 'building' WHERE id = $1`, [building]);
    const mid = `shipdok/${SLUG}:${building}`;
    const eng = fakeDocker({ images: { ...imagesOf(vs), [mid]: 80 * MB }, live: vs[2].image });
    await prune(appId, eng);
    assert.ok(!eng.removed.includes(mid));
  });

  test('the image a queued rollback is going to reuse', async () => {
    const appId = await makeApp();
    const vs = await versions(appId, 4); // v4 live, v3 previous; v1 is the rollback target
    const queued = await makeDeployment(appId);
    await pool.query(`UPDATE deployments SET rollback_of = $2 WHERE id = $1`, [queued, vs[0].id]);
    const eng = fakeDocker({ images: imagesOf(vs), live: vs[3].image });
    await prune(appId, eng);
    assert.ok(!eng.removed.includes(vs[0].image));
    assert.ok(eng.removed.includes(vs[1].image), 'but the others still go');
  });

  test('an image a container still uses is skipped, counted, and NOT marked as removed', async () => {
    const appId = await makeApp();
    const vs = await versions(appId, 3);
    const eng = fakeDocker({ images: imagesOf(vs), live: vs[2].image, inUse: [vs[0].image] });
    const res = await prune(appId, eng);
    assert.deepEqual([res.removed, res.skipped], [0, 1]);
    assert.equal((await row(vs[0].id)).image_removed_at, null);
  });

  test('anything that is not shipdok/<name>:<deployment id>', async () => {
    const appId = await makeApp();
    const vs = await versions(appId, 3);
    const odd = { 'shipdok/my-app:latest': 1, 'shipdok/UPPER:11111111-1111-4111-8111-111111111111': 1, 'shipdok/../x:11111111-1111-4111-8111-111111111111': 1 };
    const eng = fakeDocker({ images: { ...imagesOf(vs), ...odd }, live: vs[2].image });
    await prune(appId, eng);
    for (const tag of Object.keys(odd)) assert.ok(!eng.removed.includes(tag), tag);
  });

  test('only images Docker lists for THIS app are ever candidates (ownership is the label filter)', async () => {
    const appId = await makeApp();
    const other = await makeApp();
    const mine = await versions(appId, 3);
    const eng = fakeDocker({ images: imagesOf(mine), live: mine[2].image, appOf: other });
    const res = await prune(appId, eng); // Docker says this app has no images
    assert.equal(res.removed, 0);
    assert.deepEqual(eng.asked, [appId]);
    assert.deepEqual(eng.removed, []);
  });

  test('logs and deployment records are untouched', async () => {
    const appId = await makeApp();
    const vs = await versions(appId, 3);
    const before = (await pool.query('SELECT count(*)::int AS n FROM deployments')).rows[0].n;
    await prune(appId, fakeDocker({ images: imagesOf(vs), live: vs[2].image }));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM deployments')).rows[0].n, before);
  });
});

describe('how much was freed', () => {
  test('is the space really released, not the sum of image sizes (versions share their base layers)', async () => {
    const appId = await makeApp();
    const vs = await versions(appId, 4);
    const res = await prune(appId, fakeDocker({ images: imagesOf(vs, 30 * MB), live: vs[3].image }));
    assert.equal(res.removed, 2);
    assert.equal(res.freedBytes, 60 * MB, 'two images of 30 MB of their own; the 200 MB base is still used by the others');
  });

  test('never negative, even if something else on the host used more space meanwhile', async () => {
    const appId = await makeApp();
    const vs = await versions(appId, 4);
    const res = await prune(appId, fakeDocker({ images: imagesOf(vs, 30 * MB), live: vs[3].image, growBy: 500 * MB }));
    assert.equal(res.freedBytes, 0);
  });

  test('if Docker cannot say, it says 0 rather than guessing', async () => {
    const appId = await makeApp();
    const vs = await versions(appId, 4);
    const res = await prune(appId, fakeDocker({ images: imagesOf(vs), live: vs[3].image, layersFail: true }));
    assert.equal(res.removed, 2);
    assert.equal(res.freedBytes, 0);
  });
});

describe('leftovers and drift', () => {
  test('images of failed or cancelled builds, which no record points at, are cleaned up', async () => {
    const appId = await makeApp();
    const vs = await versions(appId, 2);
    const failed = await makeDeployment(appId);
    await store.markFailed(failed, 'health check failed');
    const leftover = `shipdok/${SLUG}:${failed}`;
    const eng = fakeDocker({ images: { ...imagesOf(vs), [leftover]: 60 * MB }, live: vs[1].image });
    const res = await prune(appId, eng);
    assert.deepEqual(eng.removed, [leftover]);
    assert.equal(res.freedBytes, 60 * MB);
  });

  test('an image someone removed by hand is recorded as gone, so nobody tries to roll back to it', async () => {
    const appId = await makeApp();
    const vs = await versions(appId, 2);
    const images = imagesOf([vs[1]]); // v1's image is no longer in Docker
    await prune(appId, fakeDocker({ images, live: vs[1].image }));
    assert.notEqual((await row(vs[0].id)).image_removed_at, null);
    assert.equal((await row(vs[1].id)).image_removed_at, null);
  });

  test('"already gone" while removing counts as removed, and frees nothing', async () => {
    const appId = await makeApp();
    const vs = await versions(appId, 3);
    const eng = fakeDocker({ images: imagesOf(vs), live: vs[2].image });
    const real = eng.removeImageStrict;
    eng.removeImageStrict = async (tag) => { delete eng.images; return tag === vs[0].image ? 'gone' : real(tag); };
    const res = await prune(appId, eng);
    assert.equal(res.freedBytes, 0);
    assert.notEqual((await row(vs[0].id)).image_removed_at, null);
  });

  test('running it twice changes nothing the second time', async () => {
    const appId = await makeApp();
    const vs = await versions(appId, 4);
    const eng = fakeDocker({ images: imagesOf(vs), live: vs[3].image });
    await prune(appId, eng);
    const second = await prune(appId, eng);
    assert.deepEqual([second.removed, second.freedBytes], [0, 0]);
  });

  test('an app that no longer exists is skipped', async () => {
    const res = await prune('00000000-0000-4000-8000-000000000000', fakeDocker());
    assert.equal(res.skipped, true);
  });

  test('a Docker failure is an error for the job, and nothing is marked removed', async () => {
    const appId = await makeApp();
    const vs = await versions(appId, 3);
    const eng = fakeDocker({ images: imagesOf(vs), live: vs[2].image });
    eng.removeImageStrict = async () => { throw new Error('docker down'); };
    await assert.rejects(prune(appId, eng), /docker down/);
    assert.equal((await row(vs[0].id)).image_removed_at, null);
  });
});

describe('the summary of the last clean-up', () => {
  const summary = async (appId) => (await pool.query('SELECT * FROM app_cleanup WHERE app_id = $1', [appId])).rows[0];

  test('is recorded, with who asked for it', async () => {
    const appId = await makeApp();
    const vs = await versions(appId, 3);
    await prune(appId, fakeDocker({ images: imagesOf(vs), live: vs[2].image }), 'auto');
    const s = await summary(appId);
    assert.deepEqual([s.trigger, s.images_removed, Number(s.freed_bytes), s.skipped], ['auto', 1, 100 * MB, 0]);
  });

  test('a later clean-up replaces it', async () => {
    const appId = await makeApp();
    const vs = await versions(appId, 3);
    const eng = fakeDocker({ images: imagesOf(vs), live: vs[2].image });
    await prune(appId, eng, 'auto');
    await prune(appId, eng, 'manual');
    const s = await summary(appId);
    assert.deepEqual([s.trigger, s.images_removed], ['manual', 0]);
  });
});

describe('removing the image of a deployment that was just deleted', () => {
  const remove = (appId, image, eng) => removeDeploymentImage({ appId, image }, { eng, db: store, log: noLog });

  test('removes it when nothing needs it', async () => {
    const appId = await makeApp();
    const vs = await versions(appId, 3);
    const gone = `shipdok/${SLUG}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`; // its record is already deleted
    const eng = fakeDocker({ images: { ...imagesOf(vs), [gone]: 10 }, live: vs[2].image });
    const res = await remove(appId, gone, eng);
    assert.deepEqual([res.removed, eng.removed], [true, [gone]]);
  });

  test('keeps the live image and the retained previous one, whatever it is asked', async () => {
    const appId = await makeApp();
    const vs = await versions(appId, 3);
    const eng = fakeDocker({ images: imagesOf(vs), live: vs[2].image });
    assert.equal((await remove(appId, vs[2].image, eng)).removed, false);
    assert.equal((await remove(appId, vs[1].image, eng)).removed, false);
    assert.deepEqual(eng.removed, []);
  });

  test('an image that is not this app\'s own (not in its labelled listing) is never removed', async () => {
    const appId = await makeApp();
    const other = `shipdok/other:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
    const eng = fakeDocker({ images: {}, live: null });
    const res = await remove(appId, other, eng);
    assert.equal(res.removed, false);
    assert.deepEqual(eng.removed, []);
  });

  test('refuses a name that is not a Shipdok image tag', async () => {
    const appId = await makeApp();
    for (const bad of ['nginx:latest', '--force', 'shipdok/x:latest', '', 'shipdok/my-app:11111111-1111-4111-8111-111111111111 -f']) {
      await assert.rejects(remove(appId, bad, fakeDocker()), /not a shipdok image/i, bad);
    }
  });
});

describe('the job', () => {
  const job = (name, data) => ({ id: '9', name, data, log: async () => {} });

  test('needs a valid app id', async () => {
    for (const data of [undefined, {}, { appId: 'x' }, { appId: 5 }]) {
      await assert.rejects(processPruneJob(job('prune', data), { eng: fakeDocker(), db: store }), /app id/i);
    }
  });

  test('"removeimage" needs an image', async () => {
    const appId = await makeApp();
    await assert.rejects(processPruneJob(job('removeimage', { appId }), { eng: fakeDocker(), db: store }), /image/i);
  });

  test('"prune" with an unknown trigger is recorded as manual', async () => {
    const appId = await makeApp();
    const vs = await versions(appId, 3);
    await processPruneJob(job('prune', { appId, trigger: 'whatever' }), { eng: fakeDocker({ images: imagesOf(vs), live: vs[2].image }), db: store });
    assert.equal((await pool.query('SELECT trigger FROM app_cleanup WHERE app_id = $1', [appId])).rows[0].trigger, 'manual');
  });
});
