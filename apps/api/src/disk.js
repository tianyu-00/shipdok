// How full is the disk the logs and images live on? Free space below 20% is a warning, below 10% critical (SPEC.md
// section 13). Shipdok's own volume sits next to Docker's data, so this is the number that matters for builds.
import { statfs } from 'node:fs/promises';
import { dirname } from 'node:path';

export const LOW_FREE_PERCENT = 20;
export const CRITICAL_FREE_PERCENT = 10;

// The log directory may not exist yet (nothing has been logged), so measure the nearest directory that does.
export async function defaultDiskUsage(path) {
  let p = path;
  for (;;) {
    try {
      const s = await statfs(p);
      return { totalBytes: s.bsize * s.blocks, freeBytes: s.bsize * s.bavail };
    } catch (err) {
      const parent = dirname(p);
      if (err.code !== 'ENOENT' || parent === p) throw err;
      p = parent;
    }
  }
}

/** { totalBytes, freeBytes, freePercent, level: 'ok'|'low'|'critical' }, or null if the disk cannot be measured. */
export async function diskStatus(diskUsage, logDir) {
  try {
    const { totalBytes, freeBytes } = await diskUsage(logDir);
    const freePercent = totalBytes > 0 ? (freeBytes / totalBytes) * 100 : 0;
    return {
      totalBytes, freeBytes,
      freePercent: Math.round(freePercent * 10) / 10,
      level: freePercent < CRITICAL_FREE_PERCENT ? 'critical' : freePercent < LOW_FREE_PERCENT ? 'low' : 'ok',
    };
  } catch {
    return null;
  }
}
