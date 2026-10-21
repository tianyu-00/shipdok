// The size at which the dashboard says that old images are piling up. The server takes bytes (100 MB to 10 TB, or null for never); people think in GB.

const GB = 1024 ** 3
const MIN_BYTES = 100 * 1024 ** 2
const MAX_BYTES = 10 * 1024 ** 4
export const THRESHOLD_HINT = 'A number of GB from 0.1 to 10240, or empty for never'

/** The text for a size in the box: GB with at most two decimals, empty for "never". */
export const bytesToGbText = (bytes) => (bytes == null ? '' : String(Number((bytes / GB).toFixed(2))))

/** { bytes } for what was typed (null = never), or { error }. */
export function gbTextToBytes(text) {
  const t = String(text ?? '').trim()
  if (t === '') return { bytes: null }
  if (!/^\d+(\.\d+)?$/.test(t)) return { error: THRESHOLD_HINT }
  const bytes = Math.round(Number(t) * GB)
  if (bytes < MIN_BYTES || bytes > MAX_BYTES) return { error: THRESHOLD_HINT }
  return { bytes }
}
