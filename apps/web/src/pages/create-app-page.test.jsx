import { describe, test, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Routes, Route } from 'react-router-dom'
import CreateAppPage from './create-app-page'
import { mockApi, answer, renderWithProviders } from '@/test/utils'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts, Toaster: () => null }))
beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear() })

// With a GitHub App connected the repository is chosen from a searchable list: open it, search, and take the first match (or "Use ...").
const repoBox = () => screen.findByRole('combobox', { name: 'GitHub repository' })
const chooseRepo = async (text) => {
  await userEvent.click(await repoBox())
  await userEvent.type(screen.getByLabelText('Search repositories'), text)
  await userEvent.keyboard('{Enter}')
}
const page = () => renderWithProviders(<Routes><Route path="/apps/new" element={<CreateAppPage />} /><Route path="/apps/:id" element={<p>detail page</p>} /><Route path="/github" element={<p>github page</p>} /></Routes>, { route: '/apps/new' })
const repos = { repos: [{ fullName: 'tianyu-00/site', private: true, defaultBranch: 'trunk' }, { fullName: 'tianyu-00/api', private: false, defaultBranch: 'main' }] }
// One GitHub app is connected: the form starts with it, so nothing has to be chosen and the repositories are its own.
const APP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SECOND = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const gh = (over = {}) => ({ id: APP, appId: '1', name: 'Shipdok-ab12', ownerLogin: 'tianyu-00', slug: 'shipdok-ab12', projects: [], problem: null, ...over })
const connected = { 'GET /api/github': { apps: [gh()] }, [`GET /api/github/apps/${APP}/repos`]: repos }
const two = {
  'GET /api/github': { apps: [gh(), gh({ id: SECOND, appId: '2', name: 'Shipdok-cd34', ownerLogin: 'my-org', slug: 'shipdok-cd34' })] },
  [`GET /api/github/apps/${APP}/repos`]: repos,
  [`GET /api/github/apps/${SECOND}/repos`]: { repos: [{ fullName: 'my-org/tools', private: true, defaultBranch: 'main' }] },
}
const created = { 'POST /api/apps': answer(201, { id: 'new-id', name: 'x' }) }

// What the server says about a repository: it can be seen. Nothing about what is inside it is asked or answered.
const found = (over = {}) => ({ accessible: true, fullName: 'tianyu-00/site', private: true, defaultBranch: 'trunk', via: 'app', appChosen: true, ...over })
// The answer to GET /api/github/repo-check, per repository (`by`), or the same for all.
const checks = (by = {}, fallback = found()) => ({
  'GET /api/github/repo-check': (call) => {
    const q = new URL(call.path, 'http://x').searchParams
    const repo = q.get('repo')
    return by[repo] ?? { ...fallback, fullName: repo }
  },
})

const continueButton = () => screen.getByRole('button', { name: 'Continue' })
const next = async () => {
  await waitFor(() => expect(continueButton()).toBeEnabled(), { timeout: 4000 })
  await userEvent.click(continueButton())
}
const toMethod = async (text) => { await chooseRepo(text); await next() }
const toDetails = async (text) => { await toMethod(text); await next() }
const card = (name) => screen.getByRole('radio', { name: new RegExp(`^${name}`) })
const create = async () => { await userEvent.click(screen.getByRole('button', { name: 'Create app' })) }

describe('the steps', () => {
  test('start with the repository, and say where you are', async () => {
    mockApi({ ...connected, ...checks() })
    page()
    expect(await screen.findByText('Step 1 of 3: Repository')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Continue' })).toBeDisabled()
  })

  test('go repository, build method, details, and say so at each', async () => {
    mockApi({ ...connected, ...checks() })
    page()
    await toMethod('tianyu-00/site')
    expect(screen.getByText('Step 2 of 3: Build method')).toBeInTheDocument()
    await next()
    expect(screen.getByText('Step 3 of 3: Details')).toBeInTheDocument()
    expect(screen.getByText(/Creating the app does not build it: you press Deploy when you are ready/)).toBeInTheDocument()
  })

  test('Back goes the other way and nothing already chosen is lost', async () => {
    mockApi({ ...connected, ...checks() })
    page()
    await toMethod('tianyu-00/site')
    await userEvent.click(card('Dockerfile'))
    await next()
    await userEvent.type(screen.getByLabelText('Name'), 'X')
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByText('Step 2 of 3: Build method')).toBeInTheDocument()
    expect(card('Dockerfile')).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByText('Step 1 of 3: Repository')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'GitHub repository' })).toHaveTextContent('tianyu-00/site')
    await next() // the same repository: the method chosen is still there
    expect(card('Dockerfile')).toHaveAttribute('aria-checked', 'true')
    await next()
    expect(screen.getByLabelText('Name')).toHaveValue('siteX')
  })
})

describe('step 1: which GitHub app', () => {
  const select = () => screen.findByLabelText('GitHub app')

  test('with exactly one connected, it is already chosen: the repositories load and it is sent', async () => {
    const api = mockApi({ ...connected, ...checks(), ...created })
    page()
    expect(await select()).toHaveValue(APP)
    await toDetails('tianyu-00/site')
    await create()
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    expect(api.called('POST', '/api/apps')[0].body.github_app_id).toBe(APP)
    expect(api.called('GET', `/api/github/apps/${APP}/repos`)).toHaveLength(1)
  })

  test('with several, none is chosen for you: nothing is checked and you cannot go on until one is (or None)', async () => {
    const api = mockApi({ ...two, ...checks() })
    page()
    const box = await select()
    expect(box).toHaveValue('__choose')
    expect(within(box).getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose a GitHub app…', 'Shipdok-ab12 (tianyu-00)', 'Shipdok-cd34 (my-org)', 'None (a public repository, deployed by hand)'])
    await userEvent.type(await screen.findByPlaceholderText(/owner\/repo/), 'someone/else')
    expect(await screen.findByText('Choose a GitHub app (or None) first.')).toBeInTheDocument()
    expect(continueButton()).toBeDisabled()
    await new Promise((r) => setTimeout(r, 600))
    expect(api.called('GET', '/api/github/repo-check')).toHaveLength(0)
    await userEvent.selectOptions(box, SECOND)
    await waitFor(() => expect(api.called('GET', '/api/github/repo-check')).toHaveLength(1))
  })

  test('the repositories listed are the chosen app\'s, and change when another is chosen', async () => {
    const api = mockApi({ ...two })
    page()
    await userEvent.selectOptions(await select(), APP)
    await userEvent.click(await repoBox())
    expect(within(await screen.findByRole('listbox')).getAllByRole('option').map((o) => o.textContent.replace(/private|public/, ''))).toEqual(['tianyu-00/api', 'tianyu-00/site'])
    await userEvent.keyboard('{Escape}')
    await userEvent.selectOptions(screen.getByLabelText('GitHub app'), SECOND)
    await userEvent.click(await repoBox())
    expect(within(await screen.findByRole('listbox')).getAllByRole('option').map((o) => o.textContent.replace(/private|public/, ''))).toEqual(['my-org/tools'])
    expect(api.called('GET', `/api/github/apps/${SECOND}/repos`)).toHaveLength(1)
  })

  test('the repository is checked through the chosen app, and that app\'s id is what is sent', async () => {
    const api = mockApi({ ...two, ...checks(), ...created })
    page()
    await userEvent.selectOptions(await select(), SECOND)
    await toDetails('my-org/tools')
    expect(api.called('GET', '/api/github/repo-check')[0].path).toContain(`app=${SECOND}`)
    await create()
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    expect(api.called('POST', '/api/apps')[0].body).toMatchObject({ repo: 'my-org/tools', github_app_id: SECOND })
  })

  test('None: a public repository is typed and checked anonymously (no app in the request), and null is sent', async () => {
    const api = mockApi({ ...two, ...checks({}, found({ via: 'anonymous', appChosen: false, private: false })), ...created })
    page()
    await userEvent.selectOptions(await select(), '')
    await userEvent.type(await screen.findByPlaceholderText(/owner\/repo/), 'someone/pub')
    await next()
    await next()
    await create()
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    expect(api.called('GET', '/api/github/repo-check')[0].path).not.toContain('app=')
    expect(api.called('POST', '/api/apps')[0].body.github_app_id).toBeNull()
    expect(api.called('GET', `/api/github/apps/${APP}/repos`)).toHaveLength(0)
  })

  test('with no GitHub app at all the repository is simply typed, and the wizard still works', async () => {
    const api = mockApi({ 'GET /api/github': { apps: [] }, ...checks({}, found({ via: 'anonymous', appChosen: false, private: false })), 'POST /api/apps': answer(201, { id: 'x', name: 'pub' }) })
    page()
    expect(await screen.findByText(/No GitHub app is connected, so only public repositories can be used/)).toBeInTheDocument()
    expect(screen.queryByLabelText('GitHub app')).toBeNull() // nothing to choose
    expect(screen.getByRole('link', { name: 'Connect a GitHub app' })).toHaveAttribute('href', '/github')
    await userEvent.type(await screen.findByPlaceholderText(/owner\/repo/), 'someone/pub')
    await next()
    await next()
    await userEvent.type(screen.getByLabelText('Host port'), '9400')
    await create()
    await waitFor(() => expect(api.called('POST', '/api/apps')).toHaveLength(1))
    expect(api.called('POST', '/api/apps')[0].body).toMatchObject({ repo: 'someone/pub', name: 'pub', host_port: 9400 })
    expect(api.called('POST', '/api/apps')[0].body).not.toHaveProperty('github_app_id') // there is none to name
    expect(api.called('GET', '/api/github/repo-check')[0].path).not.toContain('app=')
  })

  test('if the list of GitHub apps cannot be loaded, the wizard still works for a public repository', async () => {
    mockApi({ 'GET /api/github': answer(500, { error: 'boom' }), ...checks({}, found({ via: 'anonymous', appChosen: false })) })
    page()
    await userEvent.type(await screen.findByPlaceholderText(/owner\/repo/, {}, { timeout: 3000 }), 'someone/pub')
    await waitFor(() => expect(continueButton()).toBeEnabled(), { timeout: 4000 })
  })
})

describe('step 1: Shipdok checks it can see the repository', () => {
  test('nothing is asked until something is typed, and a name that is not owner/name is explained, not sent', async () => {
    const api = mockApi({ 'GET /api/github': { apps: [] }, ...checks() })
    page()
    const box = await screen.findByPlaceholderText(/owner\/repo/)
    await new Promise((r) => setTimeout(r, 600))
    expect(api.called('GET', '/api/github/repo-check')).toHaveLength(0)
    await userEvent.type(box, 'justaword')
    expect(await screen.findByText('Type the repository as owner/name, or paste its GitHub link.')).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 600))
    expect(api.called('GET', '/api/github/repo-check')).toHaveLength(0)
    expect(continueButton()).toBeDisabled()
  })

  test('says it is checking, then what it found, and lets you go on', async () => {
    let release
    mockApi({ ...connected, 'GET /api/github/repo-check': () => new Promise((r) => { release = () => r(found()) }) })
    page()
    await chooseRepo('tianyu-00/site')
    expect(await screen.findByText('Checking the repository…', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(continueButton()).toBeDisabled()
    await waitFor(() => expect(release).toBeTypeOf('function'), { timeout: 3000 })
    release()
    expect(await screen.findByText(/Found/)).toHaveTextContent('Found tianyu-00/site (private, default branch trunk).')
    expect(continueButton()).toBeEnabled()
  })

  test('asks about the repository once it has settled, not on every key', async () => {
    const api = mockApi({ 'GET /api/github': { apps: [] }, ...checks({}, found({ via: 'anonymous', appChosen: false })) })
    page()
    await userEvent.type(await screen.findByPlaceholderText(/owner\/repo/), 'someone/long-name')
    await waitFor(() => expect(api.called('GET', '/api/github/repo-check')).toHaveLength(1), { timeout: 3000 })
    expect(api.called('GET', '/api/github/repo-check')[0].path).toContain('repo=someone%2Flong-name')
  })

  test('a repository that cannot be seen, with no app chosen: says it may not exist or be private, and how to go on', async () => {
    mockApi({ 'GET /api/github': { apps: [] }, ...checks({}, { accessible: false, reason: 'not_found', appChosen: false }) })
    page()
    await userEvent.type(await screen.findByPlaceholderText(/owner\/repo/), 'someone/secret')
    const alert = await screen.findByRole('alert', {}, { timeout: 3000 })
    expect(alert).toHaveTextContent('Shipdok cannot see someone/secret. It may not exist, or it may be private.')
    expect(alert).toHaveTextContent('connect a GitHub app and install it on the repository')
    expect(alert).toHaveTextContent('remembered while you do that')
    expect(within(alert).getByRole('link', { name: 'Connect a GitHub app' })).toHaveAttribute('href', '/github')
    expect(continueButton()).toBeDisabled()
  })

  test('with apps connected but None chosen, it points at choosing an app that is installed on it', async () => {
    mockApi({ ...two, ...checks({}, { accessible: false, reason: 'not_found', appChosen: false }) })
    page()
    await userEvent.selectOptions(await screen.findByLabelText('GitHub app'), '')
    await userEvent.type(await screen.findByPlaceholderText(/owner\/repo/), 'someone/secret')
    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent('choose a GitHub app that is installed on it above, or connect another')
  })

  test('with an app chosen, it says the app is not installed on it, and offers to install it and to check again', async () => {
    const api = mockApi({ ...connected, ...checks({}, { accessible: false, reason: 'not_found', appChosen: true }) })
    page()
    await chooseRepo('tianyu-00/secret')
    const alert = await screen.findByRole('alert', {}, { timeout: 3000 })
    expect(alert).toHaveTextContent('Shipdok cannot see tianyu-00/secret through Shipdok-ab12 (tianyu-00)')
    expect(alert).toHaveTextContent('the app is not installed on it')
    const install = within(alert).getByRole('link', { name: /Install on repositories/ })
    expect(install).toHaveAttribute('href', 'https://github.com/apps/shipdok-ab12/installations/new')
    expect(install).toHaveAttribute('target', '_blank')
    await userEvent.click(within(alert).getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(api.called('GET', '/api/github/repo-check')).toHaveLength(2))
    expect(api.called('GET', '/api/github/repo-check')[0].path).not.toContain('fresh=1')
    expect(api.called('GET', '/api/github/repo-check')[1].path).toContain('fresh=1') // not the server's short memory
  })

  test('check again, after installing the app, lets you go on', async () => {
    let seen = false
    mockApi({ ...connected, 'GET /api/github/repo-check': () => { const ok = seen; seen = true; return ok ? found() : { accessible: false, reason: 'not_found', appChosen: true } } })
    page()
    await chooseRepo('tianyu-00/secret')
    await userEvent.click(await within(await screen.findByRole('alert', {}, { timeout: 3000 })).findByRole('button', { name: 'Check again' }))
    expect(await screen.findByText(/Found/)).toBeInTheDocument()
    expect(continueButton()).toBeEnabled()
  })

  test.each([
    ['rate_limited', /GitHub is limiting requests right now/],
    ['unreachable', /could not reach GitHub/],
  ])('%s is explained, with a way to try again', async (reason, text) => {
    mockApi({ ...connected, ...checks({}, { accessible: false, reason, appChosen: true }) })
    page()
    await chooseRepo('tianyu-00/site')
    const alert = await screen.findByRole('alert', {}, { timeout: 3000 })
    expect(alert).toHaveTextContent(text)
    expect(within(alert).getByRole('button', { name: 'Check again' })).toBeInTheDocument()
    expect(within(alert).queryByRole('link', { name: /Install/ })).toBeNull()
  })

  test('a failure of the check itself is shown, and does not let you go on', async () => {
    mockApi({ ...connected, 'GET /api/github/repo-check': answer(500, { error: 'boom' }) })
    page()
    await chooseRepo('tianyu-00/site')
    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent('Could not check the repository: boom')
    expect(continueButton()).toBeDisabled()
  })

  test('a public repository without an app: you are told pushes will not deploy it, and how to change that', async () => {
    mockApi({ 'GET /api/github': { apps: [] }, ...checks({}, found({ via: 'anonymous', appChosen: false, private: false })) })
    page()
    await userEvent.type(await screen.findByPlaceholderText(/owner\/repo/), 'someone/pub')
    expect(await screen.findByText(/This repository is public, so Shipdok can build it/, {}, { timeout: 3000 })).toHaveTextContent('pushes to it do not deploy it automatically: you press Deploy yourself')
    expect(screen.getAllByRole('link', { name: 'Connect a GitHub app' })).not.toHaveLength(0)
    expect(continueButton()).toBeEnabled()
  })

  test('a public repository with an app that is not installed on it: you are told, with the way to install it', async () => {
    mockApi({ ...connected, ...checks({}, found({ via: 'anonymous', appChosen: true, private: false })) })
    page()
    await chooseRepo('someone/pub')
    expect(await screen.findByText(/is not installed on this repository/, {}, { timeout: 3000 })).toHaveTextContent('Install the app on the repository to deploy on every push')
    expect(screen.getByRole('link', { name: /Install on repositories/ })).toHaveAttribute('href', 'https://github.com/apps/shipdok-ab12/installations/new')
    expect(continueButton()).toBeEnabled()
  })

  test('a repository seen through the app needs no warning at all', async () => {
    mockApi({ ...connected, ...checks() })
    page()
    await chooseRepo('tianyu-00/site')
    await screen.findByText(/Found/, {}, { timeout: 3000 })
    expect(screen.queryByText(/pushes/)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('picking a different repository starts the check again (and cannot go on with the old answer)', async () => {
    mockApi({ ...connected, ...checks({ 'tianyu-00/api': { accessible: false, reason: 'not_found', appChosen: true } }) })
    page()
    await chooseRepo('tianyu-00/site')
    await screen.findByText(/Found/, {}, { timeout: 3000 })
    await chooseRepo('tianyu-00/api')
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument(), { timeout: 3000 })
    expect(continueButton()).toBeDisabled()
  })
})

describe('step 1: no stale answers and no guessing', () => {
  test('the moment another repository is chosen, the old repository\'s answer no longer lets you go on', async () => {
    let release
    mockApi({ ...connected, 'GET /api/github/repo-check': (call) => (new URL(call.path, 'http://x').searchParams.get('repo') === 'tianyu-00/site' ? found() : new Promise((r) => { release = () => r(found({ fullName: 'tianyu-00/api' })) })) })
    page()
    await chooseRepo('tianyu-00/site')
    await waitFor(() => expect(continueButton()).toBeEnabled(), { timeout: 4000 })
    await chooseRepo('tianyu-00/api')
    // straight away, before the new repository has even been asked about
    expect(continueButton()).toBeDisabled()
    expect(screen.getByText('Checking the repository…')).toBeInTheDocument()
    expect(screen.queryByText(/Found/)).toBeNull()
    await waitFor(() => expect(release).toBeTypeOf('function'), { timeout: 3000 })
    release()
    await waitFor(() => expect(continueButton()).toBeEnabled(), { timeout: 3000 })
  })

  test('nothing is checked until the list of GitHub apps is known (so a guess is never acted on)', async () => {
    sessionStorage.setItem('shipdok.create-app', JSON.stringify({ repo: 'tianyu-00/site', githubApp: APP, at: Date.now() }))
    const api = mockApi({ ...connected, ...checks(), 'GET /api/github': () => new Promise((r) => setTimeout(() => r({ apps: [gh()] }), 800)) })
    page()
    await new Promise((r) => setTimeout(r, 600)) // longer than the wait before a repository is checked
    expect(api.called('GET', '/api/github/repo-check')).toHaveLength(0)
    await waitFor(() => expect(api.called('GET', '/api/github/repo-check')).toHaveLength(1), { timeout: 4000 })
    expect(api.called('GET', '/api/github/repo-check')[0].path).toContain(`app=${APP}`) // through the app that was chosen, not as a guess of "none"
  })
})

describe('step 1: what is remembered while you connect a GitHub app', () => {
  test('the repository and the app you chose are kept in this tab, and come back', async () => {
    mockApi({ ...two, ...checks() })
    const first = page()
    await userEvent.selectOptions(await screen.findByLabelText('GitHub app'), SECOND)
    await chooseRepo('my-org/tools')
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem('shipdok.create-app') ?? 'null')).toMatchObject({ repo: 'my-org/tools', githubApp: SECOND }))
    first.unmount()
    mockApi({ ...two, ...checks() })
    page() // (the person went to the GitHub page and came back)
    expect(await screen.findByLabelText('GitHub app')).toHaveValue(SECOND)
    expect(await screen.findByRole('combobox', { name: 'GitHub repository' })).toHaveTextContent('my-org/tools')
    await waitFor(() => expect(continueButton()).toBeEnabled(), { timeout: 4000 })
  })

  test('an app that has been removed meanwhile is not used', async () => {
    sessionStorage.setItem('shipdok.create-app', JSON.stringify({ repo: 'my-org/tools', githubApp: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', at: Date.now() }))
    mockApi({ ...two, ...checks() })
    page()
    expect(await screen.findByLabelText('GitHub app')).toHaveValue('__choose')
  })

  test('creating the app forgets it', async () => {
    mockApi({ ...connected, ...checks(), ...created })
    page()
    await toDetails('tianyu-00/site')
    expect(sessionStorage.getItem('shipdok.create-app')).not.toBeNull()
    await create()
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    expect(sessionStorage.getItem('shipdok.create-app')).toBeNull()
  })
})

describe('step 2: where the app is and how to build it', () => {
  test('Railpack is already chosen (the default), and says so; nothing is guessed from the repository', async () => {
    const api = mockApi({ ...connected, ...checks() })
    page()
    await toMethod('tianyu-00/site')
    expect(card('Railpack')).toHaveAttribute('aria-checked', 'true')
    expect(within(card('Railpack')).getByText('Default')).toBeInTheDocument()
    expect(card('Dockerfile')).toHaveAttribute('aria-checked', 'false')
    expect(continueButton()).toBeEnabled()
    // the repository's contents are never asked for: the only thing asked of GitHub about it is whether it can be seen
    expect(api.calls.filter((c) => c.path.startsWith('/api/github/') && !c.path.startsWith('/api/github/apps/') && c.bare !== '/api/github').map((c) => c.bare)).toEqual(['/api/github/repo-check'])
  })

  test('the folder starts as . and what is typed is the root directory that is sent', async () => {
    const api = mockApi({ ...connected, ...checks(), ...created })
    page()
    await toMethod('tianyu-00/site')
    const box = screen.getByLabelText('Where is the app inside the repository?')
    expect(box).toHaveValue('.')
    await userEvent.clear(box)
    await userEvent.type(box, 'backend')
    await next()
    expect(screen.getByText('Folder').nextSibling).toHaveTextContent('backend')
    expect(screen.queryByLabelText('Root directory')).toBeNull() // (it was chosen in the step before)
    await create()
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    expect(api.called('POST', '/api/apps')[0].body).toMatchObject({ root_dir: 'backend' })
  })

  test('the folder is explained for a repository with several apps', async () => {
    mockApi({ ...connected, ...checks() })
    page()
    await toMethod('tianyu-00/site')
    expect(screen.getByText(/If the repository holds several apps in folders, type the folder of this one/)).toBeInTheDocument()
  })

  test('choosing the Dockerfile instead is what is sent', async () => {
    const api = mockApi({ ...connected, ...checks(), ...created })
    page()
    await toMethod('tianyu-00/site')
    await userEvent.click(card('Dockerfile'))
    expect(card('Dockerfile')).toHaveAttribute('aria-checked', 'true')
    expect(card('Railpack')).toHaveAttribute('aria-checked', 'false')
    await next()
    await create()
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    expect(api.called('POST', '/api/apps')[0].body.build_method).toBe('dockerfile')
  })

  test('Nixpacks and Static site are on the list as coming soon, and cannot be chosen', async () => {
    mockApi({ ...connected, ...checks() })
    page()
    await toMethod('tianyu-00/site')
    for (const name of ['Nixpacks', 'Static site']) {
      expect(card(name)).toBeDisabled()
      expect(within(card(name)).getByText('Coming soon')).toBeInTheDocument()
      await userEvent.click(card(name))
      expect(card(name)).toHaveAttribute('aria-checked', 'false')
    }
    expect(card('Railpack')).toHaveAttribute('aria-checked', 'true') // (still)
    expect(card('Dockerfile')).toBeEnabled()
  })

  test('each card says in a line what the method is', async () => {
    mockApi({ ...connected, ...checks() })
    page()
    await toMethod('tianyu-00/site')
    expect(card('Dockerfile')).toHaveTextContent('Builds the Dockerfile in your repository')
    expect(card('Railpack')).toHaveTextContent('No Dockerfile needed')
  })

  test('Change and Back return to the repository', async () => {
    mockApi({ ...connected, ...checks() })
    page()
    await toMethod('tianyu-00/site')
    await userEvent.click(screen.getByRole('button', { name: 'Change' }))
    expect(screen.getByText('Step 1 of 3: Repository')).toBeInTheDocument()
    await next()
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByText('Step 1 of 3: Repository')).toBeInTheDocument()
  })

  test('choosing another repository starts the folder over but keeps the method chosen', async () => {
    mockApi({ ...connected, ...checks() })
    page()
    await toMethod('tianyu-00/site')
    await userEvent.clear(screen.getByLabelText('Where is the app inside the repository?'))
    await userEvent.type(screen.getByLabelText('Where is the app inside the repository?'), 'old')
    await userEvent.click(card('Dockerfile'))
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    await chooseRepo('tianyu-00/api')
    await next()
    expect(screen.getByLabelText('Where is the app inside the repository?')).toHaveValue('.')
    expect(card('Dockerfile')).toHaveAttribute('aria-checked', 'true')
  })
})

describe('step 3: creating an app', () => {
  test('shows what was chosen, and each can be changed', async () => {
    mockApi({ ...connected, ...checks() })
    page()
    await toDetails('tianyu-00/site')
    const summary = screen.getByText('Repository').closest('dl')
    expect(within(summary).getByText('tianyu-00/site')).toBeInTheDocument()
    expect(within(summary).getByText('Railpack')).toBeInTheDocument()
    await userEvent.click(within(summary).getAllByRole('button', { name: 'Change' })[1])
    expect(screen.getByText('Step 2 of 3: Build method')).toBeInTheDocument()
    await next()
    await userEvent.click(within(screen.getByText('Repository').closest('dl')).getAllByRole('button', { name: 'Change' })[0])
    expect(screen.getByText('Step 1 of 3: Repository')).toBeInTheDocument()
  })

  test('sends exactly what was entered, as numbers where they are numbers, and opens the new app', async () => {
    const api = mockApi({ ...connected, ...checks(), 'POST /api/apps': answer(201, { id: 'new-id', name: 'site' }) })
    page()
    await toDetails('tianyu-00/site')
    await userEvent.type(screen.getByLabelText('Host port'), '9301')
    await userEvent.type(screen.getByLabelText('Health check path'), '/health')
    await create()
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    expect(api.called('POST', '/api/apps')[0].body).toEqual({
      name: 'site', repo: 'tianyu-00/site', branch: 'trunk', root_dir: '.', container_port: 3000, host_port: 9301, health_path: '/health',
      memory_mb: 512, cpus: 1, max_restarts: 5, keep_previous_images: 1, auto_prune: true, build_method: 'railpack', github_app_id: APP,
    })
  })

  test('a Dockerfile app has no commands to fill in', async () => {
    mockApi({ ...connected, ...checks() })
    page()
    await toMethod('tianyu-00/site')
    await userEvent.click(card('Dockerfile'))
    await next()
    expect(screen.queryByLabelText('Install command')).toBeNull()
    expect(screen.queryByLabelText('Build method')).toBeNull() // (chosen in the step before)
  })

  test('a Railpack app (the default) shows its three commands, each optional', async () => {
    mockApi({ ...connected, ...checks() })
    page()
    await toDetails('tianyu-00/site')
    for (const label of ['Install command', 'Build command', 'Start command']) expect(screen.getByLabelText(label)).toHaveValue('')
    expect(screen.getByText(/every build variable is passed as a build secret/i)).toBeInTheDocument()
  })

  test('Railpack is sent with the commands that were filled in (trimmed), and none that were left empty', async () => {
    const api = mockApi({ ...connected, ...checks(), 'POST /api/apps': answer(201, { id: 'new-id', name: 'site' }) })
    page()
    await toDetails('tianyu-00/site')
    await userEvent.type(screen.getByLabelText('Build command'), '  npm run build  ')
    await userEvent.type(screen.getByLabelText('Start command'), 'node dist/server.js')
    await create()
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    const body = api.called('POST', '/api/apps')[0].body
    expect(body).toMatchObject({ build_method: 'railpack', build_command: 'npm run build', start_command: 'node dist/server.js' })
    expect('install_command' in body).toBe(false)
  })

  test('commands typed and then abandoned by going back and choosing the Dockerfile are not sent', async () => {
    const api = mockApi({ ...connected, ...checks(), 'POST /api/apps': answer(201, { id: 'new-id', name: 'site' }) })
    page()
    await toDetails('tianyu-00/site')
    await userEvent.type(screen.getByLabelText('Install command'), 'npm ci')
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    await userEvent.click(card('Dockerfile'))
    await next()
    await create()
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    const body = api.called('POST', '/api/apps')[0].body
    expect(body.build_method).toBe('dockerfile')
    expect('install_command' in body).toBe(false)
  })

  test('after creating, the toast says the app is not deployed yet and to press Deploy', async () => {
    mockApi({ ...connected, ...checks(), 'POST /api/apps': answer(201, { id: 'new-id', name: 'site' }) })
    page()
    await toDetails('tianyu-00/site')
    await create()
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    expect(toasts.success).toHaveBeenCalledWith('site created', { description: 'It is not deployed yet: press Deploy when you are ready.' })
  })

  test('the build time limit: empty means none (not sent), a number is sent', async () => {
    const api = mockApi({ ...connected, ...checks(), 'POST /api/apps': answer(201, { id: 'new-id', name: 'site' }) })
    page()
    await toDetails('tianyu-00/site')
    expect(screen.getByLabelText('Build time limit (minutes)')).toHaveValue('')
    expect(screen.getByText(/leave empty for no limit/i)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Build time limit (minutes)'), '45')
    await create()
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    expect(api.called('POST', '/api/apps')[0].body.build_timeout_minutes).toBe(45)
  })

  test('a host port left empty is not sent, so the server picks one', async () => {
    const api = mockApi({ ...connected, ...checks(), 'POST /api/apps': answer(201, { id: 'new-id', name: 'site' }) })
    page()
    await toDetails('tianyu-00/site')
    expect(screen.getByLabelText('Host port')).toHaveAttribute('placeholder', 'automatic')
    await create()
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    expect(api.called('POST', '/api/apps')[0].body).not.toHaveProperty('host_port')
  })

  test('a full port range is explained', async () => {
    mockApi({ ...connected, ...checks(), 'POST /api/apps': answer(409, { error: 'Every port from 20000 to 20999 is taken. Choose a host port yourself, or widen PORT_RANGE.', code: 'no_free_port' }) })
    page()
    await toDetails('tianyu-00/site')
    await create()
    expect(await screen.findByRole('alert')).toHaveTextContent(/Every port from 20000 to 20999 is taken/)
  })

  test('picking a repository fills in the name and the repository\'s own default branch', async () => {
    mockApi({ ...connected, ...checks() })
    page()
    await userEvent.click(await repoBox())
    const list = await screen.findByRole('listbox')
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['tianyu-00/apipublic', 'tianyu-00/siteprivate']) // alphabetical, each marked
    await userEvent.click(within(list).getByText('tianyu-00/site'))
    await next()
    await next()
    expect(screen.getByLabelText('Name')).toHaveValue('site')
    expect(screen.getByLabelText('Branch')).toHaveValue('trunk')
  })

  test('a name typed by hand is not overwritten when the repository is changed', async () => {
    mockApi({ ...connected, ...checks() })
    page()
    await toDetails('tianyu-00/site')
    await userEvent.clear(screen.getByLabelText('Name'))
    await userEvent.type(screen.getByLabelText('Name'), 'Mine')
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    await chooseRepo('tianyu-00/api')
    await next()
    await next()
    expect(screen.getByLabelText('Name')).toHaveValue('Mine')
  })

  test('the server\'s reasons are shown next to the form and nothing navigates away', async () => {
    mockApi({ ...connected, ...checks(), 'POST /api/apps': answer(400, { error: 'Invalid app settings', details: ['host_port: Too small: expected number to be >=1024'] }) })
    page()
    await toDetails('a/b')
    await userEvent.type(screen.getByLabelText('Host port'), '80')
    await create()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Invalid app settings')
    expect(alert).toHaveTextContent('host_port')
    expect(screen.queryByText('detail page')).toBeNull()
  })

  test('a taken port or name is shown as the server says it', async () => {
    mockApi({ ...connected, ...checks(), 'POST /api/apps': answer(409, { error: 'That host port is already assigned to another app' }) })
    page()
    await toDetails('a/b')
    await userEvent.type(screen.getByLabelText('Host port'), '8080')
    await create()
    expect(await screen.findByRole('alert')).toHaveTextContent('already assigned')
  })

  test('a warning from the server (the GitHub App is not installed on the repository) is shown but does not stop you', async () => {
    mockApi({ ...connected, ...checks(), 'POST /api/apps': answer(201, { id: 'x', name: 'site', warning: 'The Shipdok GitHub App is not installed on this repository.' }) })
    page()
    await toDetails('a/b')
    await create()
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    expect(toasts.warning).toHaveBeenCalledWith(expect.stringMatching(/not installed/), expect.anything())
  })

  test('the clean-up choices are sent', async () => {
    const api = mockApi({ ...connected, ...checks(), 'POST /api/apps': answer(201, { id: 'x', name: 'n' }) })
    page()
    await toDetails('a/b')
    await userEvent.click(screen.getByText('Limits and clean-up'))
    await userEvent.clear(screen.getByLabelText('Earlier versions kept'))
    await userEvent.type(screen.getByLabelText('Earlier versions kept'), '3')
    await userEvent.click(screen.getByRole('switch'))
    await create()
    await waitFor(() => expect(api.called('POST', '/api/apps')).toHaveLength(1))
    expect(api.called('POST', '/api/apps')[0].body).toMatchObject({ keep_previous_images: 3, auto_prune: false })
  })

  test('automatic clean-up starts switched on, and says what it does', async () => {
    mockApi({ ...connected, ...checks() })
    page()
    await toDetails('a/b')
    await userEvent.click(screen.getByText('Limits and clean-up'))
    expect(screen.getByRole('switch')).toBeChecked()
    expect(screen.getByText('Remove old images automatically after each deployment')).toBeInTheDocument()
  })

  test('the button is disabled while the request is running, so it cannot be sent twice', async () => {
    let release
    const api = mockApi({ ...connected, ...checks(), 'POST /api/apps': () => new Promise((r) => { release = () => r({ id: 'x', name: 'n' }) }) })
    page()
    await toDetails('a/b')
    await create()
    expect(await screen.findByRole('button', { name: 'Creating…' })).toBeDisabled()
    expect(api.called('POST', '/api/apps')).toHaveLength(1)
    release()
  })
})

describe('the branch', () => {
  const branches = (repo, defaultBranch, list) => ({ [`GET /api/github/branches?repo=${encodeURIComponent(repo)}&app=${APP}`]: { defaultBranch, branches: list, truncated: false } })

  test('the form starts on the repository\'s default branch, which the check already knew, even for a typed repository the app list does not know', async () => {
    const api = mockApi({ ...connected, ...checks({}, found({ defaultBranch: 'develop' })), 'POST /api/apps': answer(201, { id: 'new-id', name: 'else' }) })
    page()
    await toDetails('someone/else')
    expect(screen.getByLabelText('Branch')).toHaveValue('develop')
    await create()
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    expect(api.called('POST', '/api/apps')[0].body.branch).toBe('develop')
  })

  test('a branch picked from the list is the one sent', async () => {
    const api = mockApi({ ...connected, ...checks(), ...branches('someone/else', 'main', ['main', 'staging']), 'POST /api/apps': answer(201, { id: 'new-id', name: 'else' }) })
    page()
    await toDetails('someone/else')
    await userEvent.click(await screen.findByRole('combobox', { name: 'Branch' }, { timeout: 3000 }))
    await userEvent.click(within(await screen.findByRole('listbox')).getByText('staging'))
    expect(screen.getByRole('combobox', { name: 'Branch' })).toHaveTextContent('staging')
    await create()
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    expect(api.called('POST', '/api/apps')[0].body.branch).toBe('staging')
  })

  test('when the branches cannot be listed the branch is typed, and what is typed is sent', async () => {
    const api = mockApi({ ...connected, ...checks(), [`GET /api/github/branches?repo=someone%2Fprivate&app=${APP}`]: answer(404, { error: 'This repository is private and the app is not installed on it.', code: 'repo_not_found' }), 'POST /api/apps': answer(201, { id: 'new-id', name: 'private' }) })
    page()
    await toDetails('someone/private')
    expect(await screen.findByText(/Type the branch name\./, {}, { timeout: 3000 })).toBeInTheDocument()
    const branch = screen.getByLabelText('Branch')
    await userEvent.clear(branch)
    await userEvent.type(branch, 'release-2')
    await create()
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    expect(api.called('POST', '/api/apps')[0].body.branch).toBe('release-2')
  })
})

describe('pasting a GitHub link', () => {
  describe('into the repository list (a GitHub App is connected)', () => {
    const search = () => screen.getByLabelText('Search repositories')
    const open = async () => { await userEvent.click(await repoBox()) }

    test('a link finds the repository it points at, and Enter takes it', async () => {
      mockApi({ ...connected, ...checks() })
      page()
      await open()
      await userEvent.click(search())
      await userEvent.paste('https://github.com/tianyu-00/site')
      expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual(['tianyu-00/siteprivate'])
      await userEvent.keyboard('{Enter}')
      expect(screen.getByRole('combobox', { name: 'GitHub repository' })).toHaveTextContent('tianyu-00/site')
      await next()
      await next()
      expect(screen.getByLabelText('Name')).toHaveValue('site')
    })

    test('a link to a repository the app cannot see is offered as "Use owner/name", and owner/name (never the link) is what is sent', async () => {
      const api = mockApi({ ...connected, ...checks(), ...created })
      page()
      await open()
      await userEvent.click(search())
      await userEvent.paste('https://github.com/someone/else.git')
      expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Use “someone/else”'])
      await userEvent.keyboard('{Enter}')
      await next()
      await next()
      await create()
      expect(await screen.findByText('detail page')).toBeInTheDocument()
      expect(api.called('POST', '/api/apps')[0].body.repo).toBe('someone/else')
      expect(api.called('GET', '/api/github/repo-check')[0].path).toContain('repo=someone%2Felse')
    })

    test.each([
      ['https://github.com/o/r/tree/develop/src', 'o/r'],
      ['github.com/o/r/', 'o/r'],
      ['git@github.com:o/r.git', 'o/r'],
    ])('%s is understood too', async (link, expected) => {
      mockApi({ ...connected })
      page()
      await open()
      await userEvent.click(search())
      await userEvent.paste(link)
      expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual([`Use “${expected}”`])
    })

    test('a link to another site offers nothing to use', async () => {
      mockApi({ ...connected })
      page()
      await open()
      await userEvent.click(search())
      await userEvent.paste('https://gitlab.com/o/r')
      expect(within(screen.getByRole('listbox')).getByText('No repository matches.')).toBeInTheDocument()
    })
  })

  describe('into a plain text box (no GitHub App)', () => {
    const noApp = { 'GET /api/github': { apps: [] }, ...checks({}, found({ via: 'anonymous', appChosen: false })) }
    const field = async () => screen.findByPlaceholderText(/owner\/repo/)

    test('a pasted link becomes owner/name at once, and is what is checked', async () => {
      const api = mockApi(noApp)
      page()
      await userEvent.click(await field())
      await userEvent.paste('https://github.com/tianyu-00/site')
      expect(await field()).toHaveValue('tianyu-00/site')
      await waitFor(() => expect(api.called('GET', '/api/github/repo-check')).toHaveLength(1), { timeout: 3000 })
      expect(api.called('GET', '/api/github/repo-check')[0].path).toContain('repo=tianyu-00%2Fsite')
    })

    test('what is sent is owner/name, never the link', async () => {
      const api = mockApi({ ...noApp, ...created })
      page()
      await userEvent.click(await field())
      await userEvent.paste('https://github.com/tianyu-00/site.git')
      await next()
      await next()
      await create()
      expect(await screen.findByText('detail page')).toBeInTheDocument()
      expect(api.called('POST', '/api/apps')[0].body.repo).toBe('tianyu-00/site')
    })

    test('a link typed one key at a time is left alone while typing, and becomes owner/name when the field is left', async () => {
      mockApi(noApp)
      page()
      const box = await field()
      await userEvent.type(box, 'https://github.com/tianyu-00/site')
      expect(box).toHaveValue('https://github.com/tianyu-00/site')
      await userEvent.tab()
      expect(await field()).toHaveValue('tianyu-00/site')
    })
  })
})
