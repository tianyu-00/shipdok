// Showing CPU and memory. Pure helpers, so the numbers people read are easy to test.
import { formatBytes } from '@/lib/format'

/** CPU as the share of one cpu, like `docker stats`: "3.5%" (above 100% when more than one cpu is busy). "—" when unknown. */
export function formatCpu(percent) {
  if (percent === null || percent === undefined || Number.isNaN(Number(percent))) return '—'
  const v = Number(percent)
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)}%`
}

/** "180 MB of 512 MB" (or just "180 MB" when there is no limit). */
export function formatMemory(stats) {
  if (!stats) return '—'
  const used = formatBytes(stats.memoryBytes)
  return stats.memoryLimitBytes ? `${used} of ${formatBytes(stats.memoryLimitBytes)}` : used
}

/** How much of its memory limit the app is using, as a whole percent; null without a limit. */
export function memoryPercent(stats) {
  if (!stats?.memoryLimitBytes) return null
  return Math.min(100, Math.round((stats.memoryBytes / stats.memoryLimitBytes) * 100))
}

const MB = 1024 * 1024

/** The API's samples -> points for the charts. Time in milliseconds, memory in MB, CPU left null where Docker could not say. */
export function chartPoints(samples = []) {
  return samples.map((s) => ({ time: new Date(s.t).getTime(), cpu: s.cpu, memory: Math.round((s.memory / MB) * 10) / 10 }))
}

/** The top of the CPU chart: at least 100% (one full cpu) so a quiet app does not look busy, higher when the data needs it. */
export function cpuCeiling(points) {
  const peak = Math.max(0, ...points.map((p) => p.cpu ?? 0))
  return Math.max(100, Math.ceil(peak / 50) * 50)
}

/** "12:05" style label for a point's time. */
export const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** Evenly spaced axis marks from 0 to `top`: 0, 50, 100 ... (steps of 100 once the top is above 200). */
export function cpuTicks(top) {
  const step = top > 200 ? 100 : 50
  const out = []
  for (let v = 0; v <= top; v += step) out.push(v)
  return out
}

/** Marks for the memory axis: nothing, the middle and the limit (a limit is the most the app can ever use). */
export const memoryTicks = (limitMb) => (limitMb ? [0, Math.round(limitMb / 2), Math.round(limitMb)] : undefined)
