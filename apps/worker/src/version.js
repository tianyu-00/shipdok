// Which Shipdok release this is: the VERSION file (copied into the image; a checkout has it at the repository root). Null when it cannot be read.
import { readFileSync } from 'node:fs';

export function readVersion(file = new URL('../../../VERSION', import.meta.url)) {
  try {
    const text = readFileSync(file, 'utf8').trim();
    return /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(text) ? text : null;
  } catch {
    return null;
  }
}
