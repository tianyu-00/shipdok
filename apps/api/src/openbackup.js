// Opening a backup file on the host: decrypt it if it is encrypted, and unpack it into a folder: db.dump (the database), secrets.tgz (the platform secrets)
// and manifest.json. Restoring from those is described in docs/operations.md ("Restore"). Used by scripts/open-backup.js; kept apart so it can be tested.
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { decryptBackupFile, isEncryptedBackup } from '@shipdok/shared';

const run = promisify(execFile);
const FILES = ['db.dump', 'secrets.tgz', 'manifest.json'];

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
    // Only our three files are unpacked, by name: nothing else a tar could carry (paths, links) is extracted.
    await run('tar', ['xf', tarFile, '-C', outDir, '--no-same-owner', '--no-same-permissions', ...FILES], { maxBuffer: 1024 * 1024 }).catch((err) => {
      const text = String(err.stderr ?? '');
      if (/Not found in archive/.test(text) && !/db\.dump/.test(text)) return; // secrets.tgz is absent from a backup that could not include the secrets
      throw new Error(`This does not look like a Shipdok backup (${text.trim().split('\n')[0] || 'tar failed'})`);
    });
    const files = (await readdir(outDir)).filter((n) => FILES.includes(n)).sort();
    if (!files.includes('db.dump') || !files.includes('manifest.json')) throw new Error('This does not look like a Shipdok backup (the database dump or the manifest is missing)');
    for (const name of files) await chmod(join(outDir, name), 0o600); // the dump and the secrets are for their owner only
    const manifest = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8'));
    return { outDir, files, manifest, wasEncrypted };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
