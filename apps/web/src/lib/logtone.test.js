import { describe, test, expect } from 'vitest'
import { lineTone, splitMatches, TONE_CLASS } from './logtone'

describe('lineTone', () => {
  test('BuildKit steps are headers, and their end is quietly green', () => {
    expect(lineTone('stderr', '#5 [2/4] RUN npm ci')).toBe('step')
    expect(lineTone('stderr', '#1 [internal] load build definition from Dockerfile')).toBe('step')
    expect(lineTone('stderr', '#5 DONE 12.3s')).toBe('done')
    expect(lineTone('stderr', '#4 CACHED')).toBe('done')
  })

  test('normal docker progress on stderr is NOT an error', () => {
    for (const m of ['#1 transferring dockerfile: 235B done', '#6 exporting to image', 'added 214 packages in 9s']) {
      expect(lineTone('stderr', m)).toBe('plain')
    }
  })

  test('errors are recognised in the text, on either stream', () => {
    for (const m of ['npm ERR! code ELIFECYCLE', 'Error: Cannot find module', 'fatal: could not read Username', 'permission denied', 'ERROR: failed to solve: exit code: 1', 'process "/bin/sh -c x" did not complete successfully: exit code: 127']) {
      expect(lineTone('stderr', m)).toBe('error')
      expect(lineTone('stdout', m)).toBe('error')
    }
  })

  test('warnings', () => {
    for (const m of ['npm warn deprecated left-pad@1.0.0', 'WARNING: skipping', 'a Warning here']) expect(lineTone('stdout', m)).toBe('warning')
  })

  test('"0 errors" and similar words inside other words are not errors', () => {
    expect(lineTone('stdout', 'Found 0 errors.')).toBe('plain')
    expect(lineTone('stdout', 'terrorist-free build')).toBe('plain')
  })

  test('Shipdok\'s own lines: good news green, bad news red, the rest cyan', () => {
    expect(lineTone('shipdok', 'Deployment succeeded')).toBe('ok')
    expect(lineTone('shipdok', 'Deployment FAILED: git exited 128')).toBe('error')
    expect(lineTone('shipdok', 'Stop requested (cancelled); stopping the deployment')).toBe('error')
    expect(lineTone('shipdok', 'The build took longer than 5 minutes and was stopped')).toBe('error')
    expect(lineTone('shipdok', 'Cloning https://github.com/o/r.git@main')).toBe('info')
  })

  test('a missing message is plain', () => {
    expect(lineTone('stdout', undefined)).toBe('plain')
  })

  test('every tone has a colour for the light console AND one for the dark console', () => {
    for (const t of ['error', 'warning', 'step', 'done', 'ok', 'info', 'plain']) {
      const classes = TONE_CLASS[t].split(' ')
      expect(classes.some((c) => c.startsWith('text-') && !c.startsWith('dark:')), `${t}: light colour`).toBe(true)
      expect(classes.some((c) => c.startsWith('dark:text-')), `${t}: dark colour`).toBe(true)
    }
  })

  test('the light colours are darker shades (readable on a pale background), the dark ones brighter', () => {
    for (const t of ['error', 'warning', 'ok', 'info', 'step']) {
      const light = /text-[a-z]+-(\d+)/.exec(TONE_CLASS[t])[1]
      const dark = /dark:text-[a-z]+-(\d+)/.exec(TONE_CLASS[t])[1]
      expect(Number(light), t).toBeGreaterThanOrEqual(600)
      expect(Number(dark), t).toBeLessThanOrEqual(400)
    }
  })
})

describe('splitMatches', () => {
  test('no needle: one plain part', () => expect(splitMatches('hello', '')).toEqual([{ text: 'hello', match: false }]))
  test('finds every occurrence, ignoring case, and keeps the original text', () => {
    expect(splitMatches('Error: an error', 'ERROR')).toEqual([{ text: 'Error', match: true }, { text: ': an ', match: false }, { text: 'error', match: true }])
  })
  test('the parts always add up to the message', () => {
    for (const [m, n] of [['abcabc', 'b'], ['aaa', 'aa'], ['no hit', 'zz'], ['x', 'x']]) expect(splitMatches(m, n).map((p) => p.text).join('')).toBe(m)
  })
  test('regular-expression characters are just characters', () => {
    expect(splitMatches('a.b a*b', '.')).toEqual([{ text: 'a', match: false }, { text: '.', match: true }, { text: 'b a*b', match: false }])
    expect(splitMatches('x(y)', '(')).toEqual([{ text: 'x', match: false }, { text: '(', match: true }, { text: 'y)', match: false }])
  })
})
