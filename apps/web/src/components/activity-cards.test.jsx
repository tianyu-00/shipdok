import { describe, test, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SignInsCard, ActivityCard } from '@/components/activity-cards'
import { mockApi, renderWithProviders, pick, listedValues } from '@/test/utils'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts, Toaster: () => null }))
beforeEach(() => vi.clearAllMocks())

const NOW = Date.now()
const ago = (n) => new Date(NOW - n * 60_000).toISOString()
const login = (kind, n, extra = {}) => ({ at: ago(n), kind, username: `user${n}`, address: '192.168.1.20', success: true, ...extra })
const entry = (n, extra = {}) => ({ id: String(n), at: ago(n), category: 'github', action: 'github_changed', summary: `Summary ${n}`, details: [], actor: 'admin', address: '192.168.1.20', source: 'user', appId: null, appName: null, ...extra })
const logins = (count, kind = 'login') => Array.from({ length: count }, (_, i) => login(kind, i + 1))
const entries = (count, extra = {}) => Array.from({ length: count }, (_, i) => entry(i + 1, extra))

// The API as the cards see it: the sign-ins, and the activity log narrowed by the category and the search text of the request.
function fakeApi({ signins = [], log = [], keepDays = 30, ...more } = {}) {
  return mockApi({
    'GET /api/auth/logins': () => ({ logins: signins, keepDays }),
    'GET /api/audit': (call) => {
      const u = new URL(call.path, 'http://x')
      const category = u.searchParams.get('category')
      const q = (u.searchParams.get('q') ?? '').toLowerCase()
      const automatic = u.searchParams.get('automatic') === '1'
      return { keepDays, entries: log.filter((e) => (!category || e.category === category) && e.summary.toLowerCase().includes(q) && (automatic || e.source === 'user')) }
    },
    ...more,
  })
}
const cards = () => renderWithProviders(<><SignInsCard /><ActivityCard /></>)
const rowsOf = (c) => within(c).getAllByRole('row').slice(1)
// The entries of the activity log (a list of blocks, not a table); the details lists inside an entry are not entries.
const entriesOf = (c) => { const list = within(c).getByRole('list', { name: 'Entries' }); return within(list).getAllByRole('listitem').filter((li) => li.parentElement === list) }
const cellText = (c, col) => rowsOf(c).map((r) => within(r).getAllByRole('cell')[col].textContent)

describe('the sign-ins card', () => {
  test('is asked for up to 500 sign-ins, and names each kind (a failed one is Failed)', async () => {
    const mock = fakeApi({ signins: [login('login', 1), login('recovery', 2), login('setup', 3), login('reset', 4), login('login', 5, { success: false })] })
    cards()
    const card = await screen.findByLabelText('Sign-ins')
    await within(card).findByText('Recovery code used')
    for (const t of ['Signed in', 'Account created', 'Password reset on the host', 'Failed']) expect(within(card).getByText(t)).toBeInTheDocument()
    expect(mock.calls.map((c) => c.path)).toContain('/api/auth/logins?limit=500')
    expect(within(card).getByText('(5)')).toBeInTheDocument()
  })

  test('says so when empty; names typed by strangers are plain text', async () => {
    fakeApi({})
    cards()
    expect(await screen.findByText('No sign-ins recorded yet')).toBeInTheDocument()
  })

  test('a stranger\'s name is plain text', async () => {
    fakeApi({ signins: [login('login', 1, { username: '<b>x</b>', success: false })] })
    const { container } = cards()
    expect(await screen.findByText('<b>x</b>')).toBeInTheDocument()
    expect(container.querySelector('b')).toBeNull()
  })

  test('shows 10 at a time, newest first, with Newer / Older, and remembers its own page size', async () => {
    fakeApi({ signins: logins(25), log: entries(25) })
    cards()
    const card = await screen.findByLabelText('Sign-ins')
    await within(card).findByText('user1')
    expect(cellText(card, 1)).toEqual(Array.from({ length: 10 }, (_, i) => `user${i + 1}`))
    expect(within(card).getByText('Page 1 of 3')).toBeInTheDocument()
    await userEvent.click(within(card).getByRole('button', { name: 'Older' }))
    expect(cellText(card, 1)[0]).toBe('user11')
    await pick(within(card).getByLabelText('Per page'), '25')
    expect(rowsOf(card)).toHaveLength(25)
    expect(localStorage.getItem('shipdok.signinsPageSize')).toBe('25')
    expect(localStorage.getItem('shipdok.activityPageSize')).toBeNull()
    expect(entriesOf(screen.getByLabelText('Activity log'))).toHaveLength(10)
  })
})

describe('the activity log card', () => {
  test('is asked for up to 500 entries, and shows when, who and from where, the category and the summary', async () => {
    const mock = fakeApi({ log: [entry(1, { category: 'security', summary: 'Public access changed: Local only → Full', actor: 'tian', address: '::ffff:10.0.0.5' }), entry(2, { category: 'backups', summary: 'Restore started for Blog' })] })
    cards()
    const card = await screen.findByLabelText('Activity log')
    await within(card).findByText('Restore started for Blog')
    expect(mock.calls.map((c) => c.path)).toContain('/api/audit?limit=500')
    const first = entriesOf(card)[0]
    expect(within(first).getByText('Public access changed: Local only → Full')).toBeInTheDocument()
    expect(within(first).getByText('Security')).toBeInTheDocument()
    expect(within(first).getByText('tian')).toBeInTheDocument()
    expect(within(first).getByText('10.0.0.5')).toBeInTheDocument()
    expect(within(first).getByText('1 min ago')).toBeInTheDocument()
    expect(within(entriesOf(card)[1]).getByText('Backups and restores')).toBeInTheDocument()
    expect(within(card).getByText('(2)')).toBeInTheDocument()
  })

  test('the details are hidden until the arrow is pressed: a change reads from → to, an empty side is "none", another fact reads label: value', async () => {
    fakeApi({ log: [entry(1, { summary: 'Public access changed', details: [{ label: 'Public address', from: '', to: 'https://a.example.com' }, { label: 'Who may reach Shipdok', from: 'Local only', to: 'Full' }, { label: 'Effect', value: 'the next backups' }] })] })
    cards()
    const card = await screen.findByLabelText('Activity log')
    const toggle = await within(card).findByRole('button', { name: 'Show the details of: Public access changed' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(within(card).queryByText(/Public address:/)).toBeNull()
    await userEvent.click(toggle)
    const list = within(card).getByRole('list', { name: 'Details of: Public access changed' })
    expect(within(list).getAllByRole('listitem').map((l) => l.textContent)).toEqual([
      'Public address: none → https://a.example.com', 'Who may reach Shipdok: Local only → Full', 'Effect: the next backups',
    ])
    expect(within(card).getByRole('button', { name: 'Hide the details of: Public access changed' })).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(within(card).getByRole('button', { name: /Hide the details/ }))
    expect(within(card).queryByRole('list', { name: /Details of/ })).toBeNull()
  })

  test('an entry without details has no arrow; each entry opens on its own', async () => {
    fakeApi({ log: [entry(1, { summary: 'No details here' }), entry(2, { summary: 'Has one', details: [{ label: 'A', value: '1' }] }), entry(3, { summary: 'Has two', details: [{ label: 'B', value: '2' }] })] })
    cards()
    const card = await screen.findByLabelText('Activity log')
    await within(card).findByText('No details here')
    expect(within(card).queryByRole('button', { name: /details of: No details here/ })).toBeNull()
    await userEvent.click(within(card).getByRole('button', { name: 'Show the details of: Has one' }))
    expect(within(card).getByText('A: 1')).toBeInTheDocument()
    expect(within(card).queryByText('B: 2')).toBeNull()
  })

  test('details are plain text', async () => {
    fakeApi({ log: [entry(1, { summary: 's', details: [{ label: 'App', value: '<img src=x onerror=alert(1)>' }] })] })
    const { container } = cards()
    await userEvent.click(await screen.findByRole('button', { name: /Show the details/ }))
    expect(await screen.findByText('App: <img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
  })

  test('says so when empty', async () => {
    fakeApi({})
    cards()
    expect(await screen.findByText('No activity recorded yet')).toBeInTheDocument()
  })

  test('a category button asks for that category only, is shown as pressed, and All goes back', async () => {
    const mock = fakeApi({ log: [entry(1, { category: 'security', summary: 'A sec' }), entry(2, { category: 'github', summary: 'A hub' }), entry(3, { category: 'backups', summary: 'A bak' })] })
    cards()
    const card = await screen.findByLabelText('Activity log')
    await within(card).findByText('A sec')
    const group = within(card).getByRole('group', { name: 'Category' })
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['All', 'Security', 'GitHub', 'Apps', 'Deployments', 'Variables', 'Storage', 'Backups and restores'])
    expect(within(group).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(within(group).getByRole('button', { name: 'GitHub' }))
    await waitFor(() => expect(within(card).queryByText('A sec')).toBeNull())
    expect(within(card).getByText('A hub')).toBeInTheDocument()
    expect(within(group).getByRole('button', { name: 'GitHub' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(group).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false')
    expect(mock.calls.map((c) => c.path)).toContain('/api/audit?limit=500&category=github')
    await userEvent.click(within(group).getByRole('button', { name: 'Backups and restores' }))
    expect(await within(card).findByText('A bak')).toBeInTheDocument()
    await userEvent.click(within(group).getByRole('button', { name: 'All' }))
    expect(await within(card).findByText('A sec')).toBeInTheDocument()
    expect(within(card).getByText('A hub')).toBeInTheDocument()
  })

  test('the search is sent after a pause in typing, with the category, and "Nothing matches" is said when there is nothing', async () => {
    const mock = fakeApi({ log: [entry(1, { category: 'security', summary: 'Public access changed' }), entry(2, { category: 'github', summary: 'GitHub app connected' })] })
    cards()
    const card = await screen.findByLabelText('Activity log')
    await within(card).findByText('Public access changed')
    await userEvent.type(within(card).getByLabelText('Search the activity log'), 'connected')
    expect(await within(card).findByText('GitHub app connected')).toBeInTheDocument()
    await waitFor(() => expect(within(card).queryByText('Public access changed')).toBeNull())
    const searches = mock.calls.map((c) => c.path).filter((p) => p.includes('q='))
    expect(searches).toEqual(['/api/audit?limit=500&q=connected']) // one request, not one per key
    await userEvent.click(within(card).getByRole('button', { name: 'Security' }))
    expect(await within(card).findByText('Nothing matches')).toBeInTheDocument()
    expect(mock.calls.map((c) => c.path)).toContain('/api/audit?limit=500&category=security&q=connected')
  })

  test('what Shipdok did by itself is hidden until the switch is on, then it is asked for and marked Automatic', async () => {
    const mock = fakeApi({ log: [entry(1, { summary: 'Mine' }), entry(2, { summary: 'Push to main deployed Site', category: 'deployments', source: 'webhook', actor: 'GitHub' })] })
    cards()
    const card = await screen.findByLabelText('Activity log')
    await within(card).findByText('Mine')
    expect(within(card).queryByText('Push to main deployed Site')).toBeNull()
    expect(within(card).queryByText('Automatic')).toBeNull()
    const toggle = within(card).getByRole('switch', { name: 'Show automatic events' })
    expect(toggle).not.toBeChecked()
    expect(mock.calls.map((c) => c.path).some((p) => p.includes('automatic'))).toBe(false)
    await userEvent.click(toggle)
    expect(await within(card).findByText('Push to main deployed Site')).toBeInTheDocument()
    expect(mock.calls.map((c) => c.path)).toContain('/api/audit?limit=500&automatic=1')
    expect(within(entriesOf(card)[1]).getByText('Automatic')).toBeInTheDocument() // the older entry
    expect(within(entriesOf(card)[0]).queryByText('Automatic')).toBeNull()
    await userEvent.click(toggle)
    await waitFor(() => expect(within(card).queryByText('Push to main deployed Site')).toBeNull())
  })

  test('the switch works with a category and a search, and with it on "Nothing matches" is still said when it should be', async () => {
    const mock = fakeApi({ log: [entry(1, { summary: 'Mine', category: 'apps' })] })
    cards()
    const card = await screen.findByLabelText('Activity log')
    await within(card).findByText('Mine')
    await userEvent.click(within(card).getByRole('switch', { name: 'Show automatic events' }))
    await userEvent.click(within(card).getByRole('button', { name: 'Deployments' }))
    expect(await within(card).findByText('Nothing matches')).toBeInTheDocument()
    expect(mock.calls.map((c) => c.path)).toContain('/api/audit?limit=500&category=deployments&automatic=1')
  })

  test('the switch goes back to page 1', async () => {
    fakeApi({ log: [...entries(15), entry(50, { summary: 'Auto', source: 'schedule' })] })
    cards()
    const card = await screen.findByLabelText('Activity log')
    await within(card).findByText('Summary 1')
    await userEvent.click(within(card).getByRole('button', { name: 'Older' }))
    expect(within(card).getByText('Page 2 of 2')).toBeInTheDocument()
    await userEvent.click(within(card).getByRole('switch', { name: 'Show automatic events' }))
    expect(await within(card).findByText('Page 1 of 2')).toBeInTheDocument()
  })

  test('shows 10 at a time with the paging controls; a filter or a search goes back to page 1', async () => {
    fakeApi({ log: [...entries(25, { category: 'github' }), ...Array.from({ length: 15 }, (_, i) => entry(100 + i, { category: 'security', summary: `Sec ${i}` }))] })
    cards()
    const card = await screen.findByLabelText('Activity log')
    await within(card).findByText('Summary 1')
    expect(entriesOf(card)).toHaveLength(10)
    expect(within(card).getByText('Page 1 of 4')).toBeInTheDocument()
    await userEvent.click(within(card).getByRole('button', { name: 'Older' }))
    expect(within(card).getByText('Page 2 of 4')).toBeInTheDocument()
    await userEvent.click(within(card).getByRole('button', { name: 'Security' }))
    expect(await within(card).findByText('Page 1 of 2')).toBeInTheDocument()
    await userEvent.click(within(card).getByRole('button', { name: 'Older' }))
    await userEvent.type(within(card).getByLabelText('Search the activity log'), 'Sec')
    expect(await within(card).findByText('Page 1 of 2')).toBeInTheDocument()
  })

  test('a remembered page size is used, and the size choice is remembered for this list only', async () => {
    localStorage.setItem('shipdok.activityPageSize', '5')
    fakeApi({ log: entries(12), signins: logins(12) })
    cards()
    const card = await screen.findByLabelText('Activity log')
    await within(card).findByText('Summary 1')
    expect(entriesOf(card)).toHaveLength(5)
    expect(rowsOf(screen.getByLabelText('Sign-ins'))).toHaveLength(10)
    await pick(within(card).getByLabelText('Per page'), '25')
    expect(entriesOf(card)).toHaveLength(12)
    expect(localStorage.getItem('shipdok.activityPageSize')).toBe('25')
    expect(localStorage.getItem('shipdok.signinsPageSize')).toBeNull()
  })

  test('the controls are left out when everything fits the smallest page', async () => {
    fakeApi({ log: entries(5) })
    cards()
    const card = await screen.findByLabelText('Activity log')
    await within(card).findByText('Summary 1')
    expect(within(card).queryByLabelText('Per page')).toBeNull()
  })
})

describe('how long they are kept', () => {
  const setup = (keepDays = 30) => fakeApi({ log: [entry(1)], keepDays, 'PUT /api/auth/logins/settings': { keepDays: 90 } })
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
    const before = api.called('GET', '/api/audit').length
    await userEvent.type(within(dialog).getByLabelText('Your password'), 'my-password')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.called('PUT', '/api/auth/logins/settings')).toHaveLength(1))
    expect(api.called('PUT', '/api/auth/logins/settings')[0].body).toEqual({ password: 'my-password', keepDays: 90 })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(toasts.success).toHaveBeenCalled()
    await waitFor(() => expect(api.called('GET', '/api/audit').length).toBeGreaterThan(before))
  })

  test('a wrong password keeps the dialog open with the reason; Cancel sends nothing; choosing the current time does nothing', async () => {
    const api = fakeApi({
      log: [entry(1)],
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
