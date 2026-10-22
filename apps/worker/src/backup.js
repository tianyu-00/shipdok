// Making a backup of Shipdok itself: the database and the platform secrets in ONE file, so that restoring needs nothing else.
//
//   1. pg_dump of Shipdok's own database, run inside the Postgres container (docker exec), written to db.dump (custom format)
//   2. the dump is read back (pg_restore --list) and must list something: a dump that cannot be read is not a backup
//   3. the secrets volume (the encryption key and the other generated secrets) is packed as secrets.tgz. WITHOUT it the encrypted data in the
//      database (variables, GitHub credentials) can never be read again, so a backup that lacks it carries a warning
//   4. manifest.json says what the file is (Shipdok's version, the last migration, the time)
//   5. one tar of the three; encrypted with the administrator's passphrase when there is one (@shipdok/shared backupcrypto)
//
// Everything is built in a temporary folder INSIDE the backups folder and moved into place at the end, so a half-made file is never listed or
// downloaded, and a failure leaves nothing behind. Nothing here writes a secret into a log or an error.
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { backupFilename, backupFilePath, encryptBackupFile } from '@shipdok/shared';

const run = promisify(execFile);
export const DUMP_COMMAND = ['sh', '-c', 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom']; // the container's own environment
export const LIST_COMMAND = ['pg_restore', '--list'];

const tar = (args) => run('tar', args, { maxBuffer: 1024 * 1024 }).catch((err) => { throw new Error(`tar failed: ${String(err.stderr || err.message).trim().slice(0, 200)}`); });

/** Does the folder hold anything? (A missing folder, as when developing with npm, holds nothing.) */
async function hasFiles(dir) {
  try { return (await readdir(dir)).length > 0; } catch { return false; }
}

/**
 * Makes one backup. Resolves with what to record; throws (with a message fit to show) when it failed.
 * @param {object} o
 * @param {string} o.id               the backups row
 * @param {string} o.trigger          'manual' | 'scheduled'
 * @param {string} o.dir              the backups folder
 * @param {string} o.secretsDir       the platform secrets (a volume)
 * @param {string|null} o.passphrase  encrypt with it, or leave the file plain
 * @param {string|null} o.version     Shipdok's version
 * @param {() => Promise<string|null>} [o.lastMigration]  the name of the latest applied migration, for the manifest
 * @param {object} o.eng              { findPostgresContainer, execToFile, execWithFile }
 */
export async function makeBackup({ id, trigger, dir, secretsDir, passphrase = null, version = null, lastMigration = async () => null, eng, now = new Date(), log = () => {} }) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const work = await mkdtemp(join(dir, '.making-'));
  try {
    const container = await eng.findPostgresContainer();
    log(`Dumping the database from ${container}`);
    const dump = join(work, 'db.dump');
    await eng.execToFile(container, DUMP_COMMAND, dump);
    if ((await stat(dump)).size === 0) throw new Error('The database dump is empty');

    const listing = await eng.execWithFile(container, LIST_COMMAND, dump);
    if (!/\S/.test(listing)) throw new Error('The database dump could not be read back');

    const includesSecrets = await hasFiles(secretsDir);
    const files = ['db.dump'];
    if (includesSecrets) {
      await tar(['czf', join(work, 'secrets.tgz'), '-C', secretsDir, '.']);
      files.push('secrets.tgz');
    }
    await writeFile(join(work, 'manifest.json'), `${JSON.stringify({
      format: 1, createdAt: now.toISOString(), shipdokVersion: version, trigger, lastMigration: await lastMigration(), includesSecrets, files: [...files, 'manifest.json'],
    }, null, 2)}\n`);

    const encrypted = typeof passphrase === 'string' && passphrase.length > 0;
    const filename = backupFilename(now, id, encrypted);
    const bundle = join(work, 'bundle.tar');
    await tar(['cf', bundle, '-C', work, ...files, 'manifest.json']);
    let finished = bundle;
    if (encrypted) {
      finished = join(work, 'bundle.enc');
      await encryptBackupFile(bundle, finished, passphrase);
    }
    const target = backupFilePath(dir, filename);
    await chmod(finished, 0o600); // the file holds every secret: readable by its owner only
    await rename(finished, target);
    const { size } = await stat(target);
    log(`Backup ${filename} written (${size} bytes${encrypted ? ', encrypted' : ''})`);
    return {
      filename, sizeBytes: size, encrypted, verified: true, version,
      warning: includesSecrets ? null : 'The platform secrets could not be included, so this backup cannot open the encrypted data in the database on its own',
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Deletes the backup files of the given rows (a file that is already gone is fine). */
export async function removeBackupFiles(dir, filenames) {
  for (const name of filenames) {
    const path = backupFilePath(dir, name);
    if (path) await rm(path, { force: true });
  }
}
