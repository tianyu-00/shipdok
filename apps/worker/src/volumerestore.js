// Restoring an app's volumes from a volume backup (the Restore button): open the file, match its volumes to the app's mounted ones, make room, then
// (after the optional safety backup, which the caller does in `beforeWrite`) empty the volumes or check that they are empty, write the files in, and read
// the volumes back to count what arrived. The app is stopped by the caller. Nothing is changed before every check has passed.
//
// The helper container (docker.js createRestoreHelper) mounts ONLY the volumes the backup has; a mounted volume the backup does not have is left alone.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { openBackup } from '@shipdok/shared';
import { MIN_FREE_PERCENT_AFTER } from './volumebackup.js';

export const RESTORE_MODES = ['replace', 'add', 'empty'];
const mb = (bytes) => `${Math.ceil(bytes / (1024 * 1024))} MB`;

// What the helper runs first. replace: nothing may be left that the backup does not have. empty: refuse (exit 3, naming the folder) when anything is there.
export const SCRIPTS = {
  replace: 'set -e; for d in /vrestore/*; do find "$d" -mindepth 1 -delete; done',
  add: 'true',
  empty: 'for d in /vrestore/*; do if [ -n "$(ls -A "$d")" ]; then echo "$d"; exit 3; fi; done',
};

/** How many entries a tar holds (read with tar itself). */
export function countEntries(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('tar', ['tf', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let count = 0; let rest = ''; let err = '';
    p.stdout.on('data', (d) => { const parts = (rest + d).split('\n'); rest = parts.pop(); count += parts.length; });
    p.stderr.on('data', (d) => { if (err.length < 500) err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(count + (rest ? 1 : 0)) : reject(new Error(`tar failed: ${err.trim().slice(0, 200) || `exit ${code}`}`))));
  });
}

/**
 * @param {object} o
 * @param {string} o.file        the backup file (.tar or .tar.enc)
 * @param {string|null} o.passphrase
 * @param {string} o.mode        'replace' | 'add' | 'empty'
 * @param {{container_path: string, docker_name: string}[]} o.volumes  the app's mounted volumes
 * @param {{id: string}} o.app
 * @param {string} o.dir         the backups folder (the work folder is made in it)
 * @param {() => Promise<void>} [o.beforeWrite]  called when every check has passed and nothing has been changed yet (the safety backup)
 * @param {object} o.eng         { ownImage, appImage, createRestoreHelper, runRestoreScript, putVolumeArchive, archiveVolume, diskSpace }
 * @returns {Promise<{ volumeCount: number, paths: string[] }>}
 * A failure after the first change carries `partial: true`.
 */
export async function makeRestore({ file, passphrase = null, mode, volumes, app, dir, beforeWrite = async () => {}, eng, log = () => {} }) {
  if (!RESTORE_MODES.includes(mode)) throw new Error('Unknown restore mode');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const work = await mkdtemp(join(dir, '.restoring-'));
  let helper = null;
  let changed = false;
  try {
    const { manifest } = await openBackup({ file, outDir: join(work, 'opened'), passphrase });
    if (manifest.kind !== 'volumes' || !Array.isArray(manifest.volumes) || manifest.volumes.length === 0) throw new Error('This is not a backup of an app\'s volumes');

    // 1. every volume of the backup must have a mounted volume of the app at the same path
    const pairs = manifest.volumes.map((e) => ({ entry: e, volume: volumes.find((v) => v.container_path === e.containerPath) ?? null }));
    const missing = pairs.filter((p) => !p.volume).map((p) => p.entry.containerPath);
    if (missing.length) throw new Error(`The app has no persistent storage at ${missing.join(', ')} any more. Add ${missing.length === 1 ? 'that path' : 'those paths'} in its Settings tab first, then restore`);

    // 2. room for what is written (the tars are already unpacked, so the data exists twice for a while)
    const total = pairs.reduce((n, p) => n + (Number(p.entry.bytes) || 0), 0);
    const { totalBytes, freeBytes } = await eng.diskSpace(dir);
    if (freeBytes - total < totalBytes * (MIN_FREE_PERCENT_AFTER / 100)) {
      throw new Error(`Not enough free disk space: the files to restore take about ${mb(total)} and the disk must keep ${MIN_FREE_PERCENT_AFTER}% free, but only ${mb(freeBytes)} is free`);
    }

    const image = (await eng.ownImage()) ?? (await eng.appImage(app.id));
    await beforeWrite();

    // 3. empty the volumes (replace) or check that they are empty (empty)
    helper = await eng.createRestoreHelper({ image, volumes: pairs.map((p) => p.volume.docker_name), script: SCRIPTS[mode] });
    changed = mode === 'replace'; // (a script that fails half way through may already have removed files)
    log(mode === 'replace' ? 'Emptying the volumes' : mode === 'empty' ? 'Checking that the volumes are empty' : 'Preparing the volumes');
    const ran = await eng.runRestoreScript(helper);
    if (ran.code === 3 && mode === 'empty') {
      const i = Number(/\/vrestore\/(\d+)/.exec(ran.output)?.[1]);
      throw new Error(`The volume at ${pairs[i]?.entry.containerPath ?? 'one of the paths'} is not empty. Choose "Replace" or "Add over" to restore into it anyway`);
    }
    if (ran.code !== 0) throw new Error(`The volumes could not be prepared${ran.output ? `: ${ran.output}` : ` (exit ${ran.code})`}`);

    // 4. the files
    for (const [i, p] of pairs.entries()) {
      log(`Restoring ${p.entry.containerPath}`);
      changed = true;
      await eng.putVolumeArchive(helper, i, join(work, 'opened', p.entry.file));
    }

    // 5. read back: the volume must hold at least what the backup held (exactly that, after a replace or into an empty one)
    for (const [i, p] of pairs.entries()) {
      const back = join(work, `check-${i}.tar`);
      await eng.archiveVolume(helper, i, back, 'vrestore');
      const [had, has] = await Promise.all([countEntries(join(work, 'opened', p.entry.file)), countEntries(back)]);
      await rm(back, { force: true });
      if (has < had || (mode !== 'add' && has !== had)) throw new Error(`The restored files at ${p.entry.containerPath} do not match the backup (${has} entries found, ${had} expected)`);
    }
    return { volumeCount: pairs.length, paths: pairs.map((p) => p.entry.containerPath) };
  } catch (err) {
    if (changed) err.partial = true;
    throw err;
  } finally {
    if (helper) await helper.remove({ force: true }).catch(() => {});
    await rm(work, { recursive: true, force: true });
  }
}

/** The backup file of a row must exist before anything starts. */
export async function backupFileExists(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}
