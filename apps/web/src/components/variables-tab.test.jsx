import { describe, test, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import VariablesTab from './variables-tab'
import { mockApi, answer, renderWithProviders } from '@/test/utils'
import { makeApp, APP_ID } from '@/test/fixtures'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts, Toaster: () => null }))
beforeEach(() => vi.clearAllMocks())

const ENV = `GET /api/apps/${APP_ID}/env`
const vars = (...keys) => keys.map((key) => ({ key, value: '********', updated_at: '2026-10-19T11:00:00Z' }))
const idle = { deployed: true, pending: false, added: [], changed: [], removed: [] }
const tab = () => renderWithProviders(<VariablesTab app={makeApp()} />)

describe('the build method', () => {
  test('a Railpack app is told that its build variables are always build secrets; a Dockerfile app is not', async () => {
    mockApi({ [ENV]: { variables: [], pending: idle } })
    const { unmount } = renderWithProviders(<VariablesTab app={makeApp({ build_method: 'railpack' })} />)
    expect(await screen.findByText(/built with Railpack, so a variable that reaches the build is always passed as a build secret/i)).toBeInTheDocument()
    unmount()
    renderWithProviders(<VariablesTab app={makeApp({ build_method: 'dockerfile' })} />)
    expect(await screen.findByText('No variables yet')).toBeInTheDocument()
    expect(screen.queryByText(/built with Railpack/i)).toBeNull()
  })
})

describe('the list', () => {
  test('shows names with a fixed mask, never a value', async () => {
    mockApi({ [ENV]: { variables: vars('DATABASE_URL', 'API_KEY'), pending: idle } })
    tab()
    expect(await screen.findByText('DATABASE_URL')).toBeInTheDocument()
    expect(screen.getAllByLabelText('hidden value')).toHaveLength(2)
    expect(screen.getAllByText('********')).toHaveLength(2)
  })

  test('no variables yet', async () => {
    mockApi({ [ENV]: { variables: [], pending: idle } })
    tab()
    expect(await screen.findByText('No variables yet')).toBeInTheDocument()
  })

  test('a load failure can be retried', async () => {
    mockApi({ [ENV]: answer(500, { error: 'Internal server error' }) })
    tab()
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument()
  })
})

describe('pending changes', () => {
  test('lists what was added, changed and removed since the running version was deployed', async () => {
    mockApi({ [ENV]: { variables: vars('A'), pending: { deployed: true, pending: true, added: ['NEW_ONE'], changed: ['CHANGED_ONE'], removed: ['GONE_ONE'] } } })
    tab()
    const note = await screen.findByText(/not in the running app yet/i)
    const box = note.closest('[data-slot="alert"]')
    expect(within(box).getByText('NEW_ONE')).toBeInTheDocument()
    expect(within(box).getByText('CHANGED_ONE')).toBeInTheDocument()
    expect(within(box).getByText('GONE_ONE')).toBeInTheDocument()
  })

  test('nothing is said when nothing is pending', async () => {
    mockApi({ [ENV]: { variables: vars('A'), pending: idle } })
    tab()
    await screen.findByText('A')
    expect(screen.queryByText(/not in the running app yet/i)).toBeNull()
  })
})

describe('reveal', () => {
  test('is asked for explicitly, shows the value, and can be hidden again', async () => {
    const api = mockApi({ [ENV]: { variables: vars('API_KEY'), pending: idle }, [`POST /api/apps/${APP_ID}/env/API_KEY/reveal`]: { key: 'API_KEY', value: 's3cr3t-value' } })
    tab()
    expect(api.called('POST', `/api/apps/${APP_ID}/env/API_KEY/reveal`)).toHaveLength(0)
    await userEvent.click(await screen.findByRole('button', { name: 'Show API_KEY' }))
    expect(await screen.findByTestId('revealed')).toHaveTextContent('s3cr3t-value')
    await userEvent.click(screen.getByRole('button', { name: 'Hide API_KEY' }))
    expect(screen.queryByText('s3cr3t-value')).toBeNull()
    expect(screen.getByLabelText('hidden value')).toBeInTheDocument()
  })

  test('an empty value is shown as such', async () => {
    mockApi({ [ENV]: { variables: vars('EMPTY'), pending: idle }, [`POST /api/apps/${APP_ID}/env/EMPTY/reveal`]: { key: 'EMPTY', value: '' } })
    tab()
    await userEvent.click(await screen.findByRole('button', { name: 'Show EMPTY' }))
    expect(await screen.findByTestId('revealed')).toHaveTextContent('(empty)')
  })

  test('a failure (the key changed, so the value cannot be decrypted) is reported and nothing is shown', async () => {
    mockApi({ [ENV]: { variables: vars('K'), pending: idle }, [`POST /api/apps/${APP_ID}/env/K/reveal`]: answer(500, { error: 'Could not decrypt this value. Has APP_SECRETS_KEY changed?' }) })
    tab()
    await userEvent.click(await screen.findByRole('button', { name: 'Show K' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(expect.stringMatching(/APP_SECRETS_KEY/)))
    expect(screen.queryByTestId('revealed')).toBeNull()
  })
})

describe('changing variables', () => {
  test('adding one sends the name and value and refreshes the list', async () => {
    let listed = vars('OLD')
    const api = mockApi({ [ENV]: () => ({ variables: listed, pending: idle }), [`PUT /api/apps/${APP_ID}/env/NEW_KEY`]: () => { listed = vars('OLD', 'NEW_KEY'); return answer(201, { key: 'NEW_KEY', created: true }) } })
    tab()
    await screen.findByText('OLD')
    await userEvent.type(screen.getByLabelText('Name'), 'NEW_KEY')
    await userEvent.type(screen.getByLabelText('Value'), 'v@lue')
    await userEvent.click(screen.getByRole('button', { name: 'Add or update' }))
    expect(await screen.findByText('NEW_KEY')).toBeInTheDocument()
    expect(api.called('PUT', `/api/apps/${APP_ID}/env/NEW_KEY`)[0].body).toEqual({ value: 'v@lue', scope: 'runtime' })
    expect(screen.getByLabelText('Name')).toHaveValue('')
    expect(screen.getByLabelText('Value')).toHaveValue('')
  })

  test('the value field is a password field, so it is not shown over a shoulder', async () => {
    mockApi({ [ENV]: { variables: [], pending: idle } })
    tab()
    await screen.findByText('No variables yet')
    expect(screen.getByLabelText('Value')).toHaveAttribute('type', 'password')
  })

  test('the name and value fields tell browsers and password managers they are not a login, on the add form and in the edit dialog', async () => {
    mockApi({ [ENV]: { variables: vars('A'), pending: idle } })
    tab()
    const checks = (name, value) => {
      expect(name).toHaveAttribute('autocomplete', 'off')
      expect(value).toHaveAttribute('autocomplete', 'new-password') // the saved sign-in is never offered for a new value
      for (const el of [name, value]) {
        expect(el).toHaveAttribute('data-1p-ignore')
        expect(el).toHaveAttribute('data-lpignore', 'true')
        expect(el).toHaveAttribute('data-bwignore', 'true')
      }
      expect(value).toHaveAttribute('type', 'password')
    }
    checks(await screen.findByLabelText('Name'), screen.getByLabelText('Value'))
    await userEvent.click(screen.getByLabelText('Edit A'))
    checks(screen.getByLabelText('Name of A'), screen.getByLabelText('New value for A'))
  })

  test('nothing can be added without a name', async () => {
    mockApi({ [ENV]: { variables: [], pending: idle } })
    tab()
    await screen.findByText('No variables yet')
    expect(screen.getByRole('button', { name: 'Add or update' })).toBeDisabled()
  })

  test('a name the server refuses is explained', async () => {
    mockApi({ [ENV]: { variables: [], pending: idle }, [`PUT /api/apps/${APP_ID}/env/PORT`]: answer(400, { error: '"PORT" is reserved and cannot be set' }) })
    tab()
    await userEvent.type(await screen.findByLabelText('Name'), 'PORT')
    await userEvent.type(screen.getByLabelText('Value'), '1')
    await userEvent.click(screen.getByRole('button', { name: 'Add or update' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(expect.stringMatching(/reserved/)))
  })

  test('editing sends the new value', async () => {
    const api = mockApi({ [ENV]: { variables: vars('API_KEY'), pending: idle }, [`PUT /api/apps/${APP_ID}/env/API_KEY`]: { key: 'API_KEY' } })
    tab()
    await userEvent.click(await screen.findByRole('button', { name: 'Edit API_KEY' }))
    await userEvent.type(screen.getByLabelText('New value for API_KEY'), 'fresh')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.called('PUT', `/api/apps/${APP_ID}/env/API_KEY`)).toHaveLength(1))
    expect(api.called('PUT', `/api/apps/${APP_ID}/env/API_KEY`)[0].body).toEqual({ value: 'fresh' })
  })

  test('cancelling an edit changes nothing', async () => {
    const api = mockApi({ [ENV]: { variables: vars('API_KEY'), pending: idle } })
    tab()
    await userEvent.click(await screen.findByRole('button', { name: 'Edit API_KEY' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('New value for API_KEY')).toBeNull()
    expect(api.calls.filter((c) => c.method === 'PUT')).toHaveLength(0)
  })

  test('names with special characters are encoded in the address', async () => {
    const api = mockApi({ [ENV]: { variables: vars('A/B'), pending: idle }, [`POST /api/apps/${APP_ID}/env/A%2FB/reveal`]: { key: 'A/B', value: 'x' } })
    tab()
    await userEvent.click(await screen.findByRole('button', { name: 'Show A/B' }))
    await waitFor(() => expect(api.calls.some((c) => c.path.endsWith('/env/A%2FB/reveal'))).toBe(true))
  })

  test('deleting asks first, and only then deletes', async () => {
    const api = mockApi({ [ENV]: { variables: vars('OLD'), pending: idle }, [`DELETE /api/apps/${APP_ID}/env/OLD`]: null })
    tab()
    await userEvent.click(await screen.findByRole('button', { name: 'Delete OLD' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(api.called('DELETE', `/api/apps/${APP_ID}/env/OLD`)).toHaveLength(0)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(api.called('DELETE', `/api/apps/${APP_ID}/env/OLD`)).toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: 'Delete OLD' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.called('DELETE', `/api/apps/${APP_ID}/env/OLD`)).toHaveLength(1))
  })
})

describe('importing a .env file', () => {
  const open = async () => { await userEvent.click(await screen.findByRole('button', { name: /import \.env/i })) }

  test('sends the pasted text and reports the result', async () => {
    const api = mockApi({ [ENV]: { variables: [], pending: idle }, [`POST /api/apps/${APP_ID}/env/import`]: { created: 2, updated: 1, keys: [] } })
    tab()
    await open()
    await userEvent.type(screen.getByLabelText('.env contents'), 'A=1')
    await userEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Imported: 2 added, 1 updated'))
    expect(api.called('POST', `/api/apps/${APP_ID}/env/import`)[0].body).toEqual({ content: 'A=1' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  test('problems are listed by line, and nothing closes: the text stays so it can be fixed', async () => {
    mockApi({
      [ENV]: { variables: [], pending: idle },
      [`POST /api/apps/${APP_ID}/env/import`]: answer(400, { error: 'Import failed; nothing was saved', problems: [{ line: 2, message: 'Not a valid name' }, { line: 5, message: 'Reserved' }], total_problems: 4 }),
    })
    tab()
    await open()
    await userEvent.type(screen.getByLabelText('.env contents'), 'X')
    await userEvent.click(screen.getByRole('button', { name: 'Import' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('nothing was saved')
    expect(alert).toHaveTextContent('Line 2: Not a valid name')
    expect(alert).toHaveTextContent('Line 5: Reserved')
    expect(alert).toHaveTextContent('and 2 more')
    expect(screen.getByLabelText('.env contents')).toHaveValue('X')
  })

  test('Import is disabled until there is text', async () => {
    mockApi({ [ENV]: { variables: [], pending: idle } })
    tab()
    await open()
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled()
  })
})

describe('where a variable is available', () => {
  const scoped = (...pairs) => pairs.map(([key, scope]) => ({ key, scope, value: '********', updated_at: '2026-10-19T11:00:00Z' }))
  const PUT = (k) => `PUT /api/apps/${APP_ID}/env/${k}`
  const BASE = (k) => `/api/apps/${APP_ID}/env/${k}`
  const badge = (key) => within(screen.getByText(key).closest('td')).getByTestId('scope-badge')
  const edit = async (key) => userEvent.click(await screen.findByLabelText(`Edit ${key}`))
  const save = () => userEvent.click(screen.getByRole('button', { name: 'Save' }))

  test('a badge beside each name says where it is available; a variable from before scopes existed is runtime', async () => {
    mockApi({ [ENV]: { variables: [...scoped(['VITE_X', 'build'], ['BOTH_ONE', 'both'], ['RUN_ONE', 'runtime']), ...vars('OLD')], pending: idle } })
    tab()
    await screen.findByText('VITE_X')
    expect([badge('VITE_X'), badge('BOTH_ONE'), badge('RUN_ONE'), badge('OLD')].map((b) => b.textContent)).toEqual(['Build', 'Build + runtime', 'Runtime', 'Runtime'])
    expect(badge('VITE_X').className).toMatch(/text-primary/)
    expect(badge('BOTH_ONE').className).toMatch(/text-primary/)
    expect(badge('RUN_ONE').className).toMatch(/text-muted-foreground/)
  })

  test('the row itself has no scope dropdown and the table no "Available in" column: that is only in the edit view', async () => {
    mockApi({ [ENV]: { variables: scoped(['A', 'build']), pending: idle } })
    tab()
    await screen.findByText('A')
    expect(screen.queryByLabelText('Where A is available')).toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'Available in' })).toBeNull()
    await edit('A')
    expect(screen.getByLabelText('Where A is available')).toHaveValue('build')
  })

  test('editing starts from the current scope and nothing can be saved until something changes', async () => {
    mockApi({ [ENV]: { variables: scoped(['A', 'both']), pending: idle } })
    tab()
    await edit('A')
    expect(screen.getByLabelText('Where A is available')).toHaveValue('both')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await userEvent.selectOptions(screen.getByLabelText('Where A is available'), 'runtime')
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    await userEvent.selectOptions(screen.getByLabelText('Where A is available'), 'both')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled() // back to what it was
  })

  test('changing only the scope sends the scope alone: the value is never needed', async () => {
    const api = mockApi({ [ENV]: { variables: scoped(['A', 'runtime']), pending: idle }, [PUT('A')]: { key: 'A', scope: 'both' } })
    tab()
    await edit('A')
    await userEvent.selectOptions(screen.getByLabelText('Where A is available'), 'both')
    await save()
    await waitFor(() => expect(api.called('PUT', BASE('A'))).toHaveLength(1))
    expect(api.called('PUT', BASE('A'))[0].body).toEqual({ scope: 'both' })
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('A saved'))
  })

  test('changing only the value sends the value alone: the scope is kept', async () => {
    const api = mockApi({ [ENV]: { variables: scoped(['A', 'build']), pending: idle }, [PUT('A')]: { key: 'A', created: false, scope: 'build' } })
    tab()
    await edit('A')
    await userEvent.type(screen.getByLabelText('New value for A'), 'new')
    await save()
    await waitFor(() => expect(api.called('PUT', BASE('A'))).toHaveLength(1))
    expect(api.called('PUT', BASE('A'))[0].body).toEqual({ value: 'new' })
  })

  test('changing both sends both', async () => {
    const api = mockApi({ [ENV]: { variables: scoped(['A', 'runtime']), pending: idle }, [PUT('A')]: { key: 'A', created: false, scope: 'build' } })
    tab()
    await edit('A')
    await userEvent.type(screen.getByLabelText('New value for A'), 'new')
    await userEvent.selectOptions(screen.getByLabelText('Where A is available'), 'build')
    await save()
    await waitFor(() => expect(api.called('PUT', BASE('A'))).toHaveLength(1))
    expect(api.called('PUT', BASE('A'))[0].body).toEqual({ value: 'new', scope: 'build' })
  })

  test('a value that was typed and then cleared is an empty value, not "unchanged"', async () => {
    const api = mockApi({ [ENV]: { variables: scoped(['A', 'runtime']), pending: idle }, [PUT('A')]: { key: 'A', created: false, scope: 'runtime' } })
    tab()
    await edit('A')
    await userEvent.type(screen.getByLabelText('New value for A'), 'x')
    await userEvent.clear(screen.getByLabelText('New value for A'))
    await save()
    await waitFor(() => expect(api.called('PUT', BASE('A'))).toHaveLength(1))
    expect(api.called('PUT', BASE('A'))[0].body).toEqual({ value: '' })
  })

  test('cancel discards the changes, and editing again starts from the saved state', async () => {
    const api = mockApi({ [ENV]: { variables: scoped(['A', 'runtime']), pending: idle } })
    tab()
    await edit('A')
    await userEvent.type(screen.getByLabelText('New value for A'), 'typed')
    await userEvent.selectOptions(screen.getByLabelText('Where A is available'), 'build')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('New value for A')).toBeNull()
    expect(api.called('PUT', BASE('A'))).toHaveLength(0)
    await edit('A')
    expect(screen.getByLabelText('New value for A')).toHaveValue('')
    expect(screen.getByLabelText('Where A is available')).toHaveValue('runtime')
  })

  test('a refusal from the API is shown and the edit stays open', async () => {
    mockApi({ [ENV]: { variables: scoped(['A', 'runtime']), pending: idle }, [PUT('A')]: answer(400, { error: 'A cannot be used at build time' }) })
    tab()
    await edit('A')
    await userEvent.selectOptions(screen.getByLabelText('Where A is available'), 'build')
    await save()
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('A cannot be used at build time'))
    expect(screen.getByLabelText('Where A is available')).toBeInTheDocument()
  })

  test('moving a variable to the build explains that it is baked into the image; runtime does not', async () => {
    mockApi({ [ENV]: { variables: scoped(['A', 'runtime']), pending: idle } })
    tab()
    await edit('A')
    expect(screen.queryByText(/baked into the image/)).toBeNull()
    await userEvent.selectOptions(screen.getByLabelText('Where A is available'), 'build')
    expect(screen.getByText(/baked into the image/)).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('Where A is available'), 'runtime')
    expect(screen.queryByText(/baked into the image/)).toBeNull()
  })

  test('a runtime variable whose name cannot be used at build time cannot be moved there, but can still be edited', async () => {
    const api = mockApi({ [ENV]: { variables: scoped(['LANG', 'runtime']), pending: idle }, [PUT('LANG')]: { key: 'LANG', created: false, scope: 'runtime' } })
    tab()
    await edit('LANG')
    await userEvent.selectOptions(screen.getByLabelText('Where LANG is available'), 'build')
    expect(screen.getByRole('alert')).toHaveTextContent(/LANG cannot be used at build time/)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await userEvent.selectOptions(screen.getByLabelText('Where LANG is available'), 'runtime')
    await userEvent.type(screen.getByLabelText('New value for LANG'), 'C.UTF-8')
    expect(screen.queryByRole('alert')).toBeNull()
    await save()
    await waitFor(() => expect(api.called('PUT', BASE('LANG'))).toHaveLength(1))
    expect(api.called('PUT', BASE('LANG'))[0].body).toEqual({ value: 'C.UTF-8' })
  })

  test('a new variable is runtime-only by default, and the scope chosen in the form is sent', async () => {
    const api = mockApi({ [ENV]: { variables: [], pending: idle }, [PUT('VITE_API_URL')]: answer(201, { key: 'VITE_API_URL', created: true, scope: 'build' }) })
    tab()
    expect(await screen.findByLabelText('Available in')).toHaveValue('runtime')
    await userEvent.type(screen.getByLabelText('Name'), 'VITE_API_URL')
    await userEvent.type(screen.getByLabelText('Value'), 'https://api.example.com')
    await userEvent.selectOptions(screen.getByLabelText('Available in'), 'build')
    await userEvent.click(screen.getByRole('button', { name: 'Add or update' }))
    await waitFor(() => expect(api.called('PUT', BASE('VITE_API_URL'))).toHaveLength(1))
    expect(api.called('PUT', BASE('VITE_API_URL'))[0].body).toEqual({ value: 'https://api.example.com', scope: 'build', buildAs: 'arg' })
  })

  test('on the add form too, build or both explains the baking; runtime does not', async () => {
    mockApi({ [ENV]: { variables: [], pending: idle } })
    tab()
    const select = await screen.findByLabelText('Available in')
    expect(screen.queryByText(/baked into the image/)).toBeNull()
    await userEvent.selectOptions(select, 'both')
    expect(screen.getByText(/declare it with ARG NAME/)).toBeInTheDocument()
    await userEvent.selectOptions(select, 'runtime')
    expect(screen.queryByText(/baked into the image/)).toBeNull()
  })

  test('on the add form a name that cannot be used at build time is refused before any request, and fine for runtime', async () => {
    const api = mockApi({ [ENV]: { variables: [], pending: idle } })
    tab()
    await userEvent.type(await screen.findByLabelText('Name'), 'LANG')
    await userEvent.selectOptions(screen.getByLabelText('Available in'), 'build')
    expect(screen.getByRole('alert')).toHaveTextContent(/LANG cannot be used at build time/)
    expect(screen.getByRole('button', { name: 'Add or update' })).toBeDisabled()
    await userEvent.selectOptions(screen.getByLabelText('Available in'), 'runtime')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Add or update' })).toBeEnabled()
    expect(api.called('PUT', BASE('LANG'))).toHaveLength(0)
  })

  test('the badge follows a change of scope', async () => {
    let scope = 'runtime'
    mockApi({ [ENV]: () => ({ variables: scoped(['A', scope]), pending: idle }), [PUT('A')]: () => { scope = 'build'; return { key: 'A', scope } } })
    tab()
    await screen.findByText('A')
    expect(badge('A')).toHaveTextContent('Runtime')
    await edit('A')
    await userEvent.selectOptions(screen.getByLabelText('Where A is available'), 'build')
    await save()
    await waitFor(() => expect(badge('A')).toHaveTextContent('Build'))
  })

  test('the page says an imported file is added as runtime variables', async () => {
    mockApi({ [ENV]: { variables: [], pending: idle } })
    tab()
    expect(await screen.findByText(/imported \.env file is added as runtime variables/)).toBeInTheDocument()
  })
})

describe('how a build variable is passed (argument or secret)', () => {
  const as = (key, scope, build_as) => ({ key, scope, build_as, value: '********', updated_at: '2026-10-19T11:00:00Z' })
  const PUT = (k) => `PUT /api/apps/${APP_ID}/env/${k}`
  const BASE = (k) => `/api/apps/${APP_ID}/env/${k}`
  const badge = (key) => within(screen.getByText(key).closest('td')).getByTestId('scope-badge')
  const edit = async (key) => userEvent.click(await screen.findByLabelText(`Edit ${key}`))
  const save = () => userEvent.click(screen.getByRole('button', { name: 'Save' }))

  test('the badge names a secret; an argument, and a variable from before this existed, keep the short labels', async () => {
    mockApi({ [ENV]: { variables: [as('S', 'build', 'secret'), as('SB', 'both', 'secret'), as('A', 'build', 'arg'), as('R', 'runtime', 'secret'), ...vars('OLD')], pending: idle } })
    tab()
    await screen.findByText('S')
    expect(['S', 'SB', 'A', 'R', 'OLD'].map((k) => badge(k).textContent)).toEqual(['Build secret', 'Build secret + runtime', 'Build', 'Runtime', 'Runtime'])
  })

  test('the choice is only offered when the variable reaches the build', async () => {
    mockApi({ [ENV]: { variables: [as('A', 'runtime', 'arg')], pending: idle } })
    tab()
    await edit('A')
    expect(screen.queryByLabelText('How A is passed to the build')).toBeNull()
    await userEvent.selectOptions(screen.getByLabelText('Where A is available'), 'both')
    expect(screen.getByLabelText('How A is passed to the build')).toHaveValue('arg')
    await userEvent.selectOptions(screen.getByLabelText('Where A is available'), 'runtime')
    expect(screen.queryByLabelText('How A is passed to the build')).toBeNull()
  })

  test('changing only how it is passed sends buildAs alone', async () => {
    const api = mockApi({ [ENV]: { variables: [as('NPM_TOKEN', 'build', 'arg')], pending: idle }, [PUT('NPM_TOKEN')]: { key: 'NPM_TOKEN', build_as: 'secret' } })
    tab()
    await edit('NPM_TOKEN')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await userEvent.selectOptions(screen.getByLabelText('How NPM_TOKEN is passed to the build'), 'secret')
    await save()
    await waitFor(() => expect(api.called('PUT', BASE('NPM_TOKEN'))).toHaveLength(1))
    expect(api.called('PUT', BASE('NPM_TOKEN'))[0].body).toEqual({ buildAs: 'secret' })
  })

  test('changing it and then changing it back is no change', async () => {
    mockApi({ [ENV]: { variables: [as('A', 'build', 'secret')], pending: idle } })
    tab()
    await edit('A')
    expect(screen.getByLabelText('How A is passed to the build')).toHaveValue('secret')
    await userEvent.selectOptions(screen.getByLabelText('How A is passed to the build'), 'arg')
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    await userEvent.selectOptions(screen.getByLabelText('How A is passed to the build'), 'secret')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  test('moving a secret to runtime sends the scope only: how it is passed means nothing there', async () => {
    const api = mockApi({ [ENV]: { variables: [as('A', 'build', 'secret')], pending: idle }, [PUT('A')]: { key: 'A', scope: 'runtime' } })
    tab()
    await edit('A')
    await userEvent.selectOptions(screen.getByLabelText('How A is passed to the build'), 'arg') // changed, then the scope is moved away
    await userEvent.selectOptions(screen.getByLabelText('Where A is available'), 'runtime')
    await save()
    await waitFor(() => expect(api.called('PUT', BASE('A'))).toHaveLength(1))
    expect(api.called('PUT', BASE('A'))[0].body).toEqual({ scope: 'runtime' })
  })

  test('an argument warns that the value is baked in; a secret says it is not, and shows the line for the Dockerfile with this name', async () => {
    mockApi({ [ENV]: { variables: [as('NPM_TOKEN', 'build', 'arg')], pending: idle } })
    tab()
    await edit('NPM_TOKEN')
    expect(screen.getByText(/baked into the image/)).toBeInTheDocument()
    expect(screen.queryByText('Not stored in the image')).toBeNull()
    await userEvent.selectOptions(screen.getByLabelText('How NPM_TOKEN is passed to the build'), 'secret')
    expect(screen.queryByText(/baked into the image/)).toBeNull()
    expect(screen.getByText('Not stored in the image')).toBeInTheDocument()
    expect(screen.getByText('RUN --mount=type=secret,id=NPM_TOKEN,env=NPM_TOKEN ...')).toBeInTheDocument()
    expect(screen.getByText(/Deploy without cache/)).toBeInTheDocument()
  })

  test('the line follows the name being typed, also after a rename', async () => {
    mockApi({ [ENV]: { variables: [as('OLD_NAME', 'build', 'secret')], pending: idle } })
    tab()
    await edit('OLD_NAME')
    await userEvent.clear(screen.getByLabelText('Name of OLD_NAME'))
    await userEvent.type(screen.getByLabelText('Name of OLD_NAME'), 'NEW_NAME')
    expect(screen.getByText('RUN --mount=type=secret,id=NEW_NAME,env=NEW_NAME ...')).toBeInTheDocument()
  })

  test('cancelling puts how it is passed back, and editing again starts from the saved state', async () => {
    mockApi({ [ENV]: { variables: [as('A', 'build', 'arg')], pending: idle } })
    tab()
    await edit('A')
    await userEvent.selectOptions(screen.getByLabelText('How A is passed to the build'), 'secret')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await edit('A')
    expect(screen.getByLabelText('How A is passed to the build')).toHaveValue('arg')
  })

  test('the add form offers it only for a build variable, defaults to an argument, and sends the choice', async () => {
    const api = mockApi({ [ENV]: { variables: [], pending: idle }, [PUT('NPM_TOKEN')]: answer(201, { key: 'NPM_TOKEN', created: true, scope: 'build', build_as: 'secret' }) })
    tab()
    await screen.findByLabelText('Available in')
    expect(screen.queryByLabelText('Passed to the build as')).toBeNull()
    await userEvent.selectOptions(screen.getByLabelText('Available in'), 'build')
    expect(screen.getByLabelText('Passed to the build as')).toHaveValue('arg')
    await userEvent.selectOptions(screen.getByLabelText('Passed to the build as'), 'secret')
    await userEvent.type(screen.getByLabelText('Name'), 'NPM_TOKEN')
    await userEvent.type(screen.getByLabelText('Value'), 'tok')
    expect(screen.getByText('RUN --mount=type=secret,id=NPM_TOKEN,env=NPM_TOKEN ...')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Add or update' }))
    await waitFor(() => expect(api.called('PUT', BASE('NPM_TOKEN'))).toHaveLength(1))
    expect(api.called('PUT', BASE('NPM_TOKEN'))[0].body).toEqual({ value: 'tok', scope: 'build', buildAs: 'secret' })
  })

  test('a runtime variable is added without buildAs, and the form goes back to an argument after adding', async () => {
    const api = mockApi({ [ENV]: { variables: [], pending: idle }, [PUT('A')]: answer(201, { key: 'A', created: true, scope: 'runtime' }), [PUT('B')]: answer(201, { key: 'B', created: true, scope: 'build' }) })
    tab()
    await screen.findByLabelText('Available in')
    await userEvent.selectOptions(screen.getByLabelText('Available in'), 'build')
    await userEvent.selectOptions(screen.getByLabelText('Passed to the build as'), 'secret')
    await userEvent.selectOptions(screen.getByLabelText('Available in'), 'runtime') // changed its mind
    await userEvent.type(screen.getByLabelText('Name'), 'A')
    await userEvent.type(screen.getByLabelText('Value'), '1')
    await userEvent.click(screen.getByRole('button', { name: 'Add or update' }))
    await waitFor(() => expect(api.called('PUT', BASE('A'))).toHaveLength(1))
    expect(api.called('PUT', BASE('A'))[0].body).toEqual({ value: '1', scope: 'runtime' })
    await userEvent.selectOptions(screen.getByLabelText('Available in'), 'build')
    expect(screen.getByLabelText('Passed to the build as')).toHaveValue('arg')
  })
})

describe('renaming a variable', () => {
  const scoped = (...pairs) => pairs.map(([key, scope]) => ({ key, scope, value: '********', updated_at: '2026-10-19T11:00:00Z' }))
  const PUT = (k) => `PUT /api/apps/${APP_ID}/env/${k}`
  const BASE = (k) => `/api/apps/${APP_ID}/env/${k}`
  const edit = async (key) => userEvent.click(await screen.findByLabelText(`Edit ${key}`))
  const nameField = (key) => screen.getByLabelText(`Name of ${key}`)
  const save = () => userEvent.click(screen.getByRole('button', { name: 'Save' }))
  const rename = async (key, to) => { await userEvent.clear(nameField(key)); await userEvent.type(nameField(key), to) }

  test('the dialog starts with the current name, and nothing can be saved until something changes', async () => {
    mockApi({ [ENV]: { variables: scoped(['OLD_NAME', 'runtime']), pending: idle } })
    tab()
    await edit('OLD_NAME')
    expect(nameField('OLD_NAME')).toHaveValue('OLD_NAME')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  test('a new name alone sends the new name alone: the server keeps the value and the scope', async () => {
    const api = mockApi({ [ENV]: { variables: scoped(['OLD_NAME', 'build']), pending: idle }, [PUT('OLD_NAME')]: { key: 'NEW_NAME', previous_key: 'OLD_NAME', created: false, scope: 'build' } })
    tab()
    await edit('OLD_NAME')
    await rename('OLD_NAME', 'NEW_NAME')
    await save()
    await waitFor(() => expect(api.called('PUT', BASE('OLD_NAME'))).toHaveLength(1))
    expect(api.called('PUT', BASE('OLD_NAME'))[0].body).toEqual({ newKey: 'NEW_NAME' })
  })

  test('a name, a value and a scope together are one request', async () => {
    const api = mockApi({ [ENV]: { variables: scoped(['A', 'runtime']), pending: idle }, [PUT('A')]: { key: 'B', previous_key: 'A', created: false, scope: 'both' } })
    tab()
    await edit('A')
    await rename('A', 'B')
    await userEvent.type(screen.getByLabelText('New value for A'), 'fresh')
    await userEvent.selectOptions(screen.getByLabelText('Where A is available'), 'both')
    await save()
    await waitFor(() => expect(api.called('PUT', BASE('A'))).toHaveLength(1))
    expect(api.called('PUT', BASE('A'))[0].body).toEqual({ newKey: 'B', value: 'fresh', scope: 'both' })
  })

  test('spaces around the name are ignored: only spaces added means nothing changed', async () => {
    mockApi({ [ENV]: { variables: scoped(['A', 'runtime']), pending: idle } })
    tab()
    await edit('A')
    await userEvent.type(nameField('A'), '   ')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  test('the new name is sent trimmed', async () => {
    const api = mockApi({ [ENV]: { variables: scoped(['A', 'runtime']), pending: idle }, [PUT('A')]: { key: 'B', created: false, scope: 'runtime' } })
    tab()
    await edit('A')
    await rename('A', '  B  ')
    await save()
    await waitFor(() => expect(api.called('PUT', BASE('A'))).toHaveLength(1))
    expect(api.called('PUT', BASE('A'))[0].body).toEqual({ newKey: 'B' })
  })

  test('says the running app keeps the old name until the next deployment', async () => {
    mockApi({ [ENV]: { variables: scoped(['A', 'runtime']), pending: idle } })
    tab()
    await edit('A')
    expect(screen.queryByText(/keeps the old name/)).toBeNull()
    await rename('A', 'B')
    expect(screen.getByText(/keeps the old name until the next deployment/)).toBeInTheDocument()
  })

  test.each([['1BAD'], ['has-dash'], ['has space'], ['']])('the name "%s" is refused before any request', async (bad) => {
    const api = mockApi({ [ENV]: { variables: scoped(['A', 'runtime']), pending: idle } })
    tab()
    await edit('A')
    await userEvent.clear(nameField('A'))
    if (bad) await userEvent.type(nameField('A'), bad)
    expect(screen.getByRole('alert')).toHaveTextContent(/letters, digits and underscore/)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(api.called('PUT', BASE('A'))).toHaveLength(0)
  })

  test('a build variable cannot be renamed to a name the build cannot use, a runtime one can', async () => {
    mockApi({ [ENV]: { variables: scoped(['BUILD_ONE', 'build'], ['RUN_ONE', 'runtime']), pending: idle } })
    tab()
    await edit('BUILD_ONE')
    await rename('BUILD_ONE', 'LANG')
    expect(screen.getByRole('alert')).toHaveTextContent(/LANG cannot be used at build time/)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await userEvent.selectOptions(screen.getByLabelText('Where BUILD_ONE is available'), 'runtime')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await edit('RUN_ONE')
    await rename('RUN_ONE', 'TZ')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  test('a name that is taken is refused by the API, shown, and the dialog stays open with what was typed', async () => {
    mockApi({ [ENV]: { variables: scoped(['A', 'runtime'], ['B', 'runtime']), pending: idle }, [PUT('A')]: answer(409, { error: 'A variable named B already exists', code: 'name_taken' }) })
    tab()
    await edit('A')
    await rename('A', 'B')
    await save()
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('A variable named B already exists'))
    expect(nameField('A')).toHaveValue('B')
  })

  test('cancel puts the name back, and editing again starts from the saved name', async () => {
    mockApi({ [ENV]: { variables: scoped(['A', 'runtime']), pending: idle } })
    tab()
    await edit('A')
    await rename('A', 'ELSE')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await edit('A')
    expect(nameField('A')).toHaveValue('A')
  })

  test('after a rename the list shows the new name', async () => {
    let name = 'OLD_NAME'
    mockApi({ [ENV]: () => ({ variables: scoped([name, 'runtime']), pending: idle }), [PUT('OLD_NAME')]: () => { name = 'NEW_NAME'; return { key: 'NEW_NAME', previous_key: 'OLD_NAME', created: false, scope: 'runtime' } } })
    tab()
    await edit('OLD_NAME')
    await rename('OLD_NAME', 'NEW_NAME')
    await save()
    expect(await screen.findByText('NEW_NAME')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('OLD_NAME')).toBeNull())
  })
})
