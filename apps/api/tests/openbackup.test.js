import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptBackupFile } from '@shipdok/shared';
import { openBackup } from '../src/openbackup.js';

const PASS = 'correct horse battery staple';
const fresh = () => mkdtempSync(join(tmpdir(), 'ob-'));

// A backup file as the worker makes it: a tar of db.dump, secrets.tgz and manifest.json
function makeTar({ secrets = true, extra = {} } = {}) {
  const dir = fresh();
  writeFileSync(join(dir, 'db.dump'), 'DUMP-BYTES');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ format: 1, createdAt: '2026-10-22T03:00:00.000Z', shipdokVersion: '0.1.17', trigger: 'manual', includesSecrets: secrets }));
  const names = ['db.dump', 'manifest.json'];
  if (secrets) { writeFileSync(join(dir, 'secrets.tgz'), 'SECRETS-TGZ'); names.push('secrets.tgz'); }
  for (const [name, text] of Object.entries(extra)) { writeFileSync(join(dir, name), text); names.push(name); }
  const file = join(fresh(), 'shipdok-backup.tar');
  execFileSync('tar', ['cf', file, '-C', dir, ...names]);
  return file;
}

describe('a plain backup', () => {
  test('is unpacked into the folder, with the manifest read', async () => {
    const out = join(fresh(), 'opened');
    const r = await openBackup({ file: makeTar(), outDir: out });
    expect(r.files).toEqual(['db.dump', 'manifest.json', 'secrets.tgz']);
    expect(r.manifest).toMatchObject({ shipdokVersion: '0.1.17', includesSecrets: true });
    expect(r.wasEncrypted).toBe(false);
    expect(readFileSync(join(out, 'db.dump'), 'utf8')).toBe('DUMP-BYTES');
    expect(readFileSync(join(out, 'secrets.tgz'), 'utf8')).toBe('SECRETS-TGZ');
  });
  test('the unpacked files are readable by their owner only (they hold every secret)', async () => {
    const out = join(fresh(), 'o');
    await openBackup({ file: makeTar(), outDir: out });
    for (const name of readdirSync(out)) expect(statSync(join(out, name)).mode & 0o077).toBe(0);
  });
  test('one that holds no secrets still opens, and says so in its manifest', async () => {
    const r = await openBackup({ file: makeTar({ secrets: false }), outDir: join(fresh(), 'o') });
    expect(r.files).toEqual(['db.dump', 'manifest.json']);
    expect(r.manifest.includesSecrets).toBe(false);
  });
  test('only the three files are unpacked, whatever else the archive carries', async () => {
    const out = join(fresh(), 'o');
    await openBackup({ file: makeTar({ extra: { 'evil.sh': 'rm -rf /' } }), outDir: out });
    expect(readdirSync(out).sort()).toEqual(['db.dump', 'manifest.json', 'secrets.tgz']);
  });
  test('the temporary folder does not stay behind', async () => {
    const out = join(fresh(), 'o');
    await openBackup({ file: makeTar(), outDir: out });
    expect(readdirSync(out).some((n) => n.startsWith('.opening'))).toBe(false);
  });
});

// A backup of an app's volumes: volume-N.tar for each volume and a manifest that lists them
function makeVolumeTar({ count = 2, files = null, kind = 'volumes', extra = {} } = {}) {
  const dir = fresh();
  const names = [];
  for (let i = 0; i < count; i++) { writeFileSync(join(dir, `volume-${i}.tar`), `VOLUME-${i}`); names.push(`volume-${i}.tar`); }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ format: 1, kind, createdAt: '2026-10-22T03:00:00.000Z', shipdokVersion: '0.1.19', trigger: 'manual', app: { name: 'Blog' }, files: files ?? [...names, 'manifest.json'] }));
  names.push('manifest.json');
  for (const [name, text] of Object.entries(extra)) { writeFileSync(join(dir, name), text); names.push(name); }
  const file = join(fresh(), 'shipdok-volumes.tar');
  execFileSync('tar', ['cf', file, '-C', dir, ...names]);
  return file;
}

describe('a backup of an app\'s volumes', () => {
  test('is unpacked: every volume and the manifest, readable by the owner only', async () => {
    const out = join(fresh(), 'o');
    const r = await openBackup({ file: makeVolumeTar(), outDir: out });
    expect(r.files).toEqual(['manifest.json', 'volume-0.tar', 'volume-1.tar']);
    expect(r.manifest).toMatchObject({ kind: 'volumes', app: { name: 'Blog' } });
    expect(readFileSync(join(out, 'volume-1.tar'), 'utf8')).toBe('VOLUME-1');
    for (const name of readdirSync(out)) expect(statSync(join(out, name)).mode & 0o077).toBe(0);
  });
  test('only the volumes the manifest lists, by a strict name: nothing else the archive carries', async () => {
    const out = join(fresh(), 'o');
    await openBackup({ file: makeVolumeTar({ extra: { 'evil.sh': 'rm -rf /', 'volume-9.tar': 'not listed', 'db.dump': 'not a volume backup file' } }), outDir: out });
    expect(readdirSync(out).sort()).toEqual(['manifest.json', 'volume-0.tar', 'volume-1.tar']);
  });
  test('a manifest that lists names that are not volume files asks for nothing of the kind', async () => {
    const out = join(fresh(), 'o');
    await expect(openBackup({ file: makeVolumeTar({ files: ['../evil', '/etc/passwd', 'db.dump', 'volume-x.tar', 'manifest.json'] }), outDir: out })).rejects.toThrow(/lists no volumes/);
    expect(readdirSync(out).filter((n) => n !== 'manifest.json')).toEqual([]);
  });
  test('a volume the manifest lists but the archive lacks is refused', async () => {
    await expect(openBackup({ file: makeVolumeTar({ files: ['volume-0.tar', 'volume-1.tar', 'volume-2.tar', 'manifest.json'] }), outDir: join(fresh(), 'o') })).rejects.toThrow(/does not look like a Shipdok backup/);
  });
  test('an encrypted one opens with the passphrase', async () => {
    const file = join(fresh(), 'shipdok-volumes.tar.enc');
    await encryptBackupFile(makeVolumeTar(), file, PASS);
    const out = join(fresh(), 'o');
    const r = await openBackup({ file, outDir: out, passphrase: PASS });
    expect([r.wasEncrypted, r.files.length]).toEqual([true, 3]);
    await expect(openBackup({ file, outDir: join(fresh(), 'o2'), passphrase: 'not the passphrase at all' })).rejects.toThrow();
  });
  test('a backup of Shipdok itself is still opened as before when the manifest has no kind', async () => {
    const r = await openBackup({ file: makeTar(), outDir: join(fresh(), 'o') });
    expect(r.files).toEqual(['db.dump', 'manifest.json', 'secrets.tgz']);
  });
});

describe('an encrypted backup', () => {
  async function encrypted() {
    const file = join(fresh(), 'shipdok-backup.tar.enc');
    await encryptBackupFile(makeTar(), file, PASS);
    return file;
  }
  test('opens with its passphrase', async () => {
    const out = join(fresh(), 'o');
    const r = await openBackup({ file: await encrypted(), outDir: out, passphrase: PASS });
    expect(r.wasEncrypted).toBe(true);
    expect(readFileSync(join(out, 'db.dump'), 'utf8')).toBe('DUMP-BYTES');
  });
  test('asks for the passphrase when none is given, and touches nothing', async () => {
    const out = join(fresh(), 'o');
    await expect(openBackup({ file: await encrypted(), outDir: out })).rejects.toThrow(/give its passphrase/);
    expect(existsSync(out)).toBe(false);
  });
  test('a wrong passphrase gives the one vague message and leaves the folder empty', async () => {
    const out = join(fresh(), 'o');
    await expect(openBackup({ file: await encrypted(), outDir: out, passphrase: 'not the passphrase!' })).rejects.toThrow(/wrong passphrase, or the file is damaged/);
    expect(readdirSync(out)).toEqual([]);
  });
});

describe('what is not a backup', () => {
  test('a file that is not a tar is refused', async () => {
    const file = join(fresh(), 'x.tar'); writeFileSync(file, 'plain text, not an archive');
    await expect(openBackup({ file, outDir: join(fresh(), 'o') })).rejects.toThrow(/does not look like a Shipdok backup/);
  });
  test('a tar without the dump is refused', async () => {
    const dir = fresh(); writeFileSync(join(dir, 'other.txt'), 'x');
    const file = join(fresh(), 'x.tar'); execFileSync('tar', ['cf', file, '-C', dir, 'other.txt']);
    await expect(openBackup({ file, outDir: join(fresh(), 'o') })).rejects.toThrow(/does not look like a Shipdok backup/);
  });
  test('a file that does not exist is refused', async () => {
    await expect(openBackup({ file: join(fresh(), 'missing.tar'), outDir: join(fresh(), 'o') })).rejects.toThrow();
  });
  test('a folder that already holds files is refused, and nothing is overwritten', async () => {
    const out = fresh(); mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'keep.txt'), 'mine');
    await expect(openBackup({ file: makeTar(), outDir: out })).rejects.toThrow(/not empty/);
    expect(readFileSync(join(out, 'keep.txt'), 'utf8')).toBe('mine');
    expect(readdirSync(out)).toEqual(['keep.txt']);
  });
});
