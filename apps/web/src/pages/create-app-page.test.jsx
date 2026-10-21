import { describe, test, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Routes, Route } from 'react-router-dom'
import CreateAppPage from './create-app-page'
import { mockApi, answer, renderWithProviders } from '@/test/utils'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts, Toaster: () => null }))
beforeEach(() => vi.clearAllMocks())

// With a GitHub App connected the repository is chosen from a searchable list: open it, search, and take the first match (or "Use ...").
const repoBox = () => screen.findByRole('combobox', { name: 'GitHub repository' })
const chooseRepo = async (text) => {
  await userEvent.click(await repoBox())
  await userEvent.type(screen.getByLabelText('Search repositories'), text)
  await userEvent.keyboard('{Enter}')
}
const page = () => renderWithProviders(<Routes><Route path="/apps/new" element={<CreateAppPage />} /><Route path="/apps/:id" element={<p>detail page</p>} /></Routes>, { route: '/apps/new' })
const repos = { repos: [{ fullName: 'tianyu-00/site', private: true, defaultBranch: 'trunk' }, { fullName: 'tianyu-00/api', private: false, defaultBranch: 'main' }] }
// One GitHub app is connected: the form starts with it, so nothing has to be chosen and the repositories are its own.
const APP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const gh = (over = {}) => ({ id: APP, appId: '1', name: 'Shipdok-ab12', ownerLogin: 'tianyu-00', slug: 's', projects: [], problem: null, ...over })
const connected = { 'GET /api/github': { apps: [gh()] }, [`GET /api/github/apps/${APP}/repos`]: repos }

describe('which GitHub app', () => {
  const SECOND = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const two = {
    'GET /api/github': { apps: [gh(), gh({ id: SECOND, appId: '2', name: 'Shipdok-cd34', ownerLogin: 'my-org' })] },
    [`GET /api/github/apps/${APP}/repos`]: repos,
    [`GET /api/github/apps/${SECOND}/repos`]: { repos: [{ fullName: 'my-org/tools', private: true, defaultBranch: 'main' }] },
  }
  const created = { 'POST /api/apps': answer(201, { id: 'new-id', name: 'x' }) }
  const select = () => screen.findByLabelText('GitHub app')

  test('with exactly one connected, it is already chosen: the repositories load and it is sent', async () => {
    const api = mockApi({ ...connected, ...created })
    page()
    expect(await select()).toHaveValue(APP)
    await chooseRepo('tianyu-00/site')
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    expect(api.called('POST', '/api/apps')[0].body.github_app_id).toBe(APP)
    expect(api.called('GET', `/api/github/apps/${APP}/repos`)).toHaveLength(1)
  })

  test('with several, none is chosen for you: the form cannot be sent until one is (or None)', async () => {
    mockApi({ ...two, ...created })
    page()
    const box = await select()
    expect(box).toHaveValue('__choose')
    expect(screen.getByRole('button', { name: 'Create app' })).toBeDisabled()
    const names = within(box).getAllByRole('option').map((o) => o.textContent)
    expect(names).toEqual(['Choose a GitHub app…', 'Shipdok-ab12 (tianyu-00)', 'Shipdok-cd34 (my-org)', 'None (a public repository, deployed by hand)'])
    await userEvent.selectOptions(box, SECOND)
    expect(screen.getByRole('button', { name: 'Create app' })).toBeEnabled()
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

  test('the second app\'s id is what is sent', async () => {
    const api = mockApi({ ...two, ...created })
    page()
    await userEvent.selectOptions(await select(), SECOND)
    await chooseRepo('my-org/tools')
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    expect(api.called('POST', '/api/apps')[0].body).toMatchObject({ repo: 'my-org/tools', github_app_id: SECOND })
  })

  test('None: the repository is a plain box (a public one), and null is sent', async () => {
    const api = mockApi({ ...two, ...created })
    page()
    await userEvent.selectOptions(await select(), '')
    await userEvent.type(await screen.findByPlaceholderText(/owner\/repo/), 'someone/pub')
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    expect(api.called('POST', '/api/apps')[0].body.github_app_id).toBeNull()
    expect(api.called('GET', `/api/github/apps/${APP}/repos`)).toHaveLength(0)
  })

  test('the branches of a repository are read through the chosen app', async () => {
    const api = mockApi({ ...two, [`GET /api/github/branches?repo=my-org%2Ftools&app=${SECOND}`]: { defaultBranch: 'develop', branches: ['develop', 'main'], truncated: false } })
    page()
    await userEvent.selectOptions(await select(), SECOND)
    await chooseRepo('my-org/tools')
    await waitFor(() => expect(api.called('GET', '/api/github/branches')).toHaveLength(1))
    expect(api.called('GET', '/api/github/branches')[0].path).toContain(`app=${SECOND}`)
  })

  test('a public repository with None is read anonymously: no app in the branch request', async () => {
    const api = mockApi({ ...two, 'GET /api/github/branches?repo=someone%2Fpub': { defaultBranch: 'main', branches: ['main'], truncated: false } })
    page()
    await userEvent.selectOptions(await select(), '')
    await userEvent.type(await screen.findByPlaceholderText(/owner\/repo/), 'someone/pub')
    await waitFor(() => expect(api.called('GET', '/api/github/branches')).toHaveLength(1))
    expect(api.called('GET', '/api/github/branches')[0].path).not.toContain('app=')
  })

  test('a warning about the installation is shown, as before', async () => {
    mockApi({ ...connected, 'POST /api/apps': answer(201, { id: 'x', name: 'site', warning: 'The chosen GitHub app is not installed on this repository.' }) })
    page()
    await chooseRepo('tianyu-00/site')
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    await waitFor(() => expect(toasts.warning).toHaveBeenCalledWith(expect.stringMatching(/not installed/), expect.anything()))
  })
})

describe('creating an app', () => {
  test('sends exactly what was entered, as numbers where they are numbers, and opens the new app', async () => {
    const api = mockApi({ ...connected, 'POST /api/apps': answer(201, { id: 'new-id', name: 'site' }) })
    page()
    await chooseRepo('tianyu-00/site')
    await userEvent.type(screen.getByLabelText('Host port'), '9301')
    await userEvent.type(screen.getByLabelText('Health check path'), '/health')
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    expect(api.called('POST', '/api/apps')[0].body).toEqual({
      name: 'site', repo: 'tianyu-00/site', branch: 'trunk', root_dir: '.', container_port: 3000, host_port: 9301, health_path: '/health',
      memory_mb: 512, cpus: 1, max_restarts: 5, keep_previous_images: 1, auto_prune: false, build_method: 'dockerfile', github_app_id: APP,
    })
  })

  test('the Dockerfile is the default way to build, and then there are no commands to fill in', async () => {
    mockApi({ ...connected })
    page()
    await chooseRepo('tianyu-00/site')
    expect(screen.getByLabelText('Build method')).toHaveValue('dockerfile')
    expect(screen.queryByLabelText('Install command')).toBeNull()
    expect(screen.getByText('Where the Dockerfile is, inside the repository.')).toBeInTheDocument()
  })

  test('choosing Railpack shows the three commands (each optional) and stops talking about a Dockerfile', async () => {
    mockApi({ ...connected })
    page()
    await chooseRepo('tianyu-00/site')
    await userEvent.selectOptions(screen.getByLabelText('Build method'), 'railpack')
    for (const label of ['Install command', 'Build command', 'Start command']) expect(screen.getByLabelText(label)).toHaveValue('')
    expect(screen.getByText('The folder of the app inside the repository.')).toBeInTheDocument()
    expect(screen.queryByText('Where the Dockerfile is, inside the repository.')).toBeNull()
    expect(screen.getByText(/every build variable is passed as a build secret/i)).toBeInTheDocument()
  })

  test('Railpack is sent with the commands that were filled in (trimmed), and none that were left empty', async () => {
    const api = mockApi({ ...connected, 'POST /api/apps': answer(201, { id: 'new-id', name: 'site' }) })
    page()
    await chooseRepo('tianyu-00/site')
    await userEvent.selectOptions(screen.getByLabelText('Build method'), 'railpack')
    await userEvent.type(screen.getByLabelText('Build command'), '  npm run build  ')
    await userEvent.type(screen.getByLabelText('Start command'), 'node dist/server.js')
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    const body = api.called('POST', '/api/apps')[0].body
    expect(body).toMatchObject({ build_method: 'railpack', build_command: 'npm run build', start_command: 'node dist/server.js' })
    expect('install_command' in body).toBe(false)
  })

  test('commands typed and then abandoned by going back to the Dockerfile are not sent', async () => {
    const api = mockApi({ ...connected, 'POST /api/apps': answer(201, { id: 'new-id', name: 'site' }) })
    page()
    await chooseRepo('tianyu-00/site')
    await userEvent.selectOptions(screen.getByLabelText('Build method'), 'railpack')
    await userEvent.type(screen.getByLabelText('Install command'), 'npm ci')
    await userEvent.selectOptions(screen.getByLabelText('Build method'), 'dockerfile')
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    const body = api.called('POST', '/api/apps')[0].body
    expect(body.build_method).toBe('dockerfile')
    expect('install_command' in body).toBe(false)
  })

  test('the build time limit: empty means none (not sent), a number is sent', async () => {
    const api = mockApi({ ...connected, 'POST /api/apps': answer(201, { id: 'new-id', name: 'site' }) })
    page()
    await chooseRepo('tianyu-00/site')
    expect(screen.getByLabelText('Build time limit (minutes)')).toHaveValue('')
    expect(screen.getByText(/leave empty for no limit/i)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Build time limit (minutes)'), '45')
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    expect(api.called('POST', '/api/apps')[0].body.build_timeout_minutes).toBe(45)
  })

  test('a host port left empty is not sent, so the server picks one', async () => {
    const api = mockApi({ ...connected, 'POST /api/apps': answer(201, { id: 'new-id', name: 'site' }) })
    page()
    await chooseRepo('tianyu-00/site')
    expect(screen.getByLabelText('Host port')).toHaveAttribute('placeholder', 'automatic')
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    expect(api.called('POST', '/api/apps')[0].body).not.toHaveProperty('host_port')
  })

  test('a full port range is explained', async () => {
    mockApi({ ...connected, 'POST /api/apps': answer(409, { error: 'Every port from 20000 to 20999 is taken. Choose a host port yourself, or widen PORT_RANGE.', code: 'no_free_port' }) })
    page()
    await chooseRepo('tianyu-00/site')
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Every port from 20000 to 20999 is taken/)
  })

  test('picking a repository fills in the name and the repository\'s own default branch, unless the name was typed by hand', async () => {
    mockApi({ ...connected })
    page()
    await userEvent.click(await repoBox())
    const list = await screen.findByRole('listbox')
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['tianyu-00/apipublic', 'tianyu-00/siteprivate']) // alphabetical, each marked
    await userEvent.click(within(list).getByText('tianyu-00/site'))
    expect(screen.getByLabelText('Name')).toHaveValue('site')
    expect(screen.getByLabelText('Branch')).toHaveValue('trunk')
  })

  test('a name typed by hand is not overwritten', async () => {
    mockApi({ ...connected })
    page()
    await userEvent.type(screen.getByLabelText('Name'), 'Mine')
    await chooseRepo('tianyu-00/site')
    expect(screen.getByLabelText('Name')).toHaveValue('Mine')
  })

  test('without a GitHub app the repository is simply typed, and the form still works', async () => {
    const api = mockApi({ 'GET /api/github': { apps: [] }, 'POST /api/apps': answer(201, { id: 'x', name: 'pub' }) })
    page()
    expect(await screen.findByText(/private repositories need a github app/i)).toBeInTheDocument()
    expect(screen.queryByLabelText('GitHub app')).toBeNull() // nothing to choose
    await userEvent.type(await screen.findByPlaceholderText(/owner\/repo/), 'someone/pub') // no list to choose from: a text box
    await userEvent.type(screen.getByLabelText('Host port'), '9400')
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    await waitFor(() => expect(api.called('POST', '/api/apps')).toHaveLength(1))
    expect(api.called('POST', '/api/apps')[0].body).toMatchObject({ repo: 'someone/pub', name: 'pub', branch: 'main', host_port: 9400 })
    expect(api.called('POST', '/api/apps')[0].body).not.toHaveProperty('github_app_id') // there is none to name
  })

  test('the server\'s reasons are shown next to the form and nothing navigates away', async () => {
    mockApi({
      ...connected,
      'POST /api/apps': answer(400, { error: 'Invalid app settings', details: ['host_port: Too small: expected number to be >=1024'] }),
    })
    page()
    await chooseRepo('a/b')
    await userEvent.type(screen.getByLabelText('Host port'), '80')
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Invalid app settings')
    expect(alert).toHaveTextContent('host_port')
    expect(screen.queryByText('detail page')).toBeNull()
  })

  test('a taken port or name is shown as the server says it', async () => {
    mockApi({ ...connected, 'POST /api/apps': answer(409, { error: 'That host port is already assigned to another app' }) })
    page()
    await chooseRepo('a/b')
    await userEvent.type(screen.getByLabelText('Host port'), '8080')
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already assigned')
  })

  test('a warning from the server (the GitHub App is not installed on the repository) is shown but does not stop you', async () => {
    mockApi({ ...connected, 'POST /api/apps': answer(201, { id: 'x', name: 'site', warning: 'The Shipdok GitHub App is not installed on this repository.' }) })
    page()
    await chooseRepo('a/b')
    await userEvent.type(screen.getByLabelText('Host port'), '9000')
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    expect(toasts.warning).toHaveBeenCalledWith(expect.stringMatching(/not installed/), expect.anything())
  })

  test('the clean-up choices are sent', async () => {
    const api = mockApi({ ...connected, 'POST /api/apps': answer(201, { id: 'x', name: 'n' }) })
    page()
    await chooseRepo('a/b')
    await userEvent.type(screen.getByLabelText('Host port'), '9000')
    await userEvent.click(screen.getByText('Limits and clean-up'))
    await userEvent.clear(screen.getByLabelText('Earlier versions kept'))
    await userEvent.type(screen.getByLabelText('Earlier versions kept'), '3')
    await userEvent.click(screen.getByRole('switch'))
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    await waitFor(() => expect(api.called('POST', '/api/apps')).toHaveLength(1))
    expect(api.called('POST', '/api/apps')[0].body).toMatchObject({ keep_previous_images: 3, auto_prune: true })
  })

  test('the button is disabled while the request is running, so it cannot be sent twice', async () => {
    let release
    const api = mockApi({ ...connected, 'POST /api/apps': () => new Promise((r) => { release = () => r({ id: 'x', name: 'n' }) }) })
    page()
    await chooseRepo('a/b')
    await userEvent.type(screen.getByLabelText('Host port'), '9000')
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    expect(await screen.findByRole('button', { name: 'Creating…' })).toBeDisabled()
    expect(api.called('POST', '/api/apps')).toHaveLength(1)
    release()
  })
})

describe('the branch', () => {
  const branches = (repo, defaultBranch, list) => ({ [`GET /api/github/branches?repo=${encodeURIComponent(repo)}&app=${APP}`]: { defaultBranch, branches: list, truncated: false } })
  const create = async () => { await userEvent.click(screen.getByRole('button', { name: 'Create app' })); await screen.findByText('detail page') }

  test('once the repository\'s branches are known the form starts on its default branch, even for a typed repository the app list does not know', async () => {
    const api = mockApi({ ...connected, ...branches('someone/else', 'develop', ['develop', 'main']), 'POST /api/apps': answer(201, { id: 'new-id', name: 'else' }) })
    page()
    await chooseRepo('someone/else')
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Branch' })).toHaveTextContent('develop'), { timeout: 3000 })
    await create()
    expect(api.called('POST', '/api/apps')[0].body.branch).toBe('develop')
  })

  test('a branch picked from the list is the one sent', async () => {
    const api = mockApi({ ...connected, ...branches('someone/else', 'main', ['main', 'staging']), 'POST /api/apps': answer(201, { id: 'new-id', name: 'else' }) })
    page()
    await chooseRepo('someone/else')
    await userEvent.click(await screen.findByRole('combobox', { name: 'Branch' }, { timeout: 3000 }))
    await userEvent.click(within(await screen.findByRole('listbox')).getByText('staging'))
    expect(screen.getByRole('combobox', { name: 'Branch' })).toHaveTextContent('staging')
    await create()
    expect(api.called('POST', '/api/apps')[0].body.branch).toBe('staging')
  })

  test('a branch chosen by hand is kept when the same repository\'s list is read again, but a different repository starts from its own default', async () => {
    mockApi({ ...connected, ...branches('a/one', 'main', ['main', 'dev']), ...branches('b/two', 'trunk', ['trunk', 'x']) })
    page()
    await chooseRepo('a/one')
    await userEvent.click(await screen.findByRole('combobox', { name: 'Branch' }, { timeout: 3000 }))
    await userEvent.click(within(await screen.findByRole('listbox')).getByText('dev'))
    expect(screen.getByRole('combobox', { name: 'Branch' })).toHaveTextContent('dev')
    await chooseRepo('b/two')
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Branch' })).toHaveTextContent('trunk'), { timeout: 3000 })
  })

  test('when the branches cannot be listed the branch is typed, and what is typed is sent', async () => {
    const api = mockApi({ ...connected, [`GET /api/github/branches?repo=someone%2Fprivate&app=${APP}`]: answer(404, { error: 'This repository is private and the app is not installed on it.', code: 'repo_not_found' }), 'POST /api/apps': answer(201, { id: 'new-id', name: 'private' }) })
    page()
    await chooseRepo('someone/private')
    expect(await screen.findByText(/Type the branch name\./, {}, { timeout: 3000 })).toBeInTheDocument()
    const branch = screen.getByLabelText('Branch')
    await userEvent.clear(branch)
    await userEvent.type(branch, 'release-2')
    await create()
    expect(api.called('POST', '/api/apps')[0].body.branch).toBe('release-2')
  })

  test('a branch typed while the repository\'s branches are still loading is not replaced by the default that arrives later', async () => {
    const api = mockApi({ ...connected, ...branches('someone/else', 'develop', ['develop', 'main']), 'POST /api/apps': answer(201, { id: 'new-id', name: 'else' }) })
    page()
    await chooseRepo('someone/else')
    const box = screen.getByLabelText('Branch') // still a plain box: the list is only asked for once the repository has settled
    await userEvent.clear(box)
    await userEvent.type(box, 'hotfix')
    const picker = await screen.findByRole('combobox', { name: 'Branch' }, { timeout: 3000 })
    await new Promise((r) => setTimeout(r, 50)) // let the default branch be reported
    expect(picker).toHaveTextContent('hotfix')
    await create()
    expect(api.called('POST', '/api/apps')[0].body.branch).toBe('hotfix')
  })

  test('with no repository yet the branch is a plain box holding "main"', async () => {
    mockApi({ ...connected })
    page()
    expect(screen.getByLabelText('Branch')).toHaveValue('main')
  })
})

describe('pasting a GitHub link', () => {
  const created = { 'POST /api/apps': answer(201, { id: 'new-id', name: 'x' }) }

  describe('into the repository list (a GitHub App is connected)', () => {
    const search = () => screen.getByLabelText('Search repositories')
    const open = async () => { await userEvent.click(await repoBox()) }

    test('a link finds the repository it points at, and Enter takes it', async () => {
      mockApi({ ...connected })
      page()
      await open()
      await userEvent.click(search())
      await userEvent.paste('https://github.com/tianyu-00/site')
      expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual(['tianyu-00/siteprivate'])
      await userEvent.keyboard('{Enter}')
      expect(screen.getByRole('combobox', { name: 'GitHub repository' })).toHaveTextContent('tianyu-00/site')
      expect(screen.getByLabelText('Name')).toHaveValue('site')
    })

    test('a link to a repository the app cannot see is offered as "Use owner/name"', async () => {
      const api = mockApi({ ...connected, ...created })
      page()
      await open()
      await userEvent.click(search())
      await userEvent.paste('https://github.com/someone/else.git')
      expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Use “someone/else”'])
      await userEvent.keyboard('{Enter}')
      await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
      expect(await screen.findByText('detail page')).toBeInTheDocument()
      expect(api.called('POST', '/api/apps')[0].body.repo).toBe('someone/else') // owner/name, never the link
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
    const noApp = { 'GET /api/github': { apps: [] } }
    const field = async () => screen.findByPlaceholderText(/owner\/repo/)

    test('a pasted link becomes owner/name at once, and fills in the name', async () => {
      mockApi(noApp)
      page()
      await userEvent.click(await field())
      await userEvent.paste('https://github.com/tianyu-00/site')
      expect(await field()).toHaveValue('tianyu-00/site')
      expect(screen.getByLabelText('Name')).toHaveValue('site')
    })

    test('what is sent is owner/name, never the link', async () => {
      const api = mockApi({ ...noApp, ...created })
      page()
      await userEvent.click(await field())
      await userEvent.paste('https://github.com/tianyu-00/site.git')
      await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
      expect(await screen.findByText('detail page')).toBeInTheDocument()
      expect(api.called('POST', '/api/apps')[0].body.repo).toBe('tianyu-00/site')
    })

    test('a link typed one key at a time is left alone while typing, and becomes owner/name when the field is left', async () => {
      mockApi(noApp)
      page()
      await userEvent.type(await field(), 'https://github.com/o/r.git')
      expect(await field()).toHaveValue('https://github.com/o/r.git') // not rewritten under the person's fingers
      await userEvent.tab()
      expect(await field()).toHaveValue('o/r')
      expect(screen.getByLabelText('Name')).toHaveValue('r')
    })

    test('plain owner/name is left exactly as it is, and a link to another site is left for the server to refuse', async () => {
      mockApi(noApp)
      page()
      await userEvent.click(await field())
      await userEvent.paste('tianyu-00/api')
      await userEvent.tab()
      expect(await field()).toHaveValue('tianyu-00/api')
      await userEvent.clear(await field())
      await userEvent.paste('https://gitlab.com/o/r')
      await userEvent.tab()
      expect(await field()).toHaveValue('https://gitlab.com/o/r')
    })

    test('a link pasted into text that is already there is not guessed at', async () => {
      mockApi(noApp)
      page()
      await userEvent.type(await field(), 'abc')
      await userEvent.paste('https://github.com/o/r')
      expect(await field()).toHaveValue('abchttps://github.com/o/r')
    })

    test('the field says a link can be pasted', async () => {
      mockApi(noApp)
      page()
      expect(await field()).toHaveAttribute('placeholder', expect.stringMatching(/paste the GitHub link/))
    })
  })
})
