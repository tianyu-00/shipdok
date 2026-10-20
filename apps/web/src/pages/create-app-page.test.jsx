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

describe('creating an app', () => {
  test('sends exactly what was entered, as numbers where they are numbers, and opens the new app', async () => {
    const api = mockApi({ 'GET /api/github/repos': repos, 'POST /api/apps': answer(201, { id: 'new-id', name: 'site' }) })
    page()
    await chooseRepo('tianyu-00/site')
    await userEvent.type(screen.getByLabelText('Host port'), '9301')
    await userEvent.type(screen.getByLabelText('Health check path'), '/health')
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    expect(api.called('POST', '/api/apps')[0].body).toEqual({
      name: 'site', repo: 'tianyu-00/site', branch: 'trunk', root_dir: '.', container_port: 3000, host_port: 9301, health_path: '/health',
      memory_mb: 512, cpus: 1, max_restarts: 5, keep_previous_images: 1, auto_prune: false,
    })
  })

  test('the build time limit: empty means none (not sent), a number is sent', async () => {
    const api = mockApi({ 'GET /api/github/repos': repos, 'POST /api/apps': answer(201, { id: 'new-id', name: 'site' }) })
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
    const api = mockApi({ 'GET /api/github/repos': repos, 'POST /api/apps': answer(201, { id: 'new-id', name: 'site' }) })
    page()
    await chooseRepo('tianyu-00/site')
    expect(screen.getByLabelText('Host port')).toHaveAttribute('placeholder', 'automatic')
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    expect(api.called('POST', '/api/apps')[0].body).not.toHaveProperty('host_port')
  })

  test('a full port range is explained', async () => {
    mockApi({ 'GET /api/github/repos': repos, 'POST /api/apps': answer(409, { error: 'Every port from 20000 to 20999 is taken. Choose a host port yourself, or widen PORT_RANGE.', code: 'no_free_port' }) })
    page()
    await chooseRepo('tianyu-00/site')
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Every port from 20000 to 20999 is taken/)
  })

  test('picking a repository fills in the name and the repository\'s own default branch, unless the name was typed by hand', async () => {
    mockApi({ 'GET /api/github/repos': repos })
    page()
    await userEvent.click(await repoBox())
    const list = await screen.findByRole('listbox')
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['tianyu-00/apipublic', 'tianyu-00/siteprivate']) // alphabetical, each marked
    await userEvent.click(within(list).getByText('tianyu-00/site'))
    expect(screen.getByLabelText('Name')).toHaveValue('site')
    expect(screen.getByLabelText('Branch')).toHaveValue('trunk')
  })

  test('a name typed by hand is not overwritten', async () => {
    mockApi({ 'GET /api/github/repos': repos })
    page()
    await userEvent.type(screen.getByLabelText('Name'), 'Mine')
    await chooseRepo('tianyu-00/site')
    expect(screen.getByLabelText('Name')).toHaveValue('Mine')
  })

  test('without a GitHub App the repository is simply typed, and the form still works', async () => {
    const api = mockApi({ 'GET /api/github/repos': answer(501, { error: 'GitHub App is not configured' }), 'POST /api/apps': answer(201, { id: 'x', name: 'pub' }) })
    page()
    expect(await screen.findByText(/private repositories need the shipdok github app/i)).toBeInTheDocument()
    await userEvent.type(await screen.findByPlaceholderText(/owner\/repo/), 'someone/pub') // no list to choose from: a text box
    await userEvent.type(screen.getByLabelText('Host port'), '9400')
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    await waitFor(() => expect(api.called('POST', '/api/apps')).toHaveLength(1))
    expect(api.called('POST', '/api/apps')[0].body).toMatchObject({ repo: 'someone/pub', name: 'pub', branch: 'main', host_port: 9400 })
  })

  test('the server\'s reasons are shown next to the form and nothing navigates away', async () => {
    mockApi({
      'GET /api/github/repos': repos,
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
    mockApi({ 'GET /api/github/repos': repos, 'POST /api/apps': answer(409, { error: 'That host port is already assigned to another app' }) })
    page()
    await chooseRepo('a/b')
    await userEvent.type(screen.getByLabelText('Host port'), '8080')
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already assigned')
  })

  test('a warning from the server (the GitHub App is not installed on the repository) is shown but does not stop you', async () => {
    mockApi({ 'GET /api/github/repos': repos, 'POST /api/apps': answer(201, { id: 'x', name: 'site', warning: 'The Shipdok GitHub App is not installed on this repository.' }) })
    page()
    await chooseRepo('a/b')
    await userEvent.type(screen.getByLabelText('Host port'), '9000')
    await userEvent.click(screen.getByRole('button', { name: 'Create app' }))
    expect(await screen.findByText('detail page')).toBeInTheDocument()
    expect(toasts.warning).toHaveBeenCalledWith(expect.stringMatching(/not installed/), expect.anything())
  })

  test('the clean-up choices are sent', async () => {
    const api = mockApi({ 'GET /api/github/repos': repos, 'POST /api/apps': answer(201, { id: 'x', name: 'n' }) })
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
    const api = mockApi({ 'GET /api/github/repos': repos, 'POST /api/apps': () => new Promise((r) => { release = () => r({ id: 'x', name: 'n' }) }) })
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
  const branches = (repo, defaultBranch, list) => ({ [`GET /api/github/branches?repo=${encodeURIComponent(repo)}`]: { defaultBranch, branches: list, truncated: false } })
  const create = async () => { await userEvent.click(screen.getByRole('button', { name: 'Create app' })); await screen.findByText('detail page') }

  test('once the repository\'s branches are known the form starts on its default branch, even for a typed repository the app list does not know', async () => {
    const api = mockApi({ 'GET /api/github/repos': repos, ...branches('someone/else', 'develop', ['develop', 'main']), 'POST /api/apps': answer(201, { id: 'new-id', name: 'else' }) })
    page()
    await chooseRepo('someone/else')
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Branch' })).toHaveTextContent('develop'), { timeout: 3000 })
    await create()
    expect(api.called('POST', '/api/apps')[0].body.branch).toBe('develop')
  })

  test('a branch picked from the list is the one sent', async () => {
    const api = mockApi({ 'GET /api/github/repos': repos, ...branches('someone/else', 'main', ['main', 'staging']), 'POST /api/apps': answer(201, { id: 'new-id', name: 'else' }) })
    page()
    await chooseRepo('someone/else')
    await userEvent.click(await screen.findByRole('combobox', { name: 'Branch' }, { timeout: 3000 }))
    await userEvent.click(within(await screen.findByRole('listbox')).getByText('staging'))
    expect(screen.getByRole('combobox', { name: 'Branch' })).toHaveTextContent('staging')
    await create()
    expect(api.called('POST', '/api/apps')[0].body.branch).toBe('staging')
  })

  test('a branch chosen by hand is kept when the same repository\'s list is read again, but a different repository starts from its own default', async () => {
    mockApi({ 'GET /api/github/repos': repos, ...branches('a/one', 'main', ['main', 'dev']), ...branches('b/two', 'trunk', ['trunk', 'x']) })
    page()
    await chooseRepo('a/one')
    await userEvent.click(await screen.findByRole('combobox', { name: 'Branch' }, { timeout: 3000 }))
    await userEvent.click(within(await screen.findByRole('listbox')).getByText('dev'))
    expect(screen.getByRole('combobox', { name: 'Branch' })).toHaveTextContent('dev')
    await chooseRepo('b/two')
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Branch' })).toHaveTextContent('trunk'), { timeout: 3000 })
  })

  test('when the branches cannot be listed the branch is typed, and what is typed is sent', async () => {
    const api = mockApi({ 'GET /api/github/repos': repos, 'GET /api/github/branches?repo=someone%2Fprivate': answer(404, { error: 'This repository is private and the app is not installed on it.', code: 'repo_not_found' }), 'POST /api/apps': answer(201, { id: 'new-id', name: 'private' }) })
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
    const api = mockApi({ 'GET /api/github/repos': repos, ...branches('someone/else', 'develop', ['develop', 'main']), 'POST /api/apps': answer(201, { id: 'new-id', name: 'else' }) })
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
    mockApi({ 'GET /api/github/repos': repos })
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
      mockApi({ 'GET /api/github/repos': repos })
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
      const api = mockApi({ 'GET /api/github/repos': repos, ...created })
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
      mockApi({ 'GET /api/github/repos': repos })
      page()
      await open()
      await userEvent.click(search())
      await userEvent.paste(link)
      expect(within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent)).toEqual([`Use “${expected}”`])
    })

    test('a link to another site offers nothing to use', async () => {
      mockApi({ 'GET /api/github/repos': repos })
      page()
      await open()
      await userEvent.click(search())
      await userEvent.paste('https://gitlab.com/o/r')
      expect(within(screen.getByRole('listbox')).getByText('No repository matches.')).toBeInTheDocument()
    })
  })

  describe('into a plain text box (no GitHub App)', () => {
    const noApp = { 'GET /api/github/repos': answer(501, { error: 'not configured' }) }
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
