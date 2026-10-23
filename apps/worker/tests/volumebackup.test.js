// Making a backup of an app's volumes: the files that go into it, the room check, the encryption, and what is left behind when it fails.
// A fake engine stands in for Docker (the "volumes" are folders; the copy is made by the real tar); the packing and the encryption are real.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKUP_FILE_RE, BACKUP_MAGIC, decryptBackupFile } from '@shipdok/shared';
import { makeVolumeBackup, checkRoom } from '../src/volumebackup.js';

const ID = '12345678-aaaa-4bbb-8ccc-1234567890ab';
const NOW = new Date('2026-10-22T03:04:05Z');
const APP = { id: 'a1111111-1111-4111-8111-111111111111', name: 'My Blog', slug: 'my-blog' };
const GB = 1024 ** 3;
let dir; let sources; let volumes;

// A fake Docker whose volumes are folders (sources[i]); records what was done to the helper.
const engine = (over = {}) => {
  const calls = { helpers: [], archived: [], removed: 0, images: [] };
  return {
    calls,
    appImage: async (appId) => { calls.images.push(appId); return 'sha256:image'; },
    createBackupHelper: async ({ image, volumes: names }) => { calls.helpers.push({ image, names }); return { remove: async () => { calls.removed += 1; } }; },
    archiveVolume: async (helper, i, file) => { calls.archived.push(i); execFileSync('tar', ['cf', file, '-C', sources[i], '.']); },
    volumeSizes: async () => new Map(),
    diskSpace: async () => ({ totalBytes: 100 * GB, freeBytes: 80 * GB }),
    ...over,
  };
};
const make = (o = {}) => makeVolumeBackup({ id: ID, trigger: 'manual', dir, app: APP, volumes, version: '0.1.19', eng: engine(), now: NOW, ...o });
const names = async () => (await readdir(dir)).sort();
const extract = async (file) => { const out = await mkdtemp(join(tmpdir(), 'vb-x-')); execFileSync('tar', ['xf', file, '-C', out]); return out; };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vb-dir-'));
  sources = [await mkdtemp(join(tmpdir(), 'vb-src0-')), await mkdtemp(join(tmpdir(), 'vb-src1-'))];
  await mkdir(join(sources[0], 'sub'));
  await writeFile(join(sources[0], 'sub', 'a.txt'), 'hello from volume zero');
  await writeFile(join(sources[0], '.hidden'), 'dot file');
  await symlink('sub/a.txt', join(sources[0], 'link'));
  await writeFile(join(sources[1], 'b.bin'), Buffer.from([0, 1, 2, 255]));
  volumes = [
    { container_path: '/data', docker_name: 'shipdok-vol-aaa', size_bytes: 1000 },
    { container_path: '/uploads', docker_name: 'shipdok-vol-bbb', size_bytes: null },
  ];
});

describe('a plain volume backup', () => {
  test('is one file with a name of ours (the app\'s name is not in it), and nothing else is left in the folder', async () => {
    const r = await make();
    assert.match(r.filename, BACKUP_FILE_RE);
    assert.equal(r.filename, 'shipdok-volumes-20261022-030405-12345678.tar');
    assert.deepEqual(await names(), [r.filename]);
    assert.deepEqual([r.encrypted, r.verified, r.version, r.warning, r.volumeCount], [false, true, '0.1.19', null, 2]);
    assert.equal(r.sizeBytes, (await stat(join(dir, r.filename))).size);
    assert.equal(((await stat(join(dir, r.filename))).mode & 0o777), 0o600);
  });

  test('holds every volume as its own tar, with a manifest that says whose they are and where each was mounted', async () => {
    const r = await make({ stopped: true });
    const x = await extract(join(dir, r.filename));
    assert.deepEqual((await readdir(x)).sort(), ['manifest.json', 'volume-0.tar', 'volume-1.tar']);
    const m = JSON.parse(await readFile(join(x, 'manifest.json'), 'utf8'));
    assert.deepEqual([m.format, m.kind, m.createdAt, m.shipdokVersion, m.trigger, m.appWasStopped], [1, 'volumes', NOW.toISOString(), '0.1.19', 'manual', true]);
    assert.deepEqual(m.app, APP);
    assert.deepEqual(m.volumes.map((v) => [v.file, v.containerPath, v.dockerName]), [['volume-0.tar', '/data', 'shipdok-vol-aaa'], ['volume-1.tar', '/uploads', 'shipdok-vol-bbb']]);
    assert.ok(m.volumes.every((v) => v.bytes > 0));
  });

  test('the files come back as they were: content, dot files, links', async () => {
    const r = await make();
    const x = await extract(join(dir, r.filename));
    const back = await mkdtemp(join(tmpdir(), 'vb-back-'));
    execFileSync('tar', ['xf', join(x, 'volume-0.tar'), '-C', back]);
    assert.equal(await readFile(join(back, 'sub', 'a.txt'), 'utf8'), 'hello from volume zero');
    assert.equal(await readFile(join(back, '.hidden'), 'utf8'), 'dot file');
    assert.equal(await readFile(join(back, 'link'), 'utf8'), 'hello from volume zero');
    const other = await mkdtemp(join(tmpdir(), 'vb-back1-'));
    execFileSync('tar', ['xf', join(x, 'volume-1.tar'), '-C', other]);
    assert.deepEqual([...await readFile(join(other, 'b.bin'))], [0, 1, 2, 255]);
  });

  test('uses the app\'s image and mounts the volumes in the order listed; the helper is removed', async () => {
    const eng = engine();
    await make({ eng });
    assert.deepEqual(eng.calls.images, [APP.id]);
    assert.deepEqual(eng.calls.helpers, [{ image: 'sha256:image', names: ['shipdok-vol-aaa', 'shipdok-vol-bbb'] }]);
    assert.deepEqual(eng.calls.archived, [0, 1]);
    assert.equal(eng.calls.removed, 1);
  });
});

describe('an encrypted volume backup', () => {
  test('is a .tar.enc that opens with the passphrase and only with it', async () => {
    const r = await make({ passphrase: 'correct horse battery staple' });
    assert.equal(r.filename, 'shipdok-volumes-20261022-030405-12345678.tar.enc');
    assert.equal(r.encrypted, true);
    const file = join(dir, r.filename);
    assert.deepEqual([...(await readFile(file)).subarray(0, BACKUP_MAGIC.length)], [...BACKUP_MAGIC]);
    assert.ok(!(await readFile(file)).includes('hello from volume zero'), 'the content is not readable in the file');
    const plain = join(await mkdtemp(join(tmpdir(), 'vb-dec-')), 'out.tar');
    await decryptBackupFile(file, plain, 'correct horse battery staple');
    assert.match(execFileSync('tar', ['tf', plain]).toString(), /volume-0\.tar/);
    await assert.rejects(decryptBackupFile(file, join(tmpdir(), 'vb-never.tar'), 'another passphrase entirely'));
  });
});

describe('when it fails', () => {
  test('a copy that fails leaves no file and no temporary folder, and the helper is removed', async () => {
    const eng = engine({ archiveVolume: async (h, i, file) => { if (i === 1) throw new Error('docker: no such path'); execFileSync('tar', ['cf', file, '-C', sources[0], '.']); } });
    await assert.rejects(make({ eng }), /no such path/);
    assert.deepEqual(await names(), []);
    assert.equal(eng.calls.removed, 1);
  });

  test('a copy that is empty is refused (and says which volume)', async () => {
    const eng = engine({ archiveVolume: async (h, i, file) => writeFile(file, '') });
    await assert.rejects(make({ eng }), /copy of \/data is empty/);
    assert.deepEqual(await names(), []);
  });

  test('a copy that cannot be read back is not a backup', async () => {
    const eng = engine({ archiveVolume: async (h, i, file) => writeFile(file, 'this is not a tar file at all '.repeat(40)) });
    await assert.rejects(make({ eng }), /copy of \/data could not be read back/);
    assert.deepEqual(await names(), []);
  });

  test('an app with no volumes, or with no image, fails with a message and touches nothing', async () => {
    const eng = engine();
    await assert.rejects(make({ volumes: [], eng }), /no persistent volumes/);
    assert.equal(eng.calls.helpers.length, 0);
    const noImage = engine({ appImage: async () => { throw new Error('The app has no container, so there is no image'); } });
    await assert.rejects(make({ eng: noImage }), /no image/);
    assert.equal(noImage.calls.helpers.length, 0);
    assert.deepEqual(await names(), []);
  });

  test('a helper that cannot be made fails cleanly', async () => {
    const eng = engine({ createBackupHelper: async () => { throw new Error('no such image'); } });
    await assert.rejects(make({ eng }), /no such image/);
    assert.deepEqual(await names(), []);
    assert.equal(eng.calls.removed, 0);
  });
});

describe('room for it', () => {
  const eng = (free, total = 100 * GB, sizes = new Map()) => engine({ diskSpace: async () => ({ totalBytes: total, freeBytes: free }), volumeSizes: async () => sizes });
  const vol = (size) => [{ container_path: '/d', docker_name: 'v', size_bytes: size }];

  test('needs twice the data and must leave 10% of the disk free', async () => {
    // 10 GB of data: needs 20 GB, and 10 GB must stay free => 30 GB free is the least
    await checkRoom({ volumes: vol(10 * GB), dir, eng: eng(30 * GB) });
    await assert.rejects(checkRoom({ volumes: vol(10 * GB), dir, eng: eng(30 * GB - 1024) }), /Not enough free disk space/);
  });

  test('the message says the sizes in plain words', async () => {
    await assert.rejects(checkRoom({ volumes: vol(10 * GB), dir, eng: eng(25 * GB) }),
      /about 10240 MB.*up to 20480 MB.*10% free.*only 25600 MB is free/);
  });

  test('sizes that were never measured are asked of Docker; a volume Docker cannot size counts as nothing', async () => {
    const asked = []; 
    const e = engine({ diskSpace: async () => ({ totalBytes: 100 * GB, freeBytes: 25 * GB }), volumeSizes: async () => { asked.push(1); return new Map([['v', 10 * GB]]); } });
    await assert.rejects(checkRoom({ volumes: vol(null), dir, eng: e }), /Not enough free disk space/);
    assert.equal(asked.length, 1);
    const known = engine({ volumeSizes: async () => { throw new Error('must not be asked'); } });
    await checkRoom({ volumes: vol(1000), dir, eng: known });
    await checkRoom({ volumes: vol(null), dir, eng: engine({ volumeSizes: async () => new Map() }) });
  });

  test('is checked before anything is created', async () => {
    const e = eng(1 * GB, 100 * GB, new Map([['shipdok-vol-bbb', 50 * GB]]));
    await assert.rejects(make({ eng: e }), /Not enough free disk space/);
    assert.deepEqual([e.calls.helpers.length, e.calls.images.length, await names()], [0, 0, []]);
  });
});
