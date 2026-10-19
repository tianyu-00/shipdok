import { describe, test, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SecurityPage from '@/pages/security-page'
import { passwordProblem } from './change-password-dialog'
import { mockApi, answer, renderWithProviders } from '@/test/utils'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts, Toaster: () => null }))
beforeEach(() => vi.clearAllMocks())

const POST = 'POST /api/auth/password'
async function open() {
  renderWithProviders(<SecurityPage />, { route: '/security' })
  await userEvent.click(await screen.findByRole('button', { name: 'Change password' }))
  return screen.findByRole('dialog')
}
async function fill(dialog, { current = 'current-password-1', next = 'a-new-long-password', repeat = next } = {}) {
  await userEvent.type(within(dialog).getByLabelText('Current password'), current)
  await userEvent.type(within(dialog).getByLabelText('New password'), next)
  await userEvent.type(within(dialog).getByLabelText('Repeat the new password'), repeat)
}
const submit = (dialog) => userEvent.click(within(dialog).getByRole('button', { name: 'Change password' }))

describe('passwordProblem', () => {
  const ok = { current: 'current-password-1', next: 'a-new-long-password', repeat: 'a-new-long-password' }
  test('accepts a good change', () => expect(passwordProblem(ok)).toBeNull())
  test.each([
    ['no current password', { current: '' }],
    ['a short new password', { next: 'short', repeat: 'short' }],
    ['an 11 character new password', { next: 'x'.repeat(11), repeat: 'x'.repeat(11) }],
    ['a very long new password', { next: 'x'.repeat(257), repeat: 'x'.repeat(257) }],
    ['the same password', { next: 'current-password-1', repeat: 'current-password-1' }],
    ['a mismatch', { repeat: 'a-new-long-passwore' }],
  ])('refuses %s', (_, over) => expect(passwordProblem({ ...ok, ...over })).toEqual(expect.any(String)))
  test('allows exactly 12 and 256 characters', () => {
    expect(passwordProblem({ ...ok, next: 'x'.repeat(12), repeat: 'x'.repeat(12) })).toBeNull()
    expect(passwordProblem({ ...ok, next: 'x'.repeat(256), repeat: 'x'.repeat(256) })).toBeNull()
  })
})

describe('the change password dialog', () => {
  test('shows the strength of the new password as it is typed', async () => {
    mockApi({})
    const dialog = await open()
    await userEvent.type(within(dialog).getByLabelText('New password'), 'x'.repeat(24))
    expect(within(dialog).getByRole('img', { name: 'Strength: Strong' })).toBeInTheDocument()
  })

  test('the server\'s reason for refusing a weak password is shown', async () => {
    mockApi({ [POST]: () => { throw { status: 400, body: { error: 'The password is a short pattern repeated over and over', code: 'weak_password' } } } })
    const dialog = await open()
    await fill(dialog, { next: 'abababababababab' })
    await submit(dialog)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('short pattern')
  })

  test('opens from the header', async () => {
    mockApi({})
    expect(await open()).toHaveTextContent(/other browser or device/i)
  })

  test('sends the current and the new password, then confirms and closes', async () => {
    const api = mockApi({ [POST]: null })
    const dialog = await open()
    await fill(dialog)
    await submit(dialog)
    await waitFor(() => expect(api.called('POST', '/api/auth/password')).toHaveLength(1))
    expect(api.called('POST', '/api/auth/password')[0].body).toEqual({ currentPassword: 'current-password-1', newPassword: 'a-new-long-password' })
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith(expect.stringMatching(/Password changed/)))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  test('mistakes are caught in the browser: nothing is sent', async () => {
    const api = mockApi({ [POST]: null })
    const dialog = await open()
    await fill(dialog, { repeat: 'something-different-1' })
    await submit(dialog)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/not the same/)
    expect(api.called('POST', '/api/auth/password')).toHaveLength(0)
  })

  test('a wrong current password is explained in the dialog, which stays open and keeps the session', async () => {
    mockApi({ [POST]: answer(403, { error: 'The current password is not correct', code: 'wrong_password' }) })
    const dialog = await open()
    await fill(dialog)
    await submit(dialog)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The current password is not correct')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(toasts.success).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Security', hidden: true })).toBeInTheDocument()
  })

  test('being rate limited is shown', async () => {
    mockApi({ [POST]: answer(429, { error: 'Too many attempts, try again later' }) })
    const dialog = await open()
    await fill(dialog)
    await submit(dialog)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Too many attempts')
  })

  test('cancel closes it without sending anything', async () => {
    const api = mockApi({})
    const dialog = await open()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.called('POST', '/api/auth/password')).toHaveLength(0)
  })

  test('the fields are password fields', async () => {
    mockApi({})
    const dialog = await open()
    for (const l of ['Current password', 'New password', 'Repeat the new password']) expect(within(dialog).getByLabelText(l)).toHaveAttribute('type', 'password')
  })
})
