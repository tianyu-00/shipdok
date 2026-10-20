// How a log line is coloured in the terminal view. Pure, so the rules are easy to test.
//
// A line's STREAM is not enough: `docker build --progress=plain` writes all of its normal progress to stderr, so painting stderr red
// would make a healthy build look like a failure. The text decides instead.

const STEP = /^#\d+ \[/ // BuildKit: "#5 [2/4] RUN npm ci"
const STEP_END = /^#\d+ (DONE|CACHED)\b/
const ERROR = /\b(error|failed|fatal|denied|panic|exception|traceback|cannot|could not|not found|no such file)\b|\berr!|exit code: [1-9]|exited with [1-9]/i
const WARNING = /\bwarn(ing)?\b|deprecated/i
const SHIPDOK_BAD = /fail|error|cancel|stopped|interrupted|timed out|took longer|could not/i
const SHIPDOK_GOOD = /succeeded|is live|healthy/i

/** @returns {'error'|'warning'|'step'|'done'|'ok'|'info'|'plain'} */
export function lineTone(stream, message) {
  const text = String(message ?? '')
  if (stream === 'shipdok') {
    if (SHIPDOK_BAD.test(text)) return 'error'
    if (SHIPDOK_GOOD.test(text)) return 'ok'
    return 'info'
  }
  if (STEP.test(text)) return 'step'
  if (STEP_END.test(text)) return 'done'
  if (ERROR.test(text)) return 'error'
  if (WARNING.test(text)) return 'warning'
  return 'plain'
}

// Colours of the console. Light page, light console; dark page, dark console. Each tone has a darker shade for the light console (readable on
// a pale background) and the brighter one for the dark console.
export const TONE_CLASS = {
  error: 'text-red-600 dark:text-red-400',
  warning: 'text-amber-700 dark:text-amber-300',
  step: 'font-semibold text-sky-700 dark:text-sky-300',
  done: 'text-emerald-700/80 dark:text-emerald-400/80',
  ok: 'text-emerald-700 dark:text-emerald-400',
  info: 'text-cyan-700 dark:text-cyan-300',
  plain: 'text-zinc-800 dark:text-zinc-200',
}

/** The parts of a message around each (case-insensitive) occurrence of `needle`: [{ text, match }]. An empty needle is one plain part. */
export function splitMatches(message, needle) {
  const text = String(message ?? '')
  const n = String(needle ?? '')
  if (!n) return [{ text, match: false }]
  const parts = []
  const lower = text.toLowerCase()
  const find = n.toLowerCase()
  let from = 0
  for (;;) {
    const at = lower.indexOf(find, from)
    if (at < 0) break
    if (at > from) parts.push({ text: text.slice(from, at), match: false })
    parts.push({ text: text.slice(at, at + n.length), match: true })
    from = at + n.length
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false })
  return parts.length ? parts : [{ text, match: false }]
}
