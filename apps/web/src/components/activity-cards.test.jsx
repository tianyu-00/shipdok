import { describe, test, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SignInsCard, ActivityCard } from '@/components/activity-cards'
import { mockApi, answer, renderWithProviders, pick, listedValues } from '@/test/utils'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts, Toaster: () => null }))
beforeEach(() => vi.clearAllMocks())

const NOW = Date.now()
const row = (kind, n, extra = {}) => ({ at: new Date(NOW - n * 60_000).toISOString(), kind, username: `user${n}`, address: '192.168.1.20', success: true, ...extra })
const many = (kind, count) => Array.from({ length: count }, (_, i) => row(kind, i + 1))
const cards = () => renderWithProviders(<><SignInsCard /><ActivityCard /></>)
const route = (rows, keepDays = 30) => (call) => ({ keepDays, logins: rows.filter((l) => (new URL(call.path, 'http://x').searchParams.get('scope') === 'activity') !== ['login', 'setup', 'recovery', 'reset'].includes(l.kind)) })
const names = (c) => within(c).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[1].textContent)

describe('two lists', () => {
  test('sign-ins and the activity log are asked for apart, up to 500 each', async () => {
    const api = mockApi({ 'GET /api/auth/logins': route([row('login', 1)]) })
    cards()
    await screen.findByText('user1')
    const paths = api.calls.map((c) => c.path)
    expect(paths).toContain('/api/auth/logins?limit=500&scope=signins')
    expect(paths).toContain('/api/auth/logins?limit=500&scope=activity')
  })

  test('each kind shows in its own card with its own name (a restore is not "Signed in")', async () => {
    mockApi({ 'GET /api/auth/logins': route([
      row('login', 1), row('recovery', 2), row('settings', 3), row('github', 4), row('backup', 5), row('download', 6), row('restore', 7), row('logsettings', 8),
    ]) })
    cards()
    await screen.findByText('Restore started')
    const signins = screen.getByLabelText('Sign-ins')
    const activity = screen.getByLabelText('Activity log')
    expect(within(signins).getByText('Signed in')).toBeInTheDocument()
    expect(within(signins).getByText('Recovery code used')).toBeInTheDocument()
    expect(within(signins).queryByText('Restore started')).toBeNull()
    for (const t of ['Public access changed', 'GitHub changed', 'Backup passphrase changed', 'Backup downloaded', 'Restore started', 'Log keeping time changed']) {
      expect(within(activity).getByText(t)).toBeInTheDocument()
      expect(within(signins).queryByText(t)).toBeNull()
    }
    expect(within(activity).queryByText('Signed in')).toBeNull()
  })

  test('a failed attempt is shown in the sign-ins as Failed', async () => {
    mockApi({ 'GET /api/auth/logins': route([row('login', 1, { success: false, username: 'root' })]) })
    cards()
    expect(await within(await screen.findByLabelText('Sign-ins')).findByText('Failed')).toBeInTheDocument()
  })

  test('each says so when it is empty, and shows how many it holds', async () => {
    mockApi({ 'GET /api/auth/logins': route([...many('login', 3)]) })
    cards()
    expect(await screen.findByText('No activity recorded yet')).toBeInTheDocument()
    expect(within(screen.getByLabelText('Sign-ins')).getByText('(3)')).toBeInTheDocument()
    expect(within(screen.getByLabelText('Activity log')).queryByText(/\(\d+\)/)).toBeNull()
  })

  test('names typed by strangers are plain text', async () => {
    mockApi({ 'GET /api/auth/logins': route([row('login', 1, { username: '<b>x</b>', success: false })]) })
    const { container } = cards()
    expect(await screen.findByText('<b>x</b>')).toBeInTheDocument()
    expect(container.querySelector('b')).toBeNull()
  })
})

describe('paging', () => {
  test('10 a page by default, newest first, with Newer / Older and the page count; the last page holds the rest', async () => {
    mockApi({ 'GET /api/auth/logins': route(many('login', 25)) })
    cards()
    const signins = await screen.findByLabelText('Sign-ins')
    await within(signins).findByText('user1')
    expect(names(signins)).toEqual(Array.from({ length: 10 }, (_, i) => `user${i + 1}`))
    expect(within(signins).getByText('Page 1 of 3')).toBeInTheDocument()
    expect(within(signins).getByRole('button', { name: 'Newer' })).toBeDisabled()
    await userEvent.click(within(signins).getByRole('button', { name: 'Older' }))
    expect(names(signins)[0]).toBe('user11')
    await userEvent.click(within(signins).getByRole('button', { name: 'Older' }))
    expect(names(signins)).toEqual(['user21', 'user22', 'user23', 'user24', 'user25'])
    expect(within(signins).getByRole('button', { name: 'Older' })).toBeDisabled()
    await userEvent.click(within(signins).getByRole('button', { name: 'Newer' }))
    expect(within(signins).getByText('Page 2 of 3')).toBeInTheDocument()
  })

  test('the page size can be 5, 10, 25 or 50; choosing one goes back to page 1 and is remembered for that list only', async () => {
    mockApi({ 'GET /api/auth/logins': route([...many('login', 30), ...many('github', 30)]) })
    cards()
    const signins = await screen.findByLabelText('Sign-ins')
    await within(signins).findByText('user1')
    expect(await listedValues(within(signins).getByLabelText('Per page'))).toEqual(['5', '10', '25', '50'])
    await userEvent.click(within(signins).getByRole('button', { name: 'Older' }))
    await pick(within(signins).getByLabelText('Per page'), '25')
    expect(names(signins)).toHaveLength(25)
    expect(names(signins)[0]).toBe('user1')
    expect(within(signins).getByText('Page 1 of 2')).toBeInTheDocument()
    expect(localStorage.getItem('shipdok.signinsPageSize')).toBe('25')
    expect(localStorage.getItem('shipdok.activityPageSize')).toBeNull()
    expect(names(screen.getByLabelText('Activity log'))).toHaveLength(10) // the other list keeps its own size
  })

  test('a remembered size is used, and a stored value that is not a choice is ignored', async () => {
    localStorage.setItem('shipdok.signinsPageSize', '5')
    localStorage.setItem('shipdok.activityPageSize', '7')
    mockApi({ 'GET /api/auth/logins': route([...many('login', 12), ...many('github', 12)]) })
    cards()
    await screen.findAllByText('user1')
    expect(names(screen.getByLabelText('Sign-ins'))).toHaveLength(5)
    expect(names(screen.getByLabelText('Activity log'))).toHaveLength(10)
  })

  test('the controls are left out when everything fits the smallest page', async () => {
    mockApi({ 'GET /api/auth/logins': route(many('login', 5)) })
    cards()
    await screen.findByText('user1')
    expect(screen.queryByLabelText('Per page')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Older' })).toBeNull()
  })

  test('with a few more than the smallest page, the size choice is there even at 10 a page', async () => {
    mockApi({ 'GET /api/auth/logins': route(many('login', 7)) })
    cards()
    const signins = await screen.findByLabelText('Sign-ins')
    await within(signins).findByText('user1')
    expect(within(signins).getByLabelText('Per page')).toBeInTheDocument()
    expect(within(signins).getByText('Page 1 of 1')).toBeInTheDocument()
  })

  test('blocked storage only means the default', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    mockApi({ 'GET /api/auth/logins': route(many('login', 12)) })
    cards()
    const signins = await screen.findByLabelText('Sign-ins')
    await within(signins).findByText('user1')
    await pick(within(signins).getByLabelText('Per page'), '5')
    expect(names(signins)).toHaveLength(5)
    vi.restoreAllMocks()
  })
})

describe('how long they are kept', () => {
  const setup = (keepDays = 30) => mockApi({ 'GET /api/auth/logins': route([row('github', 1)], keepDays), 'PUT /api/auth/logins/settings': { keepDays: 90 } })
  const select = async () => screen.findByLabelText('Keep the sign-ins and this log for')

  test('shows the current time, with the four choices', async () => {
    setup(30)
    cards()
    expect(await select()).toHaveChosen('30')
    expect(await select()).toHaveTextContent('30 days')
    expect(await listedValues(await select())).toEqual(['7', '30', '90', '365'])
  })

  test('shows a saved 365 as 1 year', async () => {
    setup(365)
    cards()
    expect(await select()).toHaveTextContent('1 year')
  })

  test('a choice asks for the password first; Save waits for one; the password and the days are sent; the lists are asked for again', async () => {
    const api = setup()
    cards()
    await pick(await select(), '90')
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/Keep the sign-ins and the activity for 90 days\?/)).toBeInTheDocument()
    expect(api.called('PUT', '/api/auth/logins/settings')).toHaveLength(0)
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
    const before = api.called('GET', '/api/auth/logins').length
    await userEvent.type(within(dialog).getByLabelText('Your password'), 'my-password')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.called('PUT', '/api/auth/logins/settings')).toHaveLength(1))
    expect(api.called('PUT', '/api/auth/logins/settings')[0].body).toEqual({ password: 'my-password', keepDays: 90 })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(toasts.success).toHaveBeenCalled()
    await waitFor(() => expect(api.called('GET', '/api/auth/logins').length).toBeGreaterThan(before))
  })

  test('a wrong password keeps the dialog open with the reason; Cancel sends nothing; choosing the current time does nothing', async () => {
    const api = mockApi({
      'GET /api/auth/logins': route([row('github', 1)]),
      'PUT /api/auth/logins/settings': () => { throw { status: 403, body: { error: 'The current password is not correct', code: 'wrong_password' } } },
    })
    cards()
    await pick(await select(), '30') // the time it already is
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await pick(await select(), '7')
    const dialog = await screen.findByRole('alertdialog')
    await userEvent.type(within(dialog).getByLabelText('Your password'), 'nope')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await within(dialog).findByText('The current password is not correct')).toBeInTheDocument()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(api.called('PUT', '/api/auth/logins/settings')).toHaveLength(1)
    expect(await select()).toHaveChosen('30') // nothing changed
  })
})
