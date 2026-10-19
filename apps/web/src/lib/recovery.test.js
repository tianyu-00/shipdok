import { describe, test, expect, vi, afterEach } from 'vitest'
import { codesText, downloadCodes, printCodes } from './recovery'

const CODES = ['ABCD-EFGH-JKMN-PQRS', 'TVWX-YZ01-2345-6789']
afterEach(() => vi.unstubAllGlobals())

describe('codesText', () => {
  test('says what they are, that each works once, and lists every code on its own line', () => {
    const text = codesText(CODES, new Date('2026-10-19T12:00:00Z'))
    expect(text).toMatch(/Shipdok recovery codes/)
    expect(text).toMatch(/once/i)
    expect(text).toMatch(/2026-10-19/)
    expect(text.split('\n')).toEqual(expect.arrayContaining(CODES))
    expect(text).toMatch(/replaced|replace/i)
  })
})

describe('downloadCodes', () => {
  test('saves a text file with the codes through a temporary link, and cleans up', async () => {
    let blob
    const click = vi.fn()
    const link = { click, set href(v) { this._href = v }, set download(v) { this._download = v }, remove: vi.fn() }
    vi.stubGlobal('URL', { createObjectURL: vi.fn((b) => { blob = b; return 'blob:x' }), revokeObjectURL: vi.fn() })
    const make = vi.spyOn(document, 'createElement').mockReturnValue(link)
    downloadCodes(CODES)
    make.mockRestore()
    expect(click).toHaveBeenCalledTimes(1)
    expect(link._download).toBe('shipdok-recovery-codes.txt')
    expect(blob.type).toMatch(/text\/plain/)
    expect(await blob.text()).toContain(CODES[0])
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x')
  })
})

describe('printCodes', () => {
  test('writes the codes into a new window and prints it', () => {
    const doc = { write: vi.fn(), close: vi.fn() }
    const win = { document: doc, focus: vi.fn(), print: vi.fn() }
    vi.stubGlobal('open', vi.fn(() => win))
    expect(printCodes(CODES)).toBe(true)
    const html = doc.write.mock.calls.map((c) => c[0]).join('')
    for (const c of CODES) expect(html).toContain(c)
    expect(win.print).toHaveBeenCalled()
  })

  test('says so when the browser blocks the window', () => {
    vi.stubGlobal('open', vi.fn(() => null))
    expect(printCodes(CODES)).toBe(false)
  })
})
