import { describe, test, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SettingsTab from './settings-tab'
import { mockApi, answer, renderWithProviders } from '@/test/utils'
import { makeApp, APP_ID } from '@/test/fixtures'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts, Toaster: () => null }))
beforeEach(() => vi.clearAllMocks())

const PUT = `PUT /api/apps/${APP_ID}`
const BRANCHES = 'GET /api/github/branches?repo=owner%2Fmy-app'
const tab = (app = makeApp()) => renderWithProviders(<SettingsTab app={app} />)
const box = (label) => screen.getByLabelText(label)
const save = () => screen.getByRole('button', { name: 'Save' })
const type = async (label, text) => { await userEvent.clear(box(label)); if (text) await userEvent.type(box(label), text) }

describe('persistent storage on the settings tab', () => {
  test('has its own card, between the settings and the danger zone', async () => {
    mockApi({ [`GET /api/apps/${APP_ID}/volumes`]: { volumes: [] } })
    tab()
    const card = await screen.findByText('Persistent storage')
    const del = screen.getByText('Delete this app')
    expect(card.compareDocumentPosition(del) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('the build time limit', () => {
  test('is an empty box when there is no limit, and says what that means', () => {
    tab(makeApp({ build_timeout_minutes: null }))
    expect(box('Build time limit (minutes)')).toHaveValue('')
    expect(screen.getByText(/leave empty for no limit/i)).toBeInTheDocument()
    expect(screen.getByText(/blocks? (the )?other deployments|until you cancel/i)).toBeInTheDocument()
  })

  test('setting it sends the number, and it waits for the next deployment', async () => {
    const api = mockApi({ [PUT]: makeApp({ build_timeout_minutes: 60, settings_pending: ['build_timeout_minutes'] }) })
    tab()
    await type('Build time limit (minutes)', '60')
    await userEvent.click(save())
    await waitFor(() => expect(api.called('PUT', `/api/apps/${APP_ID}`)).toHaveLength(1))
    expect(api.called('PUT', `/api/apps/${APP_ID}`)[0].body).toEqual({ build_timeout_minutes: 60 })
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Saved. Deploy to apply the changes.'))
  })

  test('emptying it sends null (no limit)', async () => {
    const api = mockApi({ [PUT]: makeApp({ build_timeout_minutes: null, settings_pending: ['build_timeout_minutes'] }) })
    tab(makeApp({ build_timeout_minutes: 45 }))
    expect(box('Build time limit (minutes)')).toHaveValue('45')
    await type('Build time limit (minutes)', '')
    await userEvent.click(save())
    await waitFor(() => expect(api.called('PUT', `/api/apps/${APP_ID}`)).toHaveLength(1))
    expect(api.called('PUT', `/api/apps/${APP_ID}`)[0].body).toEqual({ build_timeout_minutes: null })
  })

  test('a number the server would refuse is caught first', async () => {
    const api = mockApi({})
    tab()
    await type('Build time limit (minutes)', '3')
    await userEvent.click(save())
    expect(await screen.findByText(/from 5 to 10080/i)).toBeInTheDocument()
    expect(box('Build time limit (minutes)')).toHaveAttribute('aria-invalid', 'true')
    expect(api.called('PUT', `/api/apps/${APP_ID}`)).toHaveLength(0)
  })
})

describe('the settings form', () => {
  test('starts with the app\'s values, and nothing to save', () => {
    tab(makeApp({ health_path: null, cpus: '1.50' }))
    expect(box('Name')).toHaveValue('My App')
    expect(box('Host port')).toHaveValue('8080')
    expect(box('Health check path')).toHaveValue('')
    expect(box('CPU limit')).toHaveValue('1.5')
    expect(save()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeDisabled()
  })

  test('the repository is shown as a link and cannot be edited, with the way to change it', () => {
    tab()
    expect(screen.getByRole('link', { name: 'owner/my-app' })).toHaveAttribute('href', 'https://github.com/owner/my-app')
    expect(screen.queryByLabelText(/repository/i)).toBeNull()
    expect(screen.getByText(/delete this app and create a new one/i)).toBeInTheDocument()
  })

  test('sends only what changed, and says deploying is needed', async () => {
    const api = mockApi({ [PUT]: makeApp({ host_port: 9000, settings_pending: ['host_port'] }) })
    tab()
    await type('Host port', '9000')
    expect(save()).toBeEnabled()
    await userEvent.click(save())
    await waitFor(() => expect(api.called('PUT', `/api/apps/${APP_ID}`)).toHaveLength(1))
    expect(api.called('PUT', `/api/apps/${APP_ID}`)[0].body).toEqual({ host_port: 9000 })
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Saved. Deploy to apply the changes.'))
  })

  test('an edit that applies at once just says Saved', async () => {
    mockApi({ [PUT]: makeApp({ name: 'Renamed', settings_pending: [] }) })
    tab()
    await type('Name', 'Renamed')
    await userEvent.click(save())
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Saved'))
  })

  test('emptying the health path sends null', async () => {
    const api = mockApi({ [PUT]: makeApp({ health_path: null }) })
    tab()
    await type('Health check path', '')
    await userEvent.click(save())
    await waitFor(() => expect(api.called('PUT', `/api/apps/${APP_ID}`)[0].body).toEqual({ health_path: null }))
  })

  test('a taken port is explained next to the port box, which keeps what was typed', async () => {
    mockApi({ [PUT]: answer(409, { error: 'Port 8081 is already used by the app "Other"', code: 'port_taken', app: { id: 'x', name: 'Other' } }) })
    tab()
    await type('Host port', '8081')
    await userEvent.click(save())
    const message = await screen.findByText('Port 8081 is already used by the app "Other"')
    expect(message).toHaveAttribute('role', 'alert')
    expect(box('Host port')).toHaveValue('8081')
    expect(box('Host port')).toHaveAttribute('aria-invalid', 'true')
    expect(toasts.error).not.toHaveBeenCalled()
  })

  test('the message goes away when the port is edited', async () => {
    mockApi({ [PUT]: answer(409, { error: 'Port 8081 is already used by the app "Other"', code: 'port_taken' }) })
    tab()
    await type('Host port', '8081')
    await userEvent.click(save())
    await screen.findByText(/already used by the app/)
    await userEvent.type(box('Host port'), '2')
    expect(screen.queryByText(/already used by the app/)).toBeNull()
  })

  test('a taken name is explained next to the name box', async () => {
    mockApi({ [PUT]: answer(409, { error: 'The name "Other" is already used by the app "Other"', code: 'name_taken' }) })
    tab()
    await type('Name', 'Other')
    await userEvent.click(save())
    expect(await screen.findByText(/The name "Other" is already used/)).toBeInTheDocument()
    expect(box('Name')).toHaveAttribute('aria-invalid', 'true')
    expect(box('Host port')).not.toHaveAttribute('aria-invalid')
  })

  test('after saving the form shows what the server now has', async () => {
    mockApi({ [PUT]: makeApp({ name: 'Trimmed Name', updated_at: '2026-10-19T13:00:00Z', settings_pending: [] }) })
    const view = tab(makeApp({ updated_at: '2026-10-19T12:00:00Z' }))
    await type('Name', 'Trimmed   Name  ')
    await userEvent.click(save())
    await waitFor(() => expect(toasts.success).toHaveBeenCalled())
    view.rerender(view.wrap(<SettingsTab app={makeApp({ name: 'Trimmed Name', updated_at: '2026-10-19T13:00:00Z' })} />))
    expect(box('Name')).toHaveValue('Trimmed Name')
    expect(save()).toBeDisabled()
  })

  test('mistakes are caught in the browser: nothing is sent', async () => {
    const api = mockApi({ [PUT]: makeApp() })
    tab()
    await type('Host port', '80')
    await type('Memory limit (MB)', '10')
    await userEvent.click(save())
    expect(await screen.findByText(/1024 to 65535/)).toBeInTheDocument()
    expect(screen.getByText(/64 to 8192/)).toBeInTheDocument()
    expect(api.called('PUT', `/api/apps/${APP_ID}`)).toHaveLength(0)
  })

  test('other refusals from the server are shown (a list of problems, or a toast)', async () => {
    mockApi({ [PUT]: answer(400, { error: 'Invalid app settings', details: ['branch: Invalid branch name'] }), [BRANCHES]: answer(404, { error: 'No such repository', code: 'repo_not_found' }) })
    tab()
    await screen.findByRole('textbox', { name: 'Branch' }) // the branches cannot be listed, so the branch is a text box
    await type('Branch', 'dev')
    await userEvent.click(save())
    expect(await screen.findByText('branch: Invalid branch name')).toBeInTheDocument()
  })

  test('a server error that is not about a field is a toast', async () => {
    mockApi({ [PUT]: answer(500, { error: 'Internal server error' }) })
    tab()
    await type('Name', 'X')
    await userEvent.click(save())
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Internal server error'))
  })

  test('discard puts the saved values back', async () => {
    tab()
    await type('Host port', '9999')
    await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(box('Host port')).toHaveValue('8080')
    expect(save()).toBeDisabled()
  })

  test('explains that the host port moves with the next deployment', () => {
    tab()
    expect(screen.getByText(/takes effect with the next deployment/i)).toBeInTheDocument()
    expect(screen.getByText(/something else on this machine uses the port/i)).toBeInTheDocument()
  })
})

describe('edits that are waiting for a deployment', () => {
  test('are listed by name', () => {
    tab(makeApp({ settings_pending: ['host_port', 'memory_mb'] }))
    expect(screen.getByText('These settings are not in the running app yet')).toBeInTheDocument()
    expect(screen.getByText(/Host port, Memory limit/)).toBeInTheDocument()
  })
  test('nothing is shown when nothing waits (or nothing was deployed)', () => {
    tab(makeApp({ settings_pending: [] }))
    expect(screen.queryByText(/not in the running app yet/)).toBeNull()
  })
  test('a single one is called "it"', () => {
    tab(makeApp({ settings_pending: ['cpus'] }))
    expect(screen.getByText(/CPU limit\. Press Deploy to apply it\./)).toBeInTheDocument()
  })
})

describe('the branch on the settings tab', () => {
  const LIST = { 'GET /api/github/branches?repo=owner%2Fmy-app': { defaultBranch: 'main', branches: ['main', 'develop', 'release'], truncated: false } }

  test('is chosen from the repository\'s own branches, with the default marked', async () => {
    mockApi({ ...LIST })
    tab()
    const box = await screen.findByRole('combobox', { name: 'Branch' })
    expect(box).toHaveTextContent('main')
    await userEvent.click(box)
    const list = await screen.findByRole('listbox')
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['maindefault', 'develop', 'release'])
  })

  test('choosing another branch makes the form changed, and saving sends just the branch', async () => {
    const api = mockApi({ ...LIST, [PUT]: { id: APP_ID, branch: 'develop', settings_pending: ['branch'] } })
    tab()
    expect(save()).toBeDisabled()
    await userEvent.click(await screen.findByRole('combobox', { name: 'Branch' }))
    await userEvent.click(within(await screen.findByRole('listbox')).getByText('develop'))
    expect(save()).toBeEnabled()
    await userEvent.click(save())
    await waitFor(() => expect(api.called('PUT', `/api/apps/${APP_ID}`)).toHaveLength(1))
    expect(api.called('PUT', `/api/apps/${APP_ID}`)[0].body).toEqual({ branch: 'develop' })
  })

  test('choosing the branch it already has changes nothing', async () => {
    mockApi({ ...LIST })
    tab()
    await userEvent.click(await screen.findByRole('combobox', { name: 'Branch' }))
    await userEvent.click(within(await screen.findByRole('listbox')).getByText('main'))
    expect(save()).toBeDisabled()
  })

  test('a saved branch that no longer exists on GitHub is shown with a warning, and can still be kept', async () => {
    mockApi({ ...LIST })
    tab(makeApp({ branch: 'old-release' }))
    expect(await screen.findByText(/“old-release” is not among this repository's branches/)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Branch' })).toHaveTextContent('old-release')
    expect(save()).toBeDisabled()
  })
})

describe('the GitHub app of the project', () => {
  const ONE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const TWO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const gh = (id, name, owner) => ({ id, appId: id.slice(0, 2), name, ownerLogin: owner, slug: name.toLowerCase(), projects: [], problem: null })
  const LIST = { apps: [gh(ONE, 'Shipdok-ab12', 'tianyu-00'), gh(TWO, 'Shipdok-cd34', 'my-org')] }
  const select = () => screen.findByLabelText('GitHub app')
  const saveApp = () => within(screen.getByLabelText('GitHub app').closest('form')).getByRole('button', { name: 'Save' })

  test('shows the saved one, and nothing can be saved until it is changed', async () => {
    mockApi({ 'GET /api/github': LIST })
    tab(makeApp({ github_app_id: TWO }))
    expect(await select()).toHaveValue(TWO)
    expect(saveApp()).toBeDisabled()
    await userEvent.selectOptions(screen.getByLabelText('GitHub app'), ONE)
    expect(saveApp()).toBeEnabled()
    await userEvent.selectOptions(screen.getByLabelText('GitHub app'), TWO)
    expect(saveApp()).toBeDisabled() // back to what it was
  })

  test('lists the connected apps with their owners, and None', async () => {
    mockApi({ 'GET /api/github': LIST })
    tab()
    const names = within(await select()).getAllByRole('option').map((o) => o.textContent)
    expect(names).toEqual(['Shipdok-ab12 (tianyu-00)', 'Shipdok-cd34 (my-org)', 'None (a public repository, deployed by hand)'])
    expect(screen.getByLabelText('GitHub app')).toHaveValue('') // a project with none
  })

  test('saving sends only the GitHub app, says it applies at once, and reads the lists again', async () => {
    const api = mockApi({ 'GET /api/github': LIST, [PUT]: makeApp({ github_app_id: ONE }) })
    tab(makeApp({ github_app_id: TWO }))
    await userEvent.selectOptions(await select(), ONE)
    await userEvent.click(saveApp())
    await waitFor(() => expect(api.called('PUT', `/api/apps/${APP_ID}`)).toHaveLength(1))
    expect(api.called('PUT', `/api/apps/${APP_ID}`)[0].body).toEqual({ github_app_id: ONE })
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('GitHub app saved'))
    await waitFor(() => expect(api.called('GET', '/api/github').length).toBeGreaterThan(1)) // the projects under each GitHub app
  })

  test('the text above the choice says saving does not deploy and when the latest commit is picked up, in plain text (not a box)', async () => {
    mockApi({ 'GET /api/github': LIST })
    tab()
    const card = (await select()).closest('[data-slot=card]')
    const text = card.querySelector('[data-slot=card-description]')
    expect(text).toHaveTextContent('Which GitHub app this project uses to read its repository.')
    expect(text).toHaveTextContent('Saving does not deploy. Your latest commit is picked up on the next push, or when you press Deploy.')
    expect(within(text).getByRole('link', { name: 'GitHub page' })).toHaveAttribute('href', '/github')
    expect(within(card).queryByRole('note')).toBeNull() // no separate info box
  })

  test('saving shows only the plain confirmation: the explanation lives on the card, not in a pop-up', async () => {
    mockApi({ 'GET /api/github': LIST, [PUT]: makeApp({ github_app_id: ONE }) })
    tab(makeApp({ github_app_id: TWO }))
    await userEvent.selectOptions(await select(), ONE)
    await userEvent.click(saveApp())
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('GitHub app saved'))
    expect(toasts.success).toHaveBeenCalledTimes(1)
  })

  test('None sends null', async () => {
    const api = mockApi({ 'GET /api/github': LIST, [PUT]: makeApp({ github_app_id: null }) })
    tab(makeApp({ github_app_id: ONE }))
    await userEvent.selectOptions(await select(), '')
    await userEvent.click(saveApp())
    await waitFor(() => expect(api.called('PUT', `/api/apps/${APP_ID}`)).toHaveLength(1))
    expect(api.called('PUT', `/api/apps/${APP_ID}`)[0].body).toEqual({ github_app_id: null })
  })

  test('a warning about the installation is shown', async () => {
    mockApi({ 'GET /api/github': LIST, [PUT]: makeApp({ github_app_id: ONE, warning: 'The chosen GitHub app is not installed on this repository.' }) })
    tab(makeApp({ github_app_id: TWO }))
    await userEvent.selectOptions(await select(), ONE)
    await userEvent.click(saveApp())
    await waitFor(() => expect(toasts.warning).toHaveBeenCalledWith(expect.stringMatching(/not installed/), expect.anything()))
  })

  test('a refusal is shown and the choice stays', async () => {
    mockApi({ 'GET /api/github': LIST, [PUT]: answer(400, { error: 'No such GitHub app. Connect it on the GitHub page first.' }) })
    tab(makeApp({ github_app_id: TWO }))
    await userEvent.selectOptions(await select(), ONE)
    await userEvent.click(saveApp())
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(expect.stringMatching(/No such GitHub app/)))
    expect(screen.getByLabelText('GitHub app')).toHaveValue(ONE)
  })

  test('Discard puts the saved choice back', async () => {
    mockApi({ 'GET /api/github': LIST })
    tab(makeApp({ github_app_id: TWO }))
    await userEvent.selectOptions(await select(), ONE)
    await userEvent.click(within(screen.getByLabelText('GitHub app').closest('form')).getByRole('button', { name: 'Discard' }))
    expect(screen.getByLabelText('GitHub app')).toHaveValue(TWO)
  })

  test('with no GitHub app connected it says so and points to the GitHub page', async () => {
    mockApi({ 'GET /api/github': { apps: [] } })
    tab()
    expect(await screen.findByText(/No GitHub app is connected/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'connect one' })).toHaveAttribute('href', '/github')
    expect(screen.queryByLabelText('GitHub app')).toBeNull()
  })

  test('when the list cannot be read it says so instead of showing a choice that would be wrong', async () => {
    mockApi({ 'GET /api/github': answer(500, { error: 'boom' }) })
    tab(makeApp({ github_app_id: TWO }))
    expect(await screen.findByText(/Could not load the connected GitHub apps/)).toBeInTheDocument()
    expect(screen.queryByLabelText('GitHub app')).toBeNull()
  })

  test('the branch list is read through the project\'s GitHub app', async () => {
    const api = mockApi({ 'GET /api/github': LIST, [`${BRANCHES}&app=${TWO}`]: { defaultBranch: 'main', branches: ['main', 'dev'], truncated: false } })
    tab(makeApp({ github_app_id: TWO }))
    await waitFor(() => expect(api.called('GET', '/api/github/branches')).toHaveLength(1))
    expect(api.called('GET', '/api/github/branches')[0].path).toContain(`app=${TWO}`)
  })

  test('after changing the GitHub app the branches are asked again, through the new one', async () => {
    const api = mockApi({
      'GET /api/github': LIST,
      [`${BRANCHES}&app=${TWO}`]: { defaultBranch: 'main', branches: ['main'], truncated: false },
      [`${BRANCHES}&app=${ONE}`]: { defaultBranch: 'main', branches: ['main', 'private-branch'], truncated: false },
      [PUT]: makeApp({ github_app_id: ONE }),
    })
    tab(makeApp({ github_app_id: TWO }))
    await waitFor(() => expect(api.called('GET', '/api/github/branches')).toHaveLength(1))
    await userEvent.selectOptions(await select(), ONE)
    await userEvent.click(saveApp())
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('GitHub app saved'))
    // (the form is rebuilt from the saved copy; here the saved copy is the one the server answered with)
    await waitFor(() => expect(api.called('GET', '/api/github/branches').length).toBeGreaterThan(1))
  })

  test('a project with none is read anonymously', async () => {
    const api = mockApi({ 'GET /api/github': LIST, [BRANCHES]: { defaultBranch: 'main', branches: ['main'], truncated: false } })
    tab(makeApp({ github_app_id: null }))
    await waitFor(() => expect(api.called('GET', '/api/github/branches')).toHaveLength(1))
    expect(api.called('GET', '/api/github/branches')[0].path).not.toContain('app=')
  })
})
