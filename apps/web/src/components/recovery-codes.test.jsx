import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RecoveryCodes } from './recovery-codes'

const lib = vi.hoisted(() => ({ downloadCodes: vi.fn(), printCodes: vi.fn(() => true) }))
vi.mock('@/lib/recovery', async (original) => ({ ...(await original()), ...lib }))
beforeEach(() => vi.clearAllMocks())

const CODES = Array.from({ length: 10 }, (_, i) => `AAAA-BBBB-CCCC-DDD${i}`)

describe('RecoveryCodes', () => {
  test('shows every code and explains that this is the only time', () => {
    render(<RecoveryCodes codes={CODES} onDone={() => {}} />)
    for (const c of CODES) expect(screen.getByText(c)).toBeInTheDocument()
    expect(screen.getByText(/only time/i)).toBeInTheDocument()
    expect(screen.getByText(/works once/i)).toBeInTheDocument()
  })

  test('cannot be finished until the person says they saved them', async () => {
    const onDone = vi.fn()
    render(<RecoveryCodes codes={CODES} onDone={onDone} />)
    const done = screen.getByRole('button', { name: /done/i })
    expect(done).toBeDisabled()
    await userEvent.click(screen.getByLabelText(/i have saved these/i))
    expect(done).toBeEnabled()
    await userEvent.click(done)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  test('copy puts all codes on the clipboard, one per line', async () => {
    const user = userEvent.setup()
    render(<RecoveryCodes codes={CODES} onDone={() => {}} />)
    await user.click(screen.getByRole('button', { name: /copy/i }))
    expect(await navigator.clipboard.readText()).toBe(CODES.join('\n'))
    expect(await screen.findByRole('button', { name: /copied/i })).toBeInTheDocument()
  })

  test('download and print hand the codes over', async () => {
    render(<RecoveryCodes codes={CODES} onDone={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /download/i }))
    expect(lib.downloadCodes).toHaveBeenCalledWith(CODES)
    await userEvent.click(screen.getByRole('button', { name: /print/i }))
    expect(lib.printCodes).toHaveBeenCalledWith(CODES)
  })

  test('a blocked print window is explained', async () => {
    lib.printCodes.mockReturnValueOnce(false)
    render(<RecoveryCodes codes={CODES} onDone={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /print/i }))
    expect(await screen.findByText(/blocked/i)).toBeInTheDocument()
  })
})
