// Restoring an app's volumes: matching, the three modes, the read-back, what is left behind when it fails. A fake Docker whose volumes are folders (the helper's
// script is the real one, run with sh against those folders); the backup files are made by the real makeVolumeBackup, opened by the real openBackup.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeVolumeBackup } from '../src/volumebackup.js';
import { makeRestore, countEntries, SCRIPTS } from '../src/volumerestore.js';

const GB = 1024 ** 3;
const PASS = 'correct horse battery staple';
const APP = { id: 'a1111111-1111-4111-8111-111111111111', name: 'Blog', slug: 'blog' };
let dir; let vols; let volumes; let calls;

const exists = (p) => access(p).then(() => true, () => false);
const tree = async (d, base = d) => {
  const out = [];
  for (const e of await readdir(d, { withFileTypes: true })) {
    const full = join(d, e.name);
    if (e.isDirectory()) out.push(...await tree(full, base)); else out.push(`${full.slice(base.length + 1)}=${await readFile(full, 'utf8')}`);
  }
  return out.sort();
};

// The fake Docker: vols[name] is the folder of a volume.
const engine = (over = {}) => ({
  ownImage: async () => 'sha256:worker',
  appImage: async () => 'sha256:app',
  diskSpace: async () => ({ totalBytes: 100 * GB, freeBytes: 90 * GB }),
  createRestoreHelper: async ({ image, volumes: names, script }) => {
    calls.helpers.push({ image, names, script });
    return { names, script, remove: async () => { calls.removed += 1; } };
  },
  runRestoreScript: async (h) => {
    const dirs = h.names.map((n) => vols[n]);
    const script = h.script.replace('/vrestore/*', dirs.join(' ')); // the real script, run against the folders
    try {
      const out = execFileSync('sh', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0, output: out };
    } catch (err) {
      let out = String(err.stdout ?? '');
      dirs.forEach((d, i) => { out = out.replaceAll(d, `/vrestore/${i}`); });
      return { code: err.status, output: out.trim() };
    }
  },
  putVolumeArchive: async (h, i, file) => { calls.put.push(i); execFileSync('tar', ['xf', file, '-C', vols[h.names[i]]]); },
  archiveVolume: async (h, i, file, mount) => { calls.archived.push(mount); execFileSync('tar', ['cf', file, '-C', vols[h.names[i]], '.']); },
  ...over,
});

// A backup file of two volumes: /data has a.txt and sub/b.txt, /up has pic.png
async function backupFile(passphrase = null) {
  const src = [await mkdtemp(join(tmpdir(), 'rs-s0-')), await mkdtemp(join(tmpdir(), 'rs-s1-'))];
  await mkdir(join(src[0], 'sub'));
  await writeFile(join(src[0], 'a.txt'), 'from the backup');
  await writeFile(join(src[0], 'sub', 'b.txt'), 'nested');
  await writeFile(join(src[1], 'pic.png'), 'png');
  const eng = {
    appImage: async () => 'img', volumeSizes: async () => new Map(), diskSpace: async () => ({ totalBytes: 100 * GB, freeBytes: 90 * GB }),
    createBackupHelper: async () => ({ remove: async () => {} }),
    archiveVolume: async (h, i, file) => execFileSync('tar', ['cf', file, '-C', src[i], '.']),
  };
  const out = await mkdtemp(join(tmpdir(), 'rs-b-'));
  const r = await makeVolumeBackup({ id: '12345678-aaaa-4bbb-8ccc-1234567890ab', trigger: 'manual', dir: out, app: APP, volumes: [{ container_path: '/data', docker_name: 'v-data' }, { container_path: '/up', docker_name: 'v-up' }], passphrase, eng });
  return join(out, r.filename);
}
const restore = async (o = {}) => makeRestore({ file: await backupFile(), mode: 'replace', volumes, app: APP, dir, eng: engine(), ...o });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rs-dir-'));
  vols = { 'v-data': await mkdtemp(join(tmpdir(), 'rs-v0-')), 'v-up': await mkdtemp(join(tmpdir(), 'rs-v1-')), 'v-other': await mkdtemp(join(tmpdir(), 'rs-v2-')) };
  await writeFile(join(vols['v-data'], 'a.txt'), 'CURRENT');
  await writeFile(join(vols['v-data'], 'stale.txt'), 'only in the current volume');
  await mkdir(join(vols['v-up'], 'old')); await writeFile(join(vols['v-up'], 'old', 'x.txt'), 'old');
  await writeFile(join(vols['v-other'], 'keep.txt'), 'not in the backup');
  volumes = [
    { container_path: '/data', docker_name: 'v-data' }, { container_path: '/up', docker_name: 'v-up' }, { container_path: '/other', docker_name: 'v-other' },
  ];
  calls = { helpers: [], removed: 0, put: [], archived: [] };
});

describe('replace', () => {
  test('the volume ends up exactly as the backup was: changed files restored, files the backup lacks removed, folders too', async () => {
    const r = await restore();
    assert.deepEqual(r, { volumeCount: 2, paths: ['/data', '/up'], addedPaths: [] });
    assert.deepEqual(await tree(vols['v-data']), ['a.txt=from the backup', 'sub/b.txt=nested']);
    assert.deepEqual(await tree(vols['v-up']), ['pic.png=png']);
    assert.equal(await exists(join(vols['v-up'], 'old')), false);
  });
  test('a volume of the app that is not in the backup is not even mounted into the helper, and is left alone', async () => {
    await restore();
    assert.deepEqual(calls.helpers[0].names, ['v-data', 'v-up']);
    assert.deepEqual(await tree(vols['v-other']), ['keep.txt=not in the backup']);
  });
  test('the helper is the worker\'s own image (it has sh and find); the app\'s image only when the worker is not in a container', async () => {
    await restore();
    assert.equal(calls.helpers[0].image, 'sha256:worker');
    await restore({ eng: engine({ ownImage: async () => null }) });
    assert.equal(calls.helpers[1].image, 'sha256:app');
  });
  test('with no worker image and no image of the app (never deployed) it says why, before anything is changed', async () => {
    await assert.rejects(restore({ eng: engine({ ownImage: async () => null, appImage: async () => { throw new Error('The app has no container') } }) }), /no image to run the restore helper with/);
    assert.equal(calls.helpers.length, 0);
    assert.deepEqual(await tree(vols['v-data']), ['a.txt=CURRENT', 'stale.txt=only in the current volume']);
  });
  test('the helper is removed and the work folder is gone, with nothing else left in the backups folder', async () => {
    await restore();
    assert.equal(calls.removed, 1);
    assert.deepEqual(await readdir(dir), []);
  });
  test('what was written is read back from the volumes (the restore helper\'s folders, not the backup helper\'s)', async () => {
    await restore();
    assert.deepEqual(calls.archived, ['vrestore', 'vrestore']);
  });
});

describe('add', () => {
  test('the backup\'s files are written over the current ones and files only in the volume stay', async () => {
    await restore({ mode: 'add' });
    assert.deepEqual(await tree(vols['v-data']), ['a.txt=from the backup', 'stale.txt=only in the current volume', 'sub/b.txt=nested']);
    assert.deepEqual(await tree(vols['v-up']), ['old/x.txt=old', 'pic.png=png']);
  });
});

describe('only into an empty volume', () => {
  test('refuses when a volume holds anything, says which, and changes nothing', async () => {
    await assert.rejects(restore({ mode: 'empty' }), (err) => /The volume at \/data is not empty/.test(err.message) && err.partial !== true);
    assert.deepEqual(calls.put, []);
    assert.deepEqual(await tree(vols['v-data']), ['a.txt=CURRENT', 'stale.txt=only in the current volume']);
    assert.equal(calls.removed, 1);
  });
  test('names the second volume when only that one is not empty', async () => {
    await rmAll(vols['v-data']);
    await assert.rejects(restore({ mode: 'empty' }), /The volume at \/up is not empty/);
  });
  test('works when they are empty, and reads back exactly what the backup held', async () => {
    await rmAll(vols['v-data']); await rmAll(vols['v-up']);
    const r = await restore({ mode: 'empty' });
    assert.equal(r.volumeCount, 2);
    assert.deepEqual(await tree(vols['v-data']), ['a.txt=from the backup', 'sub/b.txt=nested']);
  });
});
async function rmAll(d) { for (const e of await readdir(d)) execFileSync('rm', ['-rf', join(d, e)]); }

describe('before anything is changed', () => {
  test('a path the app no longer has storage at is refused, naming it; nothing is touched', async () => {
    await assert.rejects(restore({ volumes: volumes.filter((v) => v.container_path !== '/up') }), /no persistent storage at \/up any more/);
    assert.equal(calls.helpers.length, 0);
    assert.deepEqual(await tree(vols['v-data']), ['a.txt=CURRENT', 'stale.txt=only in the current volume']);
  });
  test('several missing paths are all named', async () => {
    await assert.rejects(restore({ volumes: [] }), /at \/data, \/up any more/);
  });
  test('not enough free disk is refused with the sizes', async () => {
    await assert.rejects(restore({ eng: engine({ diskSpace: async () => ({ totalBytes: 1000 * 1024 ** 2, freeBytes: 50 * 1024 ** 2 }) }) }), /Not enough free disk space/);
    assert.equal(calls.helpers.length, 0);
  });
  test('a backup of something else (no volumes in it) is refused', async () => {
    const tarDir = await mkdtemp(join(tmpdir(), 'rs-x-'));
    await writeFile(join(tarDir, 'db.dump'), 'x'); await writeFile(join(tarDir, 'manifest.json'), JSON.stringify({ format: 1 }));
    const file = join(await mkdtemp(join(tmpdir(), 'rs-y-')), 'shipdok-backup.tar');
    execFileSync('tar', ['cf', file, '-C', tarDir, 'db.dump', 'manifest.json']);
    await assert.rejects(makeRestore({ file, mode: 'replace', volumes, app: APP, dir, eng: engine() }), /not a backup of an app's volumes/);
  });
  test('a backup whose manifest is of another kind is refused even if it lists volumes', async () => {
    const tarDir = await mkdtemp(join(tmpdir(), 'rs-k-'));
    await writeFile(join(tarDir, 'volume-0.tar'), 'x');
    await writeFile(join(tarDir, 'manifest.json'), JSON.stringify({ format: 1, kind: 'platform', files: ['volume-0.tar', 'manifest.json'], volumes: [{ file: 'volume-0.tar', containerPath: '/data', bytes: 1 }] }));
    const file = join(await mkdtemp(join(tmpdir(), 'rs-k2-')), 'shipdok-backup.tar');
    execFileSync('tar', ['cf', file, '-C', tarDir, 'volume-0.tar', 'manifest.json']);
    await assert.rejects(makeRestore({ file, mode: 'replace', volumes, app: APP, dir, eng: engine() }), /does not look like a Shipdok backup|not a backup of an app's volumes/);
  });
  test('an unknown mode is refused', async () => {
    await assert.rejects(restore({ mode: 'wipe-everything' }), /Unknown restore mode/);
  });
  test('beforeWrite (the safety backup) runs after the checks and before the first change; if it fails nothing is changed', async () => {
    const seen = [];
    await restore({ beforeWrite: async () => { seen.push(await tree(vols['v-data']), calls.helpers.length); } });
    assert.deepEqual(seen, [['a.txt=CURRENT', 'stale.txt=only in the current volume'], 0]);
    await assert.rejects(restore({ beforeWrite: async () => { throw new Error('safety backup failed'); } }), (err) => err.message === 'safety backup failed' && err.partial !== true);
    assert.deepEqual(await tree(vols['v-data']), ['a.txt=from the backup', 'sub/b.txt=nested'], '(the earlier, successful restore is what is there)');
  });
  test('beforeWrite is not called when a check fails first', async () => {
    let called = false;
    await assert.rejects(restore({ volumes: [], beforeWrite: async () => { called = true; } }));
    assert.equal(called, false);
  });
});

describe('a reclaim (paths the app lacks are added)', () => {
  // The app has /data but not /up; the backup holds both. `provision` records what it was asked to add and makes the folder the fake volume needs.
  const lacking = () => volumes.filter((v) => v.container_path === '/data');
  const provisioner = (over = {}) => {
    const added = [];
    return { added, fn: async (planned) => { added.push(...planned.map((v) => ({ ...v }))); for (const v of planned) vols[v.docker_name] = await mkdtemp(join(tmpdir(), 'rs-new-')); if (over.fail) throw over.fail; } };
  };
  test('without provision a missing path is refused, as before (a restore into the backup\'s own app)', async () => {
    await assert.rejects(restore({ volumes: lacking() }), /no persistent storage at \/up any more/);
  });
  test('with it the missing path gets a NEW volume (a shipdok-vol- name of its own), and the files go in', async () => {
    const p = provisioner();
    const r = await restore({ volumes: lacking(), provision: p.fn });
    assert.deepEqual([r.volumeCount, r.addedPaths], [2, ['/up']]);
    assert.equal(p.added.length, 1);
    assert.equal(p.added[0].container_path, '/up');
    assert.match(p.added[0].docker_name, /^shipdok-vol-[0-9a-f-]{36}$/);
    assert.deepEqual(await tree(vols[p.added[0].docker_name]), ['pic.png=png']);
    assert.deepEqual(await tree(vols['v-data']), ['a.txt=from the backup', 'sub/b.txt=nested']);
  });
  test('an app with NO storage at all gets every path added, and nothing existing is touched', async () => {
    const p = provisioner();
    const seen = [];
    const r = await restore({ volumes: [], provision: p.fn, beforeWrite: async (info) => { seen.push(info); } });
    assert.deepEqual(r.addedPaths, ['/data', '/up']);
    assert.deepEqual(seen, [{ touchesExisting: false }]);
    assert.deepEqual(await tree(vols['v-data']), ['a.txt=CURRENT', 'stale.txt=only in the current volume'], 'the volume of that name that already existed in the fake Docker is not the new one');
  });
  test('beforeWrite is told whether a volume that exists now will be written to', async () => {
    const seen = [];
    await restore({ volumes: lacking(), provision: provisioner().fn, beforeWrite: async (info) => { seen.push(info); } });
    assert.deepEqual(seen, [{ touchesExisting: true }]);
  });
  test('the helper mounts the new volumes too, in the backup\'s order', async () => {
    const p = provisioner();
    await restore({ volumes: lacking(), provision: p.fn });
    assert.deepEqual(calls.helpers[0].names, ['v-data', p.added[0].docker_name]);
  });
  test('provisioning happens after every check and after beforeWrite, never before', async () => {
    const order = [];
    const p = provisioner();
    await restore({ volumes: lacking(), provision: async (x) => { order.push('provision'); return p.fn(x); }, beforeWrite: async () => { order.push('beforeWrite'); } });
    assert.deepEqual(order, ['beforeWrite', 'provision']);
    order.length = 0;
    await assert.rejects(restore({ volumes: lacking(), provision: async () => { order.push('provision'); }, eng: engine({ diskSpace: async () => ({ totalBytes: 1000 * 1024 ** 2, freeBytes: 50 * 1024 ** 2 }) }) }), /Not enough free disk space/);
    assert.deepEqual(order, [], 'a refused restore adds nothing');
  });
  test('the paths are held to the rules for a path typed in Settings, together with what the app has: nested ones are refused', async () => {
    const nested = [{ container_path: '/data/inner', docker_name: 'v-x' }];
    await assert.rejects(restore({ volumes: nested, provision: provisioner().fn }), /cannot be added to the app: \/data\/inner is inside \/data/);
  });
  test('more than ten paths in all are refused', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ container_path: `/p${i}`, docker_name: `v-p${i}` }));
    await assert.rejects(restore({ volumes: many, provision: provisioner().fn }), /at most 10/);
  });
  test('a path in the file that is not a usable path (made by hand) is refused', async () => {
    const tarDir = await mkdtemp(join(tmpdir(), 'rs-bad-'));
    await writeFile(join(tarDir, 'volume-0.tar'), 'x');
    await writeFile(join(tarDir, 'manifest.json'), JSON.stringify({ format: 1, kind: 'volumes', files: ['volume-0.tar', 'manifest.json'], volumes: [{ file: 'volume-0.tar', containerPath: '/proc/evil', bytes: 1 }] }));
    const file = join(await mkdtemp(join(tmpdir(), 'rs-bad2-')), 'shipdok-volumes.tar');
    execFileSync('tar', ['cf', file, '-C', tarDir, 'volume-0.tar', 'manifest.json']);
    await assert.rejects(makeRestore({ file, mode: 'replace', volumes: [], app: APP, dir, eng: engine(), provision: provisioner().fn }), /storage path that cannot be used/);
  });
  test('a failure in provisioning stops everything before any file is written, and is partial (rows may be added)', async () => {
    const p = provisioner({ fail: new Error('A path of the backup was taken in the meantime') });
    await assert.rejects(restore({ volumes: lacking(), provision: p.fn }), (err) => err.partial === true && /taken in the meantime/.test(err.message));
    assert.deepEqual(calls.put, []);
  });
  test('the three modes all work into a new volume (it is empty)', async () => {
    for (const mode of ['replace', 'add', 'empty']) {
      const p = provisioner();
      const r = await restore({ mode, volumes: [], provision: p.fn });
      assert.equal(r.volumeCount, 2, mode);
    }
  });
});

describe('encrypted backups', () => {
  test('open with the passphrase, and only with it', async () => {
    const file = await backupFile(PASS);
    await makeRestore({ file, passphrase: PASS, mode: 'replace', volumes, app: APP, dir, eng: engine() });
    assert.deepEqual(await tree(vols['v-up']), ['pic.png=png']);
    await assert.rejects(makeRestore({ file, passphrase: 'another passphrase entirely', mode: 'replace', volumes, app: APP, dir, eng: engine() }), /wrong passphrase/);
    await assert.rejects(makeRestore({ file, mode: 'replace', volumes, app: APP, dir, eng: engine() }), /encrypted/);
  });
  test('a wrong passphrase changes nothing', async () => {
    const file = await backupFile(PASS);
    await assert.rejects(makeRestore({ file, passphrase: 'another passphrase entirely', mode: 'replace', volumes, app: APP, dir, eng: engine() }));
    assert.deepEqual(await tree(vols['v-data']), ['a.txt=CURRENT', 'stale.txt=only in the current volume']);
    assert.deepEqual(await readdir(dir), []);
  });
});

describe('when something goes wrong half way', () => {
  test('a failure while writing is marked partial, the helper is removed, no temporary folder stays', async () => {
    const eng = engine({ putVolumeArchive: async (h, i, file) => { if (i === 1) throw new Error('docker: no space left'); execFileSync('tar', ['xf', file, '-C', vols[h.names[i]]]); } });
    await assert.rejects(restore({ eng }), (err) => err.partial === true && /no space left/.test(err.message));
    assert.equal(calls.removed, 1);
    assert.deepEqual(await readdir(dir), []);
  });
  test('a failure while writing is partial in add mode too (the first file may already be half there)', async () => {
    const eng = engine({ putVolumeArchive: async () => { throw new Error('docker: boom'); } });
    await assert.rejects(restore({ mode: 'add', eng }), (err) => err.partial === true);
  });
  test('a replace that finds MORE in the volume than the backup held is an error (something was not removed)', async () => {
    const eng = engine({ archiveVolume: async (h, i, file) => { await writeFile(join(vols[h.names[i]], 'leftover.txt'), 'x'); execFileSync('tar', ['cf', file, '-C', vols[h.names[i]], '.']); } });
    await assert.rejects(restore({ eng }), /do not match the backup/);
  });
  test('a script that fails is partial for a replace (files may be gone) but not for add', async () => {
    const failing = engine({ runRestoreScript: async () => ({ code: 1, output: 'find: cannot delete' }) });
    await assert.rejects(restore({ eng: failing }), (err) => err.partial === true && /could not be prepared: find: cannot delete/.test(err.message));
    await assert.rejects(restore({ mode: 'add', eng: failing }), (err) => err.partial !== true);
  });
  test('a restore that does not read back the same is an error', async () => {
    const eng = engine({ archiveVolume: async (h, i, file) => { await mkdir(join(dir, 'e'), { recursive: true }); execFileSync('tar', ['cf', file, '-C', join(dir, 'e'), '.']); } });
    await assert.rejects(restore({ eng }), (err) => err.partial === true && /do not match the backup \(1 entries found, 4 expected\)/.test(err.message));
  });
  test('after an add, more entries than the backup held is fine, fewer is not', async () => {
    await restore({ mode: 'add' }); // (the volume holds more than the backup)
    const eng = engine({ archiveVolume: async (h, i, file) => { await mkdir(join(dir, 'e2'), { recursive: true }); execFileSync('tar', ['cf', file, '-C', join(dir, 'e2'), '.']); } });
    await assert.rejects(restore({ mode: 'add', eng }), /do not match/);
  });
});

describe('the scripts', () => {
  test('replace empties a volume including dot files and folders, and never the folder itself', async () => {
    const d = await mkdtemp(join(tmpdir(), 'rs-sc-'));
    await mkdir(join(d, '.hidden', 'deep'), { recursive: true }); await writeFile(join(d, '.hidden', 'deep', 'x'), 'x'); await writeFile(join(d, '.env'), 'e'); await writeFile(join(d, 'f'), 'f');
    execFileSync('sh', ['-c', SCRIPTS.replace.replace('/vrestore/*', d)]);
    assert.deepEqual(await readdir(d), []);
  });
  test('empty exits with 3 and names the folder when anything, even a dot file, is there', async () => {
    const d = await mkdtemp(join(tmpdir(), 'rs-sc2-'));
    execFileSync('sh', ['-c', SCRIPTS.empty.replace('/vrestore/*', d)]);
    await writeFile(join(d, '.dot'), 'x');
    assert.throws(() => execFileSync('sh', ['-c', SCRIPTS.empty.replace('/vrestore/*', d)], { stdio: 'pipe' }), (err) => err.status === 3 && String(err.stdout).trim() === d);
  });
});

describe('counting entries', () => {
  test('counts what tar lists', async () => {
    const d = await mkdtemp(join(tmpdir(), 'rs-c-')); await writeFile(join(d, 'a'), 'a'); await mkdir(join(d, 'b'));
    const f = join(await mkdtemp(join(tmpdir(), 'rs-c2-')), 'x.tar');
    execFileSync('tar', ['cf', f, '-C', d, '.']);
    assert.equal(await countEntries(f), 3);
    await assert.rejects(countEntries(join(d, 'a')), /tar failed/);
  });
});
