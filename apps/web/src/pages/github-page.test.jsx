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
const section = async (name) => within(await screen.findByRole('region', { name }))

describe('not connected', () => {
  test('offers both ways to connect', async () => {
    mockApi(routes())
    page()
    expect(await card('Connect GitHub')).toBeTruthy()
    expect(await card('I already have a GitHub App')).toBeTruthy()
    expect(await screen.findByRole('heading', { name: 'Connect a GitHub app' })).toBeInTheDocument()
  })

  test('the button starts the flow and hands the definition to GitHub', async () => {
    const api = mockApi(routes(NONE, { 'POST /api/github/connect/start': { postUrl: 'https://github.com/settings/apps/new?state=s1', manifest: { name: 'Shipdok-ab12' } } }))
    page()
    const c = await card('Connect GitHub')
    await userEvent.click(c.getByRole('button', { name: /connect github/i }))
    await waitFor(() => expect(lib.postManifest).toHaveBeenCalledWith({ postUrl: 'https://github.com/settings/apps/new?state=s1', manifest: { name: 'Shipdok-ab12' } }))
    expect(api.called('POST', '/api/github/connect/start')[0].body).toEqual({})
  })

  test('an organisation and a name are sent when chosen', async () => {
    const api = mockApi(routes(NONE, { 'POST /api/github/connect/start': { postUrl: 'https://github.com/organizations/my-org/settings/apps/new?state=s1', manifest: {} } }))
    page()
    const c = await card('Connect GitHub')
    await userEvent.click(c.getByRole('radio', { name: /organisation/i }))
    await userEvent.type(c.getByLabelText('Organisation name'), 'my-org')
    await userEvent.type(c.getByLabelText('App name'), 'My Shipdok')
    await userEvent.click(c.getByRole('button', { name: /connect github/i }))
    await waitFor(() => expect(api.called('POST', '/api/github/connect/start')).toHaveLength(1))
    expect(api.called('POST', '/api/github/connect/start')[0].body).toEqual({ owner: 'my-org', name: 'My Shipdok' })
  })

  test('an organisation without a name is caught before anything is sent', async () => {
    const api = mockApi(routes())
    page()
    const c = await card('Connect GitHub')
    await userEvent.click(c.getByRole('radio', { name: /organisation/i }))
    await userEvent.click(c.getByRole('button', { name: /connect github/i }))
    expect(await c.findByRole('alert')).toHaveTextContent(/organisation/i)
    expect(api.called('POST', '/api/github/connect/start')).toHaveLength(0)
  })

  test('says what it will ask GitHub for, and that nothing leaves without confirming', async () => {
    mockApi(routes())
    page()
    const c = await card('Connect GitHub')
    expect(c.getByText(/read your repositories|read access to code/i)).toBeInTheDocument()
    expect(c.getByText(/confirm once on github/i)).toBeInTheDocument()
  })

  test('warns when there is no public address, but still lets you connect', async () => {
    mockApi(routes(NONE, { 'GET /api/settings/public': { ...ACCESS, publicUrl: '' } }))
    page()
    const c = await card('Connect GitHub')
    expect(await c.findByText(/no public address/i)).toBeInTheDocument()
    expect(c.getByRole('link', { name: /public access/i })).toHaveAttribute('href', '/security')
    expect(c.getByRole('button', { name: /connect github/i })).toBeEnabled()
  })

  test('no warning when a public address is set', async () => {
    mockApi(routes())
    page()
    const c = await card('Connect GitHub')
    await c.findByRole('button', { name: /connect github/i })
    expect(c.queryByText(/no public address/i)).toBeNull()
  })

  test('the server refusing to start is shown', async () => {
    mockApi(routes(NONE, { 'POST /api/github/connect/start': answer(400, { error: 'Open the dashboard at one of its configured addresses' }) }))
    page()
    const c = await card('Connect GitHub')
    await userEvent.click(c.getByRole('button', { name: /connect github/i }))
    expect(await c.findByRole('alert')).toHaveTextContent('configured addresses')
    expect(lib.postManifest).not.toHaveBeenCalled()
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
    const c = await card('I already have a GitHub App')
    await fill(c)
    await userEvent.click(c.getByRole('button', { name: /^connect$/i }))
    await waitFor(() => expect(api.called('POST', '/api/github/apps')).toHaveLength(1))
    expect(api.called('POST', '/api/github/apps')[0].body).toEqual({
      password: 'my-current-password', appId: '123456', privateKey: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----', webhookSecret: 'a-webhook-secret-0123',
    })
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('GitHub app added'))
    expect(await screen.findByText('Shipdok-ab12', { selector: '[data-slot=card-title]' })).toBeInTheDocument()
  })

  test('the same app entered again says it was updated, not added', async () => {
    mockApi(routes(CONNECTED, { 'POST /api/github/apps': { created: false, app: APP } }))
    page()
    const c = await card('I already have a GitHub App')
    await fill(c)
    await userEvent.click(c.getByRole('button', { name: /^connect$/i }))
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('GitHub app updated'))
  })

  test('the secrets are in password-style fields', async () => {
    mockApi(routes())
    page()
    const c = await card('I already have a GitHub App')
    expect(c.getByLabelText('Webhook secret')).toHaveAttribute('type', 'password')
    expect(c.getByLabelText('Current password')).toHaveAttribute('type', 'password')
  })

  test('the secrets are not kept in the page after connecting', async () => {
    const api = mockApi(routes(NONE, { 'POST /api/github/apps': answer(201, { created: true, app: APP }) })) // the list stays empty, so the form stays on screen
    page()
    const c = await card('I already have a GitHub App')
    await fill(c)
    await userEvent.click(c.getByRole('button', { name: /^connect$/i }))
    await waitFor(() => expect(api.called('POST', '/api/github/apps')).toHaveLength(1))
    await waitFor(() => expect(toasts.success).toHaveBeenCalled())
    for (const label of ['App ID', 'Private key', 'Webhook secret', 'Current password']) expect(c.getByLabelText(label)).toHaveValue('')
  })

  test.each([
    [{ appId: 'abc' }, /number/i],
    [{ key: 'not a key' }, /private key/i],
    [{ secret: 'short' }, /at least 16/i],
    [{ password: '' }, /password/i],
  ])('a mistake (%j) is caught before anything is sent', async (over, why) => {
    const api = mockApi(routes())
    page()
    const c = await card('I already have a GitHub App')
    await fill(c, over)
    await userEvent.click(c.getByRole('button', { name: /^connect$/i }))
    expect(await c.findByRole('alert')).toHaveTextContent(why)
    expect(api.called('POST', '/api/github/apps')).toHaveLength(0)
  })

  test("GitHub's or the server's refusal is explained and nothing changes", async () => {
    mockApi(routes(NONE, { 'POST /api/github/apps': answer(400, { error: 'GitHub did not accept this app ID and private key.', code: 'github_rejected' }) }))
    page()
    const c = await card('I already have a GitHub App')
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
    await card('Connect GitHub')
    expect(toasts.success).not.toHaveBeenCalled()
  })
})

describe('one connected app', () => {
  test('shows the app, where it came from, and a link to it on GitHub', async () => {
    mockApi(routes(CONNECTED))
    page()
    const c = await card('Shipdok-ab12')
    expect(c.getByRole('link', { name: 'Shipdok-ab12' })).toHaveAttribute('href', 'https://github.com/apps/shipdok-ab12')
    expect(c.getByText('424242')).toBeInTheDocument()
    expect(c.getByText('tianyu-00')).toBeInTheDocument()
    expect(c.getByText(/created by shipdok|connect github button/i)).toBeInTheDocument()
  })

  test('an app entered by hand says so', async () => {
    mockApi(routes({ apps: [{ ...APP, source: 'manual' }] }))
    page()
    expect(await (await card('Shipdok-ab12')).findByText(/entered by hand/i)).toBeInTheDocument()
  })

  test('shows no secret anywhere', async () => {
    mockApi(routes(CONNECTED))
    page()
    const sectionOfApp = await screen.findByRole('region', { name: 'Shipdok-ab12' }) // (the form for adding another app has a field called Private key)
    expect(sectionOfApp.textContent).not.toMatch(/PRIVATE KEY|webhook secret value/i)
  })

  test('the connect cards stay, to add another app', async () => {
    mockApi(routes(CONNECTED))
    page()
    await card('Shipdok-ab12')
    expect(await screen.findByRole('heading', { name: 'Add another GitHub app' })).toBeInTheDocument()
    expect(await card('Connect GitHub')).toBeTruthy()
    expect(await card('I already have a GitHub App')).toBeTruthy()
    expect((await card('Connect GitHub')).getByText(/add another github app, for another account or organisation/i)).toBeInTheDocument()
  })

  test('installing the app: a link, and "check again" lists where it is installed', async () => {
    const api = mockApi(routes(CONNECTED, { [`GET /api/github/apps/${ID1}/installations`]: { installations: [{ id: 7, account: 'tianyu-00' }] } }))
    page()
    const c = await card('Shipdok-ab12')
    expect(c.getByRole('link', { name: /install on repositories/i })).toHaveAttribute('href', 'https://github.com/apps/shipdok-ab12/installations/new')
    expect(api.called('GET', `/api/github/apps/${ID1}/installations`)).toHaveLength(0)
    await userEvent.click(c.getByRole('button', { name: /check again/i }))
    expect(await c.findByText('tianyu-00', { selector: 'li' })).toBeInTheDocument()
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

  test('credentials that cannot be read are reported on that app, which can still be disconnected', async () => {
    mockApi(routes({ apps: [{ ...APP, problem: 'cannot_decrypt' }] }))
    page()
    const c = await card('Shipdok-ab12')
    expect(await c.findByText(/cannot be read/i, { selector: '[data-slot=card-description]' })).toBeInTheDocument()
    expect(c.getByText(/APP_SECRETS_KEY/)).toBeInTheDocument()
    expect(c.getByRole('button', { name: /disconnect/i })).toBeEnabled()
    expect(c.queryByRole('button', { name: /check again/i })).toBeNull() // GitHub cannot be asked without its key
    expect(screen.queryByText('Webhook address', { selector: '[data-slot=card-title]' })).toBeNull()
  })
})

describe('several connected apps', () => {
  test('each has its own card, in the order they were connected', async () => {
    mockApi(routes(TWO))
    page()
    const titles = (await screen.findAllByText(/^Shipdok-/, { selector: '[data-slot=card-title]' })).map((t) => t.textContent)
    expect(titles).toEqual(['Shipdok-ab12', 'Shipdok-cd34'])
    expect(screen.getAllByText('Webhook address', { selector: '[data-slot=card-title]' })).toHaveLength(2)
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

describe('the webhook address', () => {
  test('matching is a calm confirmation', async () => {
    mockApi(routes(CONNECTED))
    page()
    const c = await card('Webhook address')
    expect(await c.findByText(/sends pushes to the right address/i)).toBeInTheDocument()
    expect(c.getByText(HOOK)).toBeInTheDocument()
    expect(c.queryByRole('button', { name: /update on github/i })).toBeNull()
  })

  test('a mismatch shows both addresses and offers to fix it', async () => {
    const api = mockApi(routes(CONNECTED, { ...hook(ID1, { actual: 'https://old.example.com/api/webhooks/github', matches: false }), [`POST /api/github/apps/${ID1}/webhook/sync`]: { expected: HOOK, actual: HOOK, matches: true } }))
    page()
    const c = await card('Webhook address')
    expect(await c.findByText('https://old.example.com/api/webhooks/github')).toBeInTheDocument()
    expect(c.queryByText(/sends pushes to the right address/i)).toBeNull()
    await userEvent.click(c.getByRole('button', { name: /update on github/i }))
    await waitFor(() => expect(api.called('POST', `/api/github/apps/${ID1}/webhook/sync`)).toHaveLength(1))
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith(expect.stringMatching(/updated/i)))
  })

  test('with two apps, each is checked and fixed on its own', async () => {
    const api = mockApi(routes(TWO, { ...hook(ID2, { actual: 'https://old.example.com/api/webhooks/github', matches: false }), [`POST /api/github/apps/${ID2}/webhook/sync`]: { expected: HOOK, actual: HOOK, matches: true } }))
    page()
    const first = await section('Shipdok-ab12')
    const second = await section('Shipdok-cd34')
    expect(await first.findByText(/sends pushes to the right address/i)).toBeInTheDocument()
    expect(first.queryByRole('button', { name: /update on github/i })).toBeNull()
    await userEvent.click(await second.findByRole('button', { name: /update on github/i }))
    await waitFor(() => expect(api.called('POST', `/api/github/apps/${ID2}/webhook/sync`)).toHaveLength(1))
    expect(api.called('POST', `/api/github/apps/${ID1}/webhook/sync`)).toHaveLength(0)
  })

  test('fixing one app asks GitHub again about that app only', async () => {
    const api = mockApi(routes(TWO, { ...hook(ID2, { actual: 'https://old.example.com/api/webhooks/github', matches: false }), [`POST /api/github/apps/${ID2}/webhook/sync`]: { expected: HOOK, actual: HOOK, matches: true } }))
    page()
    const second = await section('Shipdok-cd34')
    await userEvent.click(await second.findByRole('button', { name: /update on github/i }))
    await waitFor(() => expect(api.called('GET', `/api/github/apps/${ID2}/webhook`).length).toBeGreaterThan(1)) // checked again
    expect(api.called('GET', `/api/github/apps/${ID1}/webhook`)).toHaveLength(1) // the other one was left alone
  })

  test('without a public address it says what to do', async () => {
    mockApi(routes(CONNECTED, hook(ID1, { expected: null, actual: 'https://old.example.com/api/webhooks/github', matches: null })))
    page()
    const c = await card('Webhook address')
    expect(await c.findByText(/no public address/i)).toBeInTheDocument()
    expect(c.getByRole('link', { name: /public access/i })).toHaveAttribute('href', '/security')
    expect(c.queryByRole('button', { name: /update on github/i })).toBeNull()
  })

  test('a failed update is explained', async () => {
    mockApi(routes(CONNECTED, { ...hook(ID1, { actual: null, matches: false }), [`POST /api/github/apps/${ID1}/webhook/sync`]: answer(502, { error: 'GitHub did not accept the request.' }) }))
    page()
    const c = await card('Webhook address')
    await userEvent.click(await c.findByRole('button', { name: /update on github/i }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('GitHub did not accept the request.'))
  })

  test('failing to read it from GitHub is shown with a retry', async () => {
    mockApi(routes(CONNECTED, { [`GET /api/github/apps/${ID1}/webhook`]: answer(502, { error: 'Could not reach GitHub. Try again in a moment.' }) }))
    page()
    const c = await card('Webhook address')
    expect(await c.findByRole('alert')).toHaveTextContent('Could not reach GitHub')
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

  test('while the list is loading, no connect cards are offered yet', async () => {
    let release
    const gate = new Promise((r) => { release = r })
    mockApi(routes(NONE, { 'GET /api/github': async () => { await gate; return NONE } }))
    page()
    expect(screen.queryByText('Connect GitHub', { selector: '[data-slot=card-title]' })).toBeNull()
    release()
    expect(await card('Connect GitHub')).toBeTruthy()
  })
})
