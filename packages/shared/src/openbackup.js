// Opening a backup file on the host: decrypt it if it is encrypted, and unpack it into a folder. A backup of Shipdok itself holds db.dump (the database),
// secrets.tgz (the platform secrets) and manifest.json; a backup of an app's volumes holds volume-0.tar, volume-1.tar, ... (one per volume) and manifest.json.
// Restoring from those is described in docs/operations.md ("Restore"). Used by scripts/open-backup.js (the host) and by the worker (the Restore button).
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { decryptBackupFile, isEncryptedBackup } from './backupcrypto.js';

const run = promisify(execFile);
const FILES = ['db.dump', 'secrets.tgz', 'manifest.json'];
const VOLUME_FILE = /^volume-\d{1,3}\.tar$/;
const MAX_VOLUMES = 100;

/**
 * @returns {Promise<{ outDir: string, files: string[], manifest: object, wasEncrypted: boolean }>}
 * Throws with a message fit to show: a wrong passphrase and a damaged file are one and the same message, as in the file's own format.
 */
export async function openBackup({ file, outDir, passphrase = null }) {
  const wasEncrypted = await isEncryptedBackup(file);
  if (wasEncrypted && !passphrase) throw new Error('This backup is encrypted: give its passphrase');
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  if ((await readdir(outDir)).length > 0) throw new Error(`The folder ${outDir} is not empty; use a new, empty folder`);
  const work = await mkdtemp(join(outDir, '.opening-'));
  try {
    let tarFile = file;
    if (wasEncrypted) {
      tarFile = join(work, 'bundle.tar');
      await decryptBackupFile(file, tarFile, passphrase);
    }
    // Only our own files are unpacked, by name: nothing else a tar could carry (paths, links) is extracted. The manifest first: it says which kind of backup this is.
    const extract = (names) => run('tar', ['xf', tarFile, '-C', outDir, '--no-same-owner', '--no-same-permissions', ...names], { maxBuffer: 1024 * 1024 });
    const notOurs = (err) => new Error(`This does not look like a Shipdok backup (${String(err.stderr ?? '').trim().split('\n')[0] || 'tar failed'})`);
    await extract(['manifest.json']).catch((err) => { throw notOurs(err); });
    let manifest;
    try { manifest = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8')); } catch { throw new Error('This does not look like a Shipdok backup (the manifest cannot be read)'); }
    let wanted = FILES;
    if (manifest?.kind === 'volumes') {
      wanted = (Array.isArray(manifest.files) ? manifest.files : []).filter((n) => typeof n === 'string' && VOLUME_FILE.test(n)).slice(0, MAX_VOLUMES);
      if (wanted.length === 0) throw new Error('This does not look like a Shipdok backup (it lists no volumes)');
      wanted = [...wanted, 'manifest.json'];
    }
    await extract(wanted).catch((err) => {
      const text = String(err.stderr ?? '');
      if (manifest?.kind !== 'volumes' && /Not found in archive/.test(text) && !/db\.dump/.test(text)) return; // secrets.tgz is absent from a backup that could not include the secrets
      throw notOurs(err);
    });
    const files = (await readdir(outDir)).filter((n) => wanted.includes(n)).sort();
    if (manifest?.kind !== 'volumes' && (!files.includes('db.dump') || !files.includes('manifest.json'))) throw new Error('This does not look like a Shipdok backup (the database dump or the manifest is missing)');
    for (const name of files) await chmod(join(outDir, name), 0o600); // the dump, the secrets and the volumes' files are for their owner only
    return { outDir, files, manifest, wasEncrypted };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
