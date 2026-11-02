// Making a backup of one app's persistent volumes: every mounted volume, as a tar each, in ONE file with a manifest.
//
//   1. is there room? Twice the data is needed at the peak (the copies, then the file made from them) and the disk must not end up nearly full
//   2. a helper container (created, never started, from the app's own image) mounts the volumes read-only; Docker's archive call streams each one out
//   3. every tar is read back (tar tf): a copy that cannot be read is not a backup
//   4. manifest.json says whose it is, which volumes (container path, Docker name, bytes) and when
//   5. one tar of them; encrypted with the administrator's passphrase when there is one (the same one as the backups of Shipdok itself)
//
// Built in a temporary folder INSIDE the backups folder and moved into place at the end, as in backup.js: a half-made file is never listed.
// The volumes are only ever read (mounted read-only). Stopping the app for a consistent copy is done by the caller (backuprunner.js).
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { backupFilename, backupFilePath, encryptBackupFile } from '@shipdok/shared';

export const MIN_FREE_PERCENT_AFTER = 10; // the disk must keep at least this much free once the backup is made (the "critical" level of the disk checks)

const mb = (bytes) => `${Math.ceil(bytes / (1024 * 1024))} MB`;

function tar(args, { quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('tar', args, { stdio: ['ignore', quiet ? 'ignore' : 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { if (err.length < 1000) err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar failed: ${err.trim().slice(0, 200) || `exit ${code}`}`))));
  });
}

/** Throws a readable message when the volumes would not fit; sizes are what is known (`size_bytes`), Docker is asked for the rest. */
export async function checkRoom({ volumes, dir, eng, minFreePercent = MIN_FREE_PERCENT_AFTER }) {
  let sizes = null;
  let total = 0;
  for (const v of volumes) {
    let size = v.size_bytes == null ? null : Number(v.size_bytes);
    if (size == null) {
      sizes ??= await eng.volumeSizes();
      size = sizes.get(v.docker_name) ?? 0;
    }
    total += size;
  }
  const { totalBytes, freeBytes } = await eng.diskSpace(dir);
  const needed = total * 2;
  const keepFree = totalBytes * (minFreePercent / 100);
  if (freeBytes - needed < keepFree) {
    throw new Error(`Not enough free disk space: the volumes hold about ${mb(total)}, a backup needs up to ${mb(needed)} while it is made and the disk must keep ${minFreePercent}% free, but only ${mb(freeBytes)} is free`);
  }
  return { totalBytes: total };
}

/**
 * Makes one volume backup. Resolves with what to record; throws (with a message fit to show) when it failed.
 * @param {object} o
 * @param {string} o.id            the backups row
 * @param {string} o.trigger       'manual' | 'scheduled'
 * @param {string} o.dir           the backups folder
 * @param {{id: string, name: string, slug: string}} o.app
 * @param {{container_path: string, docker_name: string, size_bytes?: number|null}[]} o.volumes  the volumes that are mounted
 * @param {string|null} o.passphrase
 * @param {object} o.eng           { appImage, createBackupHelper, archiveVolume, volumeSizes, diskSpace }
 */
export async function makeVolumeBackup({ id, trigger, dir, app, volumes, passphrase = null, version = null, stopped = false, eng, now = new Date(), log = () => {} }) {
  if (volumes.length === 0) throw new Error('This app has no persistent volumes to back up');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await checkRoom({ volumes, dir, eng });
  const image = await eng.appImage(app.id);
  const work = await mkdtemp(join(dir, '.making-'));
  let helper = null;
  try {
    helper = await eng.createBackupHelper({ image, volumes: volumes.map((v) => v.docker_name) });
    const entries = [];
    for (const [i, v] of volumes.entries()) {
      const file = `volume-${i}.tar`;
      log(`Copying ${v.container_path}`);
      await eng.archiveVolume(helper, i, join(work, file));
      const bytes = (await stat(join(work, file))).size;
      if (bytes === 0) throw new Error(`The copy of ${v.container_path} is empty`);
      await tar(['tf', join(work, file)], { quiet: true }).catch(() => { throw new Error(`The copy of ${v.container_path} could not be read back`); });
      entries.push({ file, containerPath: v.container_path, dockerName: v.docker_name, bytes });
    }
    await writeFile(join(work, 'manifest.json'), `${JSON.stringify({
      format: 1, kind: 'volumes', createdAt: now.toISOString(), shipdokVersion: version, trigger,
      app: { id: app.id, name: app.name, slug: app.slug }, appWasStopped: stopped, volumes: entries, files: [...entries.map((e) => e.file), 'manifest.json'],
    }, null, 2)}\n`);

    const encrypted = typeof passphrase === 'string' && passphrase.length > 0;
    const filename = backupFilename(now, id, encrypted, 'volumes');
    const bundle = join(work, 'bundle.tar');
    await tar(['cf', bundle, '-C', work, ...entries.map((e) => e.file), 'manifest.json']);
    for (const e of entries) await rm(join(work, e.file)); // the bundle holds them now: keeps the peak at twice the data
    let finished = bundle;
    if (encrypted) {
      finished = join(work, 'bundle.enc');
      await encryptBackupFile(bundle, finished, passphrase);
    }
    const target = backupFilePath(dir, filename);
    await chmod(finished, 0o600);
    await rename(finished, target);
    const { size } = await stat(target);
    log(`Volume backup ${filename} written (${size} bytes${encrypted ? ', encrypted' : ''}, ${entries.length} volume${entries.length === 1 ? '' : 's'})`);
    return { filename, sizeBytes: size, encrypted, verified: true, version, warning: null, volumeCount: entries.length, volumePaths: entries.map((e) => e.containerPath) };
  } finally {
    if (helper) await helper.remove({ force: true }).catch(() => {});
    await rm(work, { recursive: true, force: true });
  }
}
