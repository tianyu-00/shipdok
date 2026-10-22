// Opens a Shipdok backup file (decrypts it if needed) into a folder, ready for the restore steps in docs/operations.md.
//   docker compose run --rm --no-deps -v "$PWD":/backup -e SHIPDOK_BACKUP_PASSPHRASE api node scripts/open-backup.js /backup/<file> /backup/opened
// From a checkout:  node apps/api/scripts/open-backup.js <file> <new empty folder>
// The passphrase (only for an encrypted backup) is read from SHIPDOK_BACKUP_PASSPHRASE, else asked for on the terminal without echoing it.
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { isEncryptedBackup } from '@shipdok/shared';
import { openBackup } from '../src/openbackup.js';

const [file, outDir] = process.argv.slice(2);
if (!file || !outDir) {
  console.error('Usage: node scripts/open-backup.js <backup file> <new empty folder>');
  process.exit(2);
}

function askHidden(question) {
  return new Promise((resolve) => {
    let muted = false;
    const rl = createInterface({ input: process.stdin, output: new Writable({ write(chunk, enc, cb) { if (!muted) process.stdout.write(chunk, enc); cb(); } }), terminal: true });
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
    muted = true;
  });
}

try {
  let passphrase = process.env.SHIPDOK_BACKUP_PASSPHRASE || null;
  if (!passphrase && (await isEncryptedBackup(file))) {
    if (!process.stdin.isTTY) throw new Error('This backup is encrypted: set SHIPDOK_BACKUP_PASSPHRASE, or run with -it to be asked for the passphrase');
    passphrase = await askHidden('Backup passphrase: ');
  }
  const { files, manifest, wasEncrypted } = await openBackup({ file, outDir, passphrase });
  console.log(`${wasEncrypted ? 'Decrypted and opened' : 'Opened'} the backup made ${manifest.createdAt} by Shipdok ${manifest.shipdokVersion ?? '(unknown version)'} (${manifest.trigger}).`);
  console.log(`In ${outDir}: ${files.join(', ')}`);
  if (!manifest.includesSecrets) console.log('WARNING: this backup does not contain the platform secrets (secrets.tgz), so it cannot open the database\'s encrypted data on its own.');
  console.log('Next: restore the database and the secrets as described under "Restore" in docs/operations.md.');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
