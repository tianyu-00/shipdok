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

const NONE = { connected: false, app: null, problem: null }
const APP = { appId: '424242', slug: 'shipdok-ab12', name: 'Shipdok-ab12', ownerLogin: 'tianyu-00', htmlUrl: 'https://github.com/apps/shipdok-ab12', source: 'manifest', connectedAt: '2026-10-19T12:00:00Z' }
const CONNECTED = { connected: true, app: APP, problem: null }
const ACCESS = { mode: 'webhook', publicUrl: 'https://shipdok.example.com', modeLocked: false, urlLocked: false, visitor: 'local' }
const HOOK = 'https://shipdok.example.com/api/webhooks/github'
const routes = (github = NONE, over = {}) => ({
  'GET /api/github': github,
  'GET /api/settings/public': ACCESS,
  'GET /api/github/webhook': { expected: HOOK, actual: HOOK, matches: true },
  ...over,
})
const page = (route = '/github') => renderWithProviders(<GithubPage />, { route })
const card = async (title) => within((await screen.findByText(title, { selector: '[data-slot=card-title]' })).closest('[data-slot=card]'))

describe('not connected', () => {
  test('offers both ways to connect', async () => {
    mockApi(routes())
    page()
    expect(await card('Connect GitHub')).toBeTruthy()
    expect(await card('I already have a GitHub App')).toBeTruthy()
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
    const api = mockApi(routes(NONE, { 'GET /api/github': () => connected, 'POST /api/github/manual': () => { connected = CONNECTED; return CONNECTED } }))
    page()
    const c = await card('I already have a GitHub App')
    await fill(c)
    await userEvent.click(c.getByRole('button', { name: /^connect$/i }))
    await waitFor(() => expect(api.called('POST', '/api/github/manual')).toHaveLength(1))
    expect(api.called('POST', '/api/github/manual')[0].body).toEqual({
      password: 'my-current-password', appId: '123456', privateKey: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----', webhookSecret: 'a-webhook-secret-0123',
    })
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith(expect.stringMatching(/connected/i)))
    expect(await screen.findByText('GitHub is connected', { selector: '[data-slot=card-title]' })).toBeInTheDocument()
  })

  test('the secrets are in password-style fields', async () => {
    mockApi(routes())
    page()
    const c = await card('I already have a GitHub App')
    expect(c.getByLabelText('Webhook secret')).toHaveAttribute('type', 'password')
    expect(c.getByLabelText('Current password')).toHaveAttribute('type', 'password')
  })

  test('the secrets are not kept in the page after connecting', async () => {
    const api = mockApi(routes(NONE, { 'POST /api/github/manual': CONNECTED })) // the status stays "not connected", so the form stays on screen
    page()
    const c = await card('I already have a GitHub App')
    await fill(c)
    await userEvent.click(c.getByRole('button', { name: /^connect$/i }))
    await waitFor(() => expect(api.called('POST', '/api/github/manual')).toHaveLength(1))
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
    expect(api.called('POST', '/api/github/manual')).toHaveLength(0)
  })

  test("GitHub's or the server's refusal is explained and nothing changes", async () => {
    mockApi(routes(NONE, { 'POST /api/github/manual': answer(400, { error: 'GitHub did not accept this app ID and private key.', code: 'github_rejected' }) }))
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
    page('/github?connected=1')
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith(expect.stringMatching(/connected/i)))
  })

  test.each([['state', /expired|another window/i], ['exchange_failed', /did not hand over/i], ['github_unreachable', /could not reach/i], ['login', /session ended/i], ['already_connected', /already connected/i]])('the reason %s is explained', async (code, text) => {
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

describe('connected', () => {
  test('shows the app, where it came from, and a link to it on GitHub', async () => {
    mockApi(routes(CONNECTED))
    page()
    const c = await card('GitHub is connected')
    expect(c.getByRole('link', { name: 'Shipdok-ab12' })).toHaveAttribute('href', 'https://github.com/apps/shipdok-ab12')
    expect(c.getByText('424242')).toBeInTheDocument()
    expect(c.getByText('tianyu-00')).toBeInTheDocument()
    expect(c.getByText(/created by shipdok|connect github button/i)).toBeInTheDocument()
  })

  test('an app entered by hand says so', async () => {
    mockApi(routes({ ...CONNECTED, app: { ...APP, source: 'manual' } }))
    page()
    expect(await (await card('GitHub is connected')).findByText(/entered by hand/i)).toBeInTheDocument()
  })

  test('shows no secret anywhere', async () => {
    mockApi(routes(CONNECTED))
    const { container } = page()
    await card('GitHub is connected')
    expect(container.textContent).not.toMatch(/PRIVATE KEY|webhook secret value/i)
  })

  test('the connect cards are gone', async () => {
    mockApi(routes(CONNECTED))
    page()
    await card('GitHub is connected')
    expect(screen.queryByText('I already have a GitHub App', { selector: '[data-slot=card-title]' })).toBeNull()
  })

  test('installing the app: a link, and "check again" lists where it is installed', async () => {
    const api = mockApi(routes(CONNECTED, { 'GET /api/github/installations': { installations: [{ id: 7, account: 'tianyu-00' }] } }))
    page()
    const c = await card('GitHub is connected')
    expect(c.getByRole('link', { name: /install on repositories/i })).toHaveAttribute('href', 'https://github.com/apps/shipdok-ab12/installations/new')
    expect(api.called('GET', '/api/github/installations')).toHaveLength(0)
    await userEvent.click(c.getByRole('button', { name: /check again/i }))
    expect(await c.findByText('tianyu-00', { selector: 'li' })).toBeInTheDocument()
  })

  test('not installed anywhere is said plainly', async () => {
    mockApi(routes(CONNECTED, { 'GET /api/github/installations': { installations: [] } }))
    page()
    const c = await card('GitHub is connected')
    await userEvent.click(c.getByRole('button', { name: /check again/i }))
    expect(await c.findByText(/not installed on any account yet/i)).toBeInTheDocument()
  })

  test('a failure to ask GitHub is shown', async () => {
    mockApi(routes(CONNECTED, { 'GET /api/github/installations': answer(502, { error: 'Could not ask GitHub where the app is installed' }) }))
    page()
    const c = await card('GitHub is connected')
    await userEvent.click(c.getByRole('button', { name: /check again/i }))
    expect(await c.findByRole('alert')).toHaveTextContent('Could not ask GitHub')
  })

  test('credentials that cannot be read are reported', async () => {
    mockApi(routes({ connected: false, app: null, problem: 'cannot_decrypt' }))
    page()
    expect(await screen.findByText(/cannot be read/i)).toBeInTheDocument()
    expect(screen.getByText(/APP_SECRETS_KEY/)).toBeInTheDocument()
  })
})

describe('the webhook address', () => {
  test('matching is a calm confirmation', async () => {
    mockApi(routes(CONNECTED))
    page()
    const c = await card('Webhook address')
    expect(await c.findByText(/github sends pushes to the right address/i)).toBeInTheDocument()
    expect(c.getByText(HOOK)).toBeInTheDocument()
    expect(c.queryByRole('button', { name: /update on github/i })).toBeNull()
  })

  test('a mismatch shows both addresses and offers to fix it', async () => {
    const api = mockApi(routes(CONNECTED, { 'GET /api/github/webhook': { expected: HOOK, actual: 'https://old.example.com/api/webhooks/github', matches: false }, 'POST /api/github/webhook/sync': { expected: HOOK, actual: HOOK, matches: true } }))
    page()
    const c = await card('Webhook address')
    expect(await c.findByText('https://old.example.com/api/webhooks/github')).toBeInTheDocument()
    expect(c.queryByText(/sends pushes to the right address/i)).toBeNull()
    await userEvent.click(c.getByRole('button', { name: /update on github/i }))
    await waitFor(() => expect(api.called('POST', '/api/github/webhook/sync')).toHaveLength(1))
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith(expect.stringMatching(/updated/i)))
  })

  test('without a public address it says what to do', async () => {
    mockApi(routes(CONNECTED, { 'GET /api/github/webhook': { expected: null, actual: 'https://old.example.com/api/webhooks/github', matches: null } }))
    page()
    const c = await card('Webhook address')
    expect(await c.findByText(/no public address/i)).toBeInTheDocument()
    expect(c.getByRole('link', { name: /public access/i })).toHaveAttribute('href', '/security')
    expect(c.queryByRole('button', { name: /update on github/i })).toBeNull()
  })

  test('a failed update is explained', async () => {
    mockApi(routes(CONNECTED, { 'GET /api/github/webhook': { expected: HOOK, actual: null, matches: false }, 'POST /api/github/webhook/sync': answer(502, { error: 'GitHub did not accept the request.' }) }))
    page()
    const c = await card('Webhook address')
    await userEvent.click(await c.findByRole('button', { name: /update on github/i }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('GitHub did not accept the request.'))
  })

  test('failing to read it from GitHub is shown with a retry', async () => {
    mockApi(routes(CONNECTED, { 'GET /api/github/webhook': answer(502, { error: 'Could not reach GitHub. Try again in a moment.' }) }))
    page()
    const c = await card('Webhook address')
    expect(await c.findByRole('alert')).toHaveTextContent('Could not reach GitHub')
  })
})

describe('disconnecting', () => {
  const open = async () => {
    const c = await card('GitHub is connected')
    await userEvent.click(c.getByRole('button', { name: /disconnect/i }))
    return screen.findByRole('dialog')
  }

  test('explains what it does and asks for the password', async () => {
    mockApi(routes(CONNECTED))
    page()
    const dialog = await open()
    expect(dialog).toHaveTextContent(/keep running/i)
    expect(dialog).toHaveTextContent(/private repositories/i)
    expect(dialog).toHaveTextContent(/delete the app on github/i)
  })

  test('sends the password, then shows the connect cards again', async () => {
    let connected = CONNECTED
    const api = mockApi(routes(CONNECTED, { 'GET /api/github': () => connected, 'DELETE /api/github': () => { connected = NONE; return null } }))
    page()
    const dialog = await open()
    await userEvent.type(within(dialog).getByLabelText('Current password'), 'my-current-password')
    await userEvent.click(within(dialog).getByRole('button', { name: /^disconnect$/i }))
    await waitFor(() => expect(api.called('DELETE', '/api/github')).toHaveLength(1))
    expect(api.called('DELETE', '/api/github')[0].body).toEqual({ password: 'my-current-password' })
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith(expect.stringMatching(/disconnected/i)))
    expect(await screen.findByText('Connect GitHub', { selector: '[data-slot=card-title]' })).toBeInTheDocument()
  })

  test('no password, nothing sent; a wrong one is explained', async () => {
    const api = mockApi(routes(CONNECTED, { 'DELETE /api/github': answer(403, { error: 'The current password is not correct', code: 'wrong_password' }) }))
    page()
    const dialog = await open()
    await userEvent.click(within(dialog).getByRole('button', { name: /^disconnect$/i }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/current password/i)
    expect(api.called('DELETE', '/api/github')).toHaveLength(0)
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
    expect(api.called('DELETE', '/api/github')).toHaveLength(0)
  })
})

describe('loading', () => {
  test('a load error has a retry', async () => {
    mockApi(routes(NONE, { 'GET /api/github': () => { throw { status: 500, body: { error: 'github boom' } } } }))
    page()
    expect(await screen.findByText('github boom')).toBeInTheDocument()
  })
})
