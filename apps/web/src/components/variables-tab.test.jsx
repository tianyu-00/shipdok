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
    expect(api.called('PUT', `/api/apps/${APP_ID}/env/NEW_KEY`)[0].body).toEqual({ value: 'v@lue' })
    expect(screen.getByLabelText('Name')).toHaveValue('')
    expect(screen.getByLabelText('Value')).toHaveValue('')
  })

  test('the value field is a password field, so it is not shown over a shoulder', async () => {
    mockApi({ [ENV]: { variables: [], pending: idle } })
    tab()
    await screen.findByText('No variables yet')
    expect(screen.getByLabelText('Value')).toHaveAttribute('type', 'password')
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
