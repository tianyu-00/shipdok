import { describe, test, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import GithubPage from './github-page'
import { mockApi, answer, renderWithProviders } from '@/test/utils'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts, Toaster: () => null }))
const lib = vi.hoisted(() => ({ postManifest: vi.fn() }))
vi.mock('@/lib/githubconnect', async (original) => ({ ...(await original()), ...lib }))
beforeEach(() => vi.clearAllMocks())

const ID1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ID2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const NONE = { apps: [] }
const APP = { id: ID1, appId: '424242', slug: 'shipdok-ab12', name: 'Shipdok-ab12', ownerLogin: 'tianyu-00', htmlUrl: 'https://github.com/apps/shipdok-ab12', source: 'manifest', connectedAt: '2026-10-19T12:00:00Z', problem: null, projects: [] }
const ORG = { id: ID2, appId: '515151', slug: 'shipdok-cd34', name: 'Shipdok-cd34', ownerLogin: 'my-org', htmlUrl: 'https://github.com/apps/shipdok-cd34', source: 'manual', connectedAt: '2026-10-20T12:00:00Z', problem: null, projects: [] }
const CONNECTED = { apps: [APP] }
const TWO = { apps: [APP, ORG] }
const ACCESS = { mode: 'webhook', publicUrl: 'https://shipdok.example.com', modeLocked: false, urlLocked: false, visitor: 'local' }
const HOOK = 'https://shipdok.example.com/api/webhooks/github'
const hook = (id, over = {}) => ({ [`GET /api/github/apps/${id}/webhook`]: { expected: HOOK, actual: HOOK, matches: true, ...over } })
const routes = (github = NONE, over = {}) => ({
  'GET /api/github': github,
  'GET /api/settings/public': ACCESS,
  ...hook(ID1),
  ...hook(ID2),
  ...over,
})
const page = (route = '/github') => renderWithProviders(<GithubPage />, { route })
const card = async (title) => within((await screen.findByText(title, { selector: '[data-slot=card-title]' })).closest('[data-slot=card]'))
const section = card // (one card per GitHub app)
// "Add a GitHub app" opens a dialog with two ways: have Shipdok create one, or enter one that exists.
const openAdd = async () => {
  await userEvent.click(await screen.findByRole('button', { name: /add a github app/i }))
  return within(await screen.findByRole('dialog'))
}
const openExisting = async () => {
  const dialog = await openAdd()
  await userEvent.click(dialog.getByRole('tab', { name: 'I already have one' }))
  return dialog
}

describe('not connected', () => {
  test('says so, and offers to add one', async () => {
    mockApi(routes())
    page()
    expect(await screen.findByText('No GitHub app is connected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add a github app/i })).toBeEnabled()
    expect(screen.queryByRole('dialog')).toBeNull() // the forms are not on the page until asked for
    expect(screen.queryByLabelText('App ID')).toBeNull()
  })

  test('no button, no forms and no "empty" message while the list is loading', async () => {
    let release
    const gate = new Promise((r) => { release = r })
    mockApi(routes(NONE, { 'GET /api/github': async () => { await gate; return NONE } }))
    page()
    expect(screen.queryByRole('button', { name: /add a github app/i })).toBeNull()
    expect(screen.queryByText('No GitHub app is connected')).toBeNull()
    release()
    expect(await screen.findByText('No GitHub app is connected')).toBeInTheDocument()
  })

  test('the dialog has both ways, "create one for me" first', async () => {
    mockApi(routes())
    page()
    const d = await openAdd()
    expect(d.getByRole('tab', { name: 'Create one for me' })).toHaveAttribute('aria-selected', 'true')
    expect(d.getByRole('tab', { name: 'I already have one' })).toHaveAttribute('aria-selected', 'false')
    expect(d.getByRole('button', { name: /connect github/i })).toBeInTheDocument()
    await userEvent.click(d.getByRole('tab', { name: 'I already have one' }))
    expect(d.getByLabelText('App ID')).toBeInTheDocument()
  })

  test('the button starts the flow and hands the definition to GitHub', async () => {
    const api = mockApi(routes(NONE, { 'POST /api/github/connect/start': { postUrl: 'https://github.com/settings/apps/new?state=s1', manifest: { name: 'Shipdok-ab12' } } }))
    page()
    const d = await openAdd()
    await userEvent.click(d.getByRole('button', { name: /connect github/i }))
    await waitFor(() => expect(lib.postManifest).toHaveBeenCalledWith({ postUrl: 'https://github.com/settings/apps/new?state=s1', manifest: { name: 'Shipdok-ab12' } }))
    expect(api.called('POST', '/api/github/connect/start')[0].body).toEqual({})
  })

  test('an organisation and a name are sent when chosen', async () => {
    const api = mockApi(routes(NONE, { 'POST /api/github/connect/start': { postUrl: 'https://github.com/organizations/my-org/settings/apps/new?state=s1', manifest: {} } }))
    page()
    const d = await openAdd()
    await userEvent.click(d.getByRole('radio', { name: /organisation/i }))
    await userEvent.type(d.getByLabelText('Organisation name'), 'my-org')
    await userEvent.type(d.getByLabelText('App name'), 'My Shipdok')
    await userEvent.click(d.getByRole('button', { name: /connect github/i }))
    await waitFor(() => expect(api.called('POST', '/api/github/connect/start')).toHaveLength(1))
    expect(api.called('POST', '/api/github/connect/start')[0].body).toEqual({ owner: 'my-org', name: 'My Shipdok' })
  })

  test('an organisation without a name is caught before anything is sent', async () => {
    const api = mockApi(routes())
    page()
    const d = await openAdd()
    await userEvent.click(d.getByRole('radio', { name: /organisation/i }))
    await userEvent.click(d.getByRole('button', { name: /connect github/i }))
    expect(await d.findByRole('alert')).toHaveTextContent(/organisation/i)
    expect(api.called('POST', '/api/github/connect/start')).toHaveLength(0)
  })

  test('says what it will ask GitHub for, and that nothing leaves without confirming', async () => {
    mockApi(routes())
    page()
    const d = await openAdd()
    expect(d.getByText(/read your repositories|read access to code/i)).toBeInTheDocument()
    expect(d.getByText(/confirm once on github/i)).toBeInTheDocument()
  })

  test('warns when there is no public address, but still lets you connect', async () => {
    mockApi(routes(NONE, { 'GET /api/settings/public': { ...ACCESS, publicUrl: '' } }))
    page()
    const d = await openAdd()
    expect(await d.findByText(/no public address/i)).toBeInTheDocument()
    expect(d.getByRole('link', { name: /public access/i })).toHaveAttribute('href', '/security')
    expect(d.getByRole('button', { name: /connect github/i })).toBeEnabled()
  })

  test('no warning when a public address is set', async () => {
    mockApi(routes())
    page()
    const d = await openAdd()
    await d.findByRole('button', { name: /connect github/i })
    expect(d.queryByText(/no public address/i)).toBeNull()
  })

  test('the server refusing to start is shown', async () => {
    mockApi(routes(NONE, { 'POST /api/github/connect/start': answer(400, { error: 'Open the dashboard at one of its configured addresses' }) }))
    page()
    const d = await openAdd()
    await userEvent.click(d.getByRole('button', { name: /connect github/i }))
    expect(await d.findByRole('alert')).toHaveTextContent('configured addresses')
    expect(lib.postManifest).not.toHaveBeenCalled()
  })

  test('with apps connected the button is still there, to add another', async () => {
    mockApi(routes(CONNECTED))
    page()
    await card('Shipdok-ab12')
    expect(screen.queryByText('No GitHub app is connected')).toBeNull()
    expect(await openAdd()).toBeTruthy()
  })
})

describe('entering an app by hand', () => {
  const fill = async (c, { appId = '123456', key = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----', secret = 'a-webhook-secret-0123', password = 'my-current-password' } = {}) => {
    await userEvent.type(c.getByLabelText('App ID'), appId)
    await userEvent.click(c.getByLabelText('Private key'))
    await userEvent.paste(key)
    await userEvent.type(c.getByLabelText('Webhook secret'), secret)
    if (password) await userEvent.type(c.getByLabelText('Current password'), password)
  }

  test('sends the id, the key, the secret and the password, then shows the connected app', async () => {
    let connected = NONE
    const api = mockApi(routes(NONE, { 'GET /api/github': () => connected, 'POST /api/github/apps': () => { connected = CONNECTED; return answer(201, { created: true, app: APP }) } }))
    page()
    const c = await openExisting()
    await fill(c)
    await userEvent.click(c.getByRole('button', { name: /^connect$/i }))
    await waitFor(() => expect(api.called('POST', '/api/github/apps')).toHaveLength(1))
    expect(api.called('POST', '/api/github/apps')[0].body).toEqual({
      password: 'my-current-password', appId: '123456', privateKey: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----', webhookSecret: 'a-webhook-secret-0123',
    })
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('GitHub app added'))
    expect(await screen.findByText('Shipdok-ab12', { selector: '[data-slot=card-title]' })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()) // done: the dialog closes
  })

  test('the same app entered again says it was updated, not added', async () => {
    mockApi(routes(CONNECTED, { 'POST /api/github/apps': { created: false, app: APP } }))
    page()
    const c = await openExisting()
    await fill(c)
    await userEvent.click(c.getByRole('button', { name: /^connect$/i }))
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('GitHub app updated'))
  })

  test('the secrets are in password-style fields', async () => {
    mockApi(routes())
    page()
    const c = await openExisting()
    expect(c.getByLabelText('Webhook secret')).toHaveAttribute('type', 'password')
    expect(c.getByLabelText('Current password')).toHaveAttribute('type', 'password')
  })

  test('the secrets are not kept in the page after connecting: opening it again gives an empty form', async () => {
    const api = mockApi(routes(NONE, { 'POST /api/github/apps': answer(201, { created: true, app: APP }) }))
    page()
    const c = await openExisting()
    await fill(c)
    await userEvent.click(c.getByRole('button', { name: /^connect$/i }))
    await waitFor(() => expect(api.called('POST', '/api/github/apps')).toHaveLength(1))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.body.textContent).not.toContain('a-webhook-secret-0123')
    const again = await openExisting()
    for (const label of ['App ID', 'Private key', 'Webhook secret', 'Current password']) expect(again.getByLabelText(label)).toHaveValue('')
  })

  test('a refusal leaves the dialog open with what was typed, so it can be fixed', async () => {
    mockApi(routes(NONE, { 'POST /api/github/apps': answer(400, { error: 'GitHub did not accept this app ID and private key.' }) }))
    page()
    const c = await openExisting()
    await fill(c)
    await userEvent.click(c.getByRole('button', { name: /^connect$/i }))
    await c.findByRole('alert')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(c.getByLabelText('App ID')).toHaveValue('123456')
  })

  test.each([
    [{ appId: 'abc' }, /number/i],
    [{ key: 'not a key' }, /private key/i],
    [{ secret: 'short' }, /at least 16/i],
    [{ password: '' }, /password/i],
  ])('a mistake (%j) is caught before anything is sent', async (over, why) => {
    const api = mockApi(routes())
    page()
    const c = await openExisting()
    await fill(c, over)
    await userEvent.click(c.getByRole('button', { name: /^connect$/i }))
    expect(await c.findByRole('alert')).toHaveTextContent(why)
    expect(api.called('POST', '/api/github/apps')).toHaveLength(0)
  })

  test("GitHub's or the server's refusal is explained and nothing changes", async () => {
    mockApi(routes(NONE, { 'POST /api/github/apps': answer(400, { error: 'GitHub did not accept this app ID and private key.', code: 'github_rejected' }) }))
    page()
    const c = await openExisting()
    await fill(c)
    await userEvent.click(c.getByRole('button', { name: /^connect$/i }))
    expect(await c.findByRole('alert')).toHaveTextContent('did not accept')
    expect(toasts.success).not.toHaveBeenCalled()
  })
})

describe('coming back from GitHub', () => {
  test('a success is announced', async () => {
    mockApi(routes(CONNECTED))
    page(`/github?connected=${ID1}`)
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('GitHub app connected'))
  })

  test.each([['state', /expired|another window/i], ['exchange_failed', /did not hand over/i], ['github_unreachable', /could not reach/i], ['login', /session ended/i]])('the reason %s is explained', async (code, text) => {
    mockApi(routes())
    page(`/github?error=${code}`)
    expect(await screen.findByText(text)).toBeInTheDocument()
  })

  test('no message when there is nothing in the address', async () => {
    mockApi(routes())
    page()
    await screen.findByText('No GitHub app is connected')
    expect(toasts.success).not.toHaveBeenCalled()
  })
})

describe('one connected app', () => {
  test('the card shows its name, account, link on GitHub, App ID and the Install button; the rest (projects, installations, source, date) is folded into Details', async () => {
    mockApi(routes({ apps: [{ ...APP, projects: [{ id: 'p1', name: 'Portfolio', slug: 'portfolio' }] }] }))
    page()
    const c = await card('Shipdok-ab12')
    expect(c.getByText('GitHub account: tianyu-00')).toBeInTheDocument()
    const details = c.getByText('Details').closest('details')
    expect(details).not.toHaveAttribute('open') // folded away until wanted
    // visible without opening anything
    expect(c.getByRole('link', { name: 'Shipdok-ab12' })).toHaveAttribute('href', 'https://github.com/apps/shipdok-ab12')
    expect(c.getByText('424242')).toBeInTheDocument()
    expect(details).not.toContainElement(c.getByRole('link', { name: 'Shipdok-ab12' }))
    expect(details).not.toContainElement(c.getByText('424242'))
    expect(c.getByRole('link', { name: /install on repositories/i })).toHaveAttribute('href', 'https://github.com/apps/shipdok-ab12/installations/new')
    expect(details).not.toContainElement(c.getByRole('link', { name: /install on repositories/i })) // the next step after adding an app is not hidden
    // inside Details
    const d = within(details)
    expect(d.getByText('Used by')).toBeInTheDocument()
    expect(d.getByRole('link', { name: 'Portfolio' })).toBeInTheDocument()
    expect(d.getByText('Installed on')).toBeInTheDocument()
    expect(d.getByRole('button', { name: /check again/i })).toBeInTheDocument()
    expect(d.getByText(/created by shipdok|connect github button/i)).toBeInTheDocument()
  })

  test('an app entered by hand says so', async () => {
    mockApi(routes({ apps: [{ ...APP, source: 'manual' }] }))
    page()
    expect(await (await card('Shipdok-ab12')).findByText(/entered by hand/i)).toBeInTheDocument()
  })

  test('shows no secret anywhere', async () => {
    mockApi(routes(CONNECTED))
    const { container } = page()
    await card('Shipdok-ab12')
    expect(container.textContent).not.toMatch(/PRIVATE KEY|webhook secret value/i)
  })

  test('installing the app: a link, and "check again" lists where it is installed', async () => {
    const api = mockApi(routes(CONNECTED, { [`GET /api/github/apps/${ID1}/installations`]: { installations: [{ id: 7, account: 'tianyu-00' }] } }))
    page()
    const c = await card('Shipdok-ab12')
    expect(c.getByRole('link', { name: /install on repositories/i })).toHaveAttribute('href', 'https://github.com/apps/shipdok-ab12/installations/new')
    expect(api.called('GET', `/api/github/apps/${ID1}/installations`)).toHaveLength(0)
    expect(c.getByText('Press Check again to look')).toBeInTheDocument() // it is not asked until you ask
    await userEvent.click(c.getByRole('button', { name: /check again/i }))
    expect(await c.findByText('tianyu-00', { selector: 'li' })).toBeInTheDocument()
    expect(c.queryByText('Press Check again to look')).toBeNull()
  })

  test('not installed anywhere is said plainly', async () => {
    mockApi(routes(CONNECTED, { [`GET /api/github/apps/${ID1}/installations`]: { installations: [] } }))
    page()
    const c = await card('Shipdok-ab12')
    await userEvent.click(c.getByRole('button', { name: /check again/i }))
    expect(await c.findByText(/not installed on any account yet/i)).toBeInTheDocument()
  })

  test('a failure to ask GitHub is shown', async () => {
    mockApi(routes(CONNECTED, { [`GET /api/github/apps/${ID1}/installations`]: answer(502, { error: 'Could not ask GitHub where the app is installed' }) }))
    page()
    const c = await card('Shipdok-ab12')
    await userEvent.click(c.getByRole('button', { name: /check again/i }))
    expect(await c.findByRole('alert')).toHaveTextContent('Could not ask GitHub')
  })

  test('says which projects use it, each a link', async () => {
    mockApi(routes({ apps: [{ ...APP, projects: [{ id: 'p1', name: 'Portfolio', slug: 'portfolio' }, { id: 'p2', name: 'Shop', slug: 'shop' }] }] }))
    page()
    const c = await card('Shipdok-ab12')
    expect(c.getByRole('link', { name: 'Portfolio' })).toHaveAttribute('href', '/apps/p1')
    expect(c.getByRole('link', { name: 'Shop' })).toHaveAttribute('href', '/apps/p2')
  })

  test('no project yet is said', async () => {
    mockApi(routes(CONNECTED))
    page()
    expect(await (await card('Shipdok-ab12')).findByText('No project yet')).toBeInTheDocument()
  })

  test('credentials that cannot be read are reported on that app, which can still be disconnected; GitHub is not asked about its webhook', async () => {
    const api = mockApi(routes({ apps: [{ ...APP, problem: 'cannot_decrypt' }] }, { [`GET /api/github/apps/${ID1}/webhook`]: answer(409, { error: 'cannot be read', code: 'cannot_decrypt' }) }))
    page()
    const c = await card('Shipdok-ab12')
    expect(await c.findByText(/stored credentials cannot be read/i)).toBeInTheDocument()
    expect(c.getByText(/APP_SECRETS_KEY/)).toBeInTheDocument()
    expect(c.getByRole('button', { name: /disconnect/i })).toBeEnabled()
    expect(c.queryByRole('button', { name: /check again/i })).toBeNull() // GitHub cannot be asked without its key
    expect(c.queryByText(/webhook (ok|address differs|not checked)|checking webhook/i)).toBeNull() // nor about its webhook
    expect(c.getAllByRole('alert')).toHaveLength(1) // only the one about the credentials, not a second about the webhook
    await new Promise((r) => setTimeout(r, 30))
    expect(api.called('GET', `/api/github/apps/${ID1}/webhook`)).toHaveLength(0)
  })
})

describe('several connected apps', () => {
  test('each has its own card, in the order they were connected', async () => {
    mockApi(routes(TWO))
    page()
    const titles = (await screen.findAllByText(/^Shipdok-/, { selector: '[data-slot=card-title]' })).map((t) => t.textContent)
    expect(titles).toEqual(['Shipdok-ab12', 'Shipdok-cd34'])
    expect(document.querySelectorAll('[data-slot=card]')).toHaveLength(2) // one card per app, nothing else
  })

  test('"check again" asks only that app', async () => {
    const api = mockApi(routes(TWO, {
      [`GET /api/github/apps/${ID1}/installations`]: { installations: [{ id: 7, account: 'tianyu-00' }] },
      [`GET /api/github/apps/${ID2}/installations`]: { installations: [{ id: 9, account: 'my-org' }] },
    }))
    page()
    const second = await section('Shipdok-cd34')
    await userEvent.click(second.getByRole('button', { name: /check again/i }))
    expect(await second.findByText('my-org', { selector: 'li' })).toBeInTheDocument()
    expect(api.called('GET', `/api/github/apps/${ID1}/installations`)).toHaveLength(0)
    expect(api.called('GET', `/api/github/apps/${ID2}/installations`)).toHaveLength(1)
  })

  test('what "check again" found is kept for that app only: the other app shows nothing until it is asked', async () => {
    mockApi(routes(TWO, { [`GET /api/github/apps/${ID1}/installations`]: { installations: [{ id: 7, account: 'tianyu-00' }] } }))
    page()
    const first = await section('Shipdok-ab12')
    const second = await section('Shipdok-cd34')
    await userEvent.click(first.getByRole('button', { name: /check again/i }))
    expect(await first.findByText('tianyu-00', { selector: 'li' })).toBeInTheDocument()
    expect(second.queryByText('Installed on:')).toBeNull()
    expect(first.getByText('Installed on:')).toBeInTheDocument()
    expect(second.queryByText('tianyu-00')).toBeNull()
  })

  test('a problem with one app does not touch the other', async () => {
    mockApi(routes({ apps: [{ ...APP, problem: 'cannot_decrypt' }, ORG] }))
    page()
    const first = await section('Shipdok-ab12')
    const second = await section('Shipdok-cd34')
    expect(await first.findByText(/APP_SECRETS_KEY/)).toBeInTheDocument()
    expect(second.queryByText(/APP_SECRETS_KEY/)).toBeNull()
    expect(await second.findByRole('button', { name: /check again/i })).toBeEnabled()
  })
})

describe('the webhook status on the card', () => {
  const OLD = 'https://old.example.com/api/webhooks/github'

  test('right: a calm "Webhook OK" in the header, and the address is in Details', async () => {
    mockApi(routes(CONNECTED))
    page()
    const c = await card('Shipdok-ab12')
    expect(await c.findByText('Webhook OK')).toBeInTheDocument()
    expect(within(c.getByText('Details').closest('details')).getByText(HOOK)).toBeInTheDocument()
    expect(c.queryByRole('button', { name: /update on github/i })).toBeNull()
    expect(c.queryByText(/sending pushes to a different address/i)).toBeNull() // nothing to explain
  })

  test('while GitHub is asked it says so', async () => {
    let release
    const gate = new Promise((r) => { release = r })
    mockApi(routes(CONNECTED, { [`GET /api/github/apps/${ID1}/webhook`]: async () => { await gate; return { expected: HOOK, actual: HOOK, matches: true } } }))
    page()
    const c = await card('Shipdok-ab12')
    expect(c.getByText('Checking webhook…')).toBeInTheDocument()
    release()
    expect(await c.findByText('Webhook OK')).toBeInTheDocument()
  })

  test('different: an amber mark and the fix in the header, and both addresses spelled out', async () => {
    const api = mockApi(routes(CONNECTED, { ...hook(ID1, { actual: OLD, matches: false }), [`POST /api/github/apps/${ID1}/webhook/sync`]: { expected: HOOK, actual: HOOK, matches: true } }))
    page()
    const c = await card('Shipdok-ab12')
    expect(await c.findByText('Webhook address differs')).toBeInTheDocument()
    expect(c.getByText(OLD)).toBeInTheDocument()
    expect(c.getAllByText(HOOK).length).toBeGreaterThan(0)
    expect(c.queryByText('Webhook OK')).toBeNull()
    await userEvent.click(c.getByRole('button', { name: /update on github/i }))
    await waitFor(() => expect(api.called('POST', `/api/github/apps/${ID1}/webhook/sync`)).toHaveLength(1))
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith(expect.stringMatching(/updated/i)))
  })

  test('with two apps, each is checked and fixed on its own', async () => {
    const api = mockApi(routes(TWO, { ...hook(ID2, { actual: OLD, matches: false }), [`POST /api/github/apps/${ID2}/webhook/sync`]: { expected: HOOK, actual: HOOK, matches: true } }))
    page()
    const first = await card('Shipdok-ab12')
    const second = await card('Shipdok-cd34')
    expect(await first.findByText('Webhook OK')).toBeInTheDocument()
    expect(first.queryByRole('button', { name: /update on github/i })).toBeNull()
    expect(await second.findByText('Webhook address differs')).toBeInTheDocument()
    await userEvent.click(second.getByRole('button', { name: /update on github/i }))
    await waitFor(() => expect(api.called('POST', `/api/github/apps/${ID2}/webhook/sync`)).toHaveLength(1))
    expect(api.called('POST', `/api/github/apps/${ID1}/webhook/sync`)).toHaveLength(0)
  })

  test('fixing one app asks GitHub again about that app only', async () => {
    const api = mockApi(routes(TWO, { ...hook(ID2, { actual: OLD, matches: false }), [`POST /api/github/apps/${ID2}/webhook/sync`]: { expected: HOOK, actual: HOOK, matches: true } }))
    page()
    const second = await card('Shipdok-cd34')
    await userEvent.click(await second.findByRole('button', { name: /update on github/i }))
    await waitFor(() => expect(api.called('GET', `/api/github/apps/${ID2}/webhook`).length).toBeGreaterThan(1)) // checked again
    expect(api.called('GET', `/api/github/apps/${ID1}/webhook`)).toHaveLength(1) // the other one was left alone
  })

  test('without a public address it says what to do, and offers no fix', async () => {
    mockApi(routes(CONNECTED, hook(ID1, { expected: null, actual: OLD, matches: null })))
    page()
    const c = await card('Shipdok-ab12')
    expect(await c.findByText('No public address')).toBeInTheDocument()
    expect(c.queryByText(/sending pushes to a different address/i)).toBeNull() // nothing to compare, so nothing is "different"
    expect(c.getByRole('link', { name: /public access/i })).toHaveAttribute('href', '/security')
    expect(c.queryByRole('button', { name: /update on github/i })).toBeNull()
  })

  test('a failed update is explained', async () => {
    mockApi(routes(CONNECTED, { ...hook(ID1, { actual: null, matches: false }), [`POST /api/github/apps/${ID1}/webhook/sync`]: answer(502, { error: 'GitHub did not accept the request.' }) }))
    page()
    const c = await card('Shipdok-ab12')
    await userEvent.click(await c.findByRole('button', { name: /update on github/i }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('GitHub did not accept the request.'))
  })

  test('GitHub having nothing for the address says "nothing", not a blank', async () => {
    mockApi(routes(CONNECTED, hook(ID1, { actual: null, matches: false })))
    page()
    expect(await (await card('Shipdok-ab12')).findByText('nothing')).toBeInTheDocument()
  })

  test('failing to read it from GitHub is shown with a retry, and the rest of the card still works', async () => {
    let fail = true
    const api = mockApi(routes(CONNECTED, { [`GET /api/github/apps/${ID1}/webhook`]: () => { if (fail) throw { status: 502, body: { error: 'Could not reach GitHub. Try again in a moment.' } }; return { expected: HOOK, actual: HOOK, matches: true } } }))
    page()
    const c = await card('Shipdok-ab12')
    expect(await c.findByText('Webhook not checked')).toBeInTheDocument()
    expect(c.getByRole('alert')).toHaveTextContent('Could not reach GitHub')
    expect(c.getByRole('button', { name: /check again/i })).toBeEnabled()
    fail = false
    await userEvent.click(c.getByRole('button', { name: 'Try again' }))
    expect(await c.findByText('Webhook OK')).toBeInTheDocument()
    expect(api.called('GET', `/api/github/apps/${ID1}/webhook`)).toHaveLength(2)
  })
})

describe('pushes that were refused', () => {
  const ago = (min) => new Date(Date.now() - min * 60_000).toISOString()
  const withRefusal = (over = {}) => ({ apps: [{ ...APP, refusedPush: { at: ago(3), count: 1 } }], unknownSenders: [], ...over })

  test('an app whose secret did not match says so on its card, with when, and what to do', async () => {
    mockApi(routes(withRefusal()))
    page()
    const c = await card('Shipdok-ab12')
    const note = await c.findByRole('note')
    expect(note).toHaveTextContent('A push from this app was refused 3 min ago')
    expect(note).toHaveTextContent(/did not match the webhook secret Shipdok has stored for this app, so nothing was deployed/)
    expect(note).toHaveTextContent(/same webhook secret on the app's page on GitHub and in Shipdok.*Redeliver/)
    expect(note).not.toHaveTextContent(/times/)
  })

  test('how many times, when it is more than once', async () => {
    mockApi(routes(withRefusal({ apps: [{ ...APP, refusedPush: { at: ago(3), count: 4 } }] })))
    page()
    expect(await (await card('Shipdok-ab12')).findByRole('note')).toHaveTextContent('refused 3 min ago (4 times)')
  })

  test('no warning on a card with nothing refused, and only that card has one', async () => {
    mockApi(routes({ apps: [{ ...APP, refusedPush: { at: ago(1), count: 1 } }, { ...ORG, refusedPush: null }], unknownSenders: [] }))
    page()
    const first = await card('Shipdok-ab12')
    const second = await card('Shipdok-cd34')
    expect(await first.findByRole('note')).toBeInTheDocument()
    expect(second.queryByRole('note')).toBeNull()
  })

  test('"Enter the secret again" opens the form for an app you already have, with its App ID filled in', async () => {
    mockApi(routes(withRefusal()))
    page()
    const c = await card('Shipdok-ab12')
    await userEvent.click(await c.findByRole('button', { name: 'Enter the secret again' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByRole('tab', { name: 'I already have one' })).toHaveAttribute('aria-selected', 'true')
    expect(dialog.getByLabelText('App ID')).toHaveValue('424242')
    expect(dialog.getByLabelText('Webhook secret')).toHaveValue('') // never filled in
  })

  test('a push from an app that is not connected is a notice at the top, with its number and when', async () => {
    mockApi(routes({ apps: [APP], unknownSenders: [{ appNumber: '5403580', at: ago(7), count: 2 }] }))
    page()
    const note = await screen.findByText(/GitHub App ID 5403580, which is not connected to this Shipdok/)
    const box = note.closest('[role=note]')
    expect(box).toHaveTextContent('refused 7 min ago (2 times) and nothing was deployed')
    expect(box).toHaveTextContent(/add it with its App ID, private key and webhook secret/i)
  })

  test('Dismiss asks the server to forget that sender, and the notice goes once the list is fetched again', async () => {
    let list = [{ appNumber: '5403580', at: ago(7), count: 2 }]
    const api = mockApi(routes(undefined, {
      'GET /api/github': () => ({ apps: [APP], unknownSenders: list }),
      'DELETE /api/github/refusals/5403580': () => { list = []; return null },
    }))
    page()
    await screen.findByText(/GitHub App ID 5403580, which is not connected/)
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(screen.queryByText(/GitHub App ID 5403580/)).toBeNull())
    expect(api.called('DELETE', '/api/github/refusals/5403580')).toHaveLength(1)
  })

  test('a push that did not say who sent it is dismissed as "none"', async () => {
    const api = mockApi(routes({ apps: [APP], unknownSenders: [{ appNumber: null, at: ago(2), count: 1 }] }, { 'DELETE /api/github/refusals/none': null }))
    page()
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(api.called('DELETE', '/api/github/refusals/none')).toHaveLength(1))
  })

  test('"Add this app" opens the form for an app you already have, with that number in App ID', async () => {
    mockApi(routes({ apps: [APP], unknownSenders: [{ appNumber: '5403580', at: ago(7), count: 1 }] }))
    page()
    await userEvent.click(await screen.findByRole('button', { name: 'Add this app' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByRole('tab', { name: 'I already have one' })).toHaveAttribute('aria-selected', 'true')
    expect(dialog.getByLabelText('App ID')).toHaveValue('5403580')
  })

  test('the ordinary "Add a GitHub app" button still opens the first way with an empty App ID, after one of those', async () => {
    mockApi(routes({ apps: [APP], unknownSenders: [{ appNumber: '5403580', at: ago(7), count: 1 }] }))
    page()
    await userEvent.click(await screen.findByRole('button', { name: 'Add this app' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const dialog = await openAdd()
    expect(dialog.getByRole('tab', { name: 'Create one for me' })).toHaveAttribute('aria-selected', 'true')
    await userEvent.click(dialog.getByRole('tab', { name: 'I already have one' }))
    expect(dialog.getByLabelText('App ID')).toHaveValue('')
  })

  test('a push that did not say who sent it has no number and no button to add anything', async () => {
    mockApi(routes({ apps: [APP], unknownSenders: [{ appNumber: null, at: ago(2), count: 1 }] }))
    page()
    expect(await screen.findByText(/GitHub did not say which app sent it/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add this app' })).toBeNull()
    expect(screen.getByText(/refused 2 min ago and nothing was deployed/)).toBeInTheDocument()
  })

  test('several senders each have their own notice', async () => {
    mockApi(routes({ apps: [APP], unknownSenders: [{ appNumber: '111', at: ago(1), count: 1 }, { appNumber: '222', at: ago(2), count: 1 }] }))
    page()
    expect(await screen.findByText(/GitHub App ID 111/)).toBeInTheDocument()
    expect(screen.getByText(/GitHub App ID 222/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Add this app' })).toHaveLength(2)
  })

  test('nothing refused: no notice anywhere', async () => {
    mockApi(routes({ apps: [APP], unknownSenders: [] }))
    page()
    await card('Shipdok-ab12')
    expect(screen.queryByText(/refused/i)).toBeNull()
  })

  test('with nothing connected a notice about an unknown sender can still show, next to the empty state', async () => {
    mockApi(routes({ apps: [], unknownSenders: [{ appNumber: '5403580', at: ago(1), count: 1 }] }))
    page()
    expect(await screen.findByText(/GitHub App ID 5403580/)).toBeInTheDocument()
    expect(screen.getByText('No GitHub app is connected')).toBeInTheDocument()
  })

  test('the page asks again every 30 seconds, so a refusal shows up without a reload', async () => {
    mockApi(routes(CONNECTED))
    const view = page()
    await card('Shipdok-ab12')
    const query = view.client.getQueryCache().find({ queryKey: ['github'] })
    expect(query.observers[0].options.refetchInterval).toBe(30_000)
  })
})

describe('disconnecting', () => {
  const open = async (name = 'Shipdok-ab12') => {
    const c = await card(name)
    await userEvent.click(c.getByRole('button', { name: /disconnect/i }))
    return screen.findByRole('dialog')
  }
  const USED = { ...APP, projects: [{ id: 'p1', name: 'Portfolio', slug: 'portfolio' }, { id: 'p2', name: 'Shop', slug: 'shop' }] }

  test('explains what it does and asks for the password', async () => {
    mockApi(routes(CONNECTED))
    page()
    const dialog = await open()
    expect(dialog).toHaveTextContent('Disconnect Shipdok-ab12?')
    expect(dialog).toHaveTextContent(/keep running/i)
    expect(dialog).toHaveTextContent(/delete it there/i)
    expect(dialog).toHaveTextContent(/no project uses this github app/i)
  })

  test('lists the projects that use it, and what happens to them', async () => {
    mockApi(routes({ apps: [USED] }))
    page()
    const dialog = await open()
    const note = within(dialog).getByRole('note')
    expect(note).toHaveTextContent('These 2 projects use it and will be left with no GitHub app')
    expect(within(note).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Portfolio', 'Shop'])
    expect(note).toHaveTextContent(/private repositories will fail/i)
    expect(note).toHaveTextContent(/pushes will not deploy them/i)
  })

  test('one project is said in the singular', async () => {
    mockApi(routes({ apps: [{ ...APP, projects: [{ id: 'p1', name: 'Portfolio', slug: 'portfolio' }] }] }))
    page()
    expect(await open()).toHaveTextContent('This project uses it and will be left with no GitHub app')
  })

  test('sends the password for that app only, then the list no longer has it', async () => {
    let apps = [APP, ORG]
    const api = mockApi(routes(TWO, { 'GET /api/github': () => ({ apps }), [`DELETE /api/github/apps/${ID1}`]: () => { apps = [ORG]; return null } }))
    page()
    const dialog = await open('Shipdok-ab12')
    await userEvent.type(within(dialog).getByLabelText('Current password'), 'my-current-password')
    await userEvent.click(within(dialog).getByRole('button', { name: /^disconnect$/i }))
    await waitFor(() => expect(api.called('DELETE', `/api/github/apps/${ID1}`)).toHaveLength(1))
    expect(api.called('DELETE', `/api/github/apps/${ID1}`)[0].body).toEqual({ password: 'my-current-password' })
    expect(api.called('DELETE', `/api/github/apps/${ID2}`)).toHaveLength(0)
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Shipdok-ab12 disconnected'))
    await waitFor(() => expect(screen.queryByText('Shipdok-ab12', { selector: '[data-slot=card-title]' })).toBeNull())
    expect(screen.getByText('Shipdok-cd34', { selector: '[data-slot=card-title]' })).toBeInTheDocument()
  })

  test('afterwards the apps list and the apps themselves are read again: the projects that used it have no GitHub app now', async () => {
    mockApi(routes(CONNECTED, { [`DELETE /api/github/apps/${ID1}`]: null }))
    const view = page()
    view.client.setQueryData(['apps'], [])
    view.client.setQueryData(['app', 'p1'], { id: 'p1' })
    const dialog = await open()
    await userEvent.type(within(dialog).getByLabelText('Current password'), 'my-current-password')
    await userEvent.click(within(dialog).getByRole('button', { name: /^disconnect$/i }))
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Shipdok-ab12 disconnected'))
    expect(view.client.getQueryState(['apps']).isInvalidated).toBe(true)
    expect(view.client.getQueryState(['app', 'p1']).isInvalidated).toBe(true)
  })

  test('no password, nothing sent; a wrong one is explained', async () => {
    const api = mockApi(routes(CONNECTED, { [`DELETE /api/github/apps/${ID1}`]: answer(403, { error: 'The current password is not correct', code: 'wrong_password' }) }))
    page()
    const dialog = await open()
    await userEvent.click(within(dialog).getByRole('button', { name: /^disconnect$/i }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/current password/i)
    expect(api.called('DELETE', `/api/github/apps/${ID1}`)).toHaveLength(0)
    await userEvent.type(within(dialog).getByLabelText('Current password'), 'not-it-not-it-1')
    await userEvent.click(within(dialog).getByRole('button', { name: /^disconnect$/i }))
    expect(await within(dialog).findByText('The current password is not correct')).toBeInTheDocument()
    expect(toasts.success).not.toHaveBeenCalled()
  })

  test('cancel closes it and sends nothing', async () => {
    const api = mockApi(routes(CONNECTED))
    page()
    const dialog = await open()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.called('DELETE', `/api/github/apps/${ID1}`)).toHaveLength(0)
  })
})

describe('loading', () => {
  test('a load error has a retry', async () => {
    mockApi(routes(NONE, { 'GET /api/github': () => { throw { status: 500, body: { error: 'github boom' } } } }))
    page()
    expect(await screen.findByText('github boom')).toBeInTheDocument()
  })
})
