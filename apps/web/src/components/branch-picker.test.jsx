import { describe, test, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BranchPicker } from './branch-picker'
import { mockApi, answer, renderWithProviders } from '@/test/utils'

beforeEach(() => vi.clearAllMocks())

const URL_OF = (repo) => `GET /api/github/branches?repo=${encodeURIComponent(repo)}`
const LIST = { defaultBranch: 'main', branches: ['main', 'develop', 'feature/login', 'feature/Logout', 'release'], truncated: false }

function Host({ repo = 'o/r', initial = 'main', onDefaultKnown }) {
  const [value, setValue] = useState(initial)
  return (
    <div>
      <label htmlFor="b">Branch</label>
      <BranchPicker id="b" repo={repo} value={value} onChange={setValue} onDefaultKnown={onDefaultKnown} />
      <output data-testid="value">{value}</output>
    </div>
  )
}
const show = (props, routes = { [URL_OF('o/r')]: LIST }) => {
  const api = mockApi(routes)
  const view = renderWithProviders(<Host {...props} />)
  return { api, view }
}
const picked = () => screen.getByTestId('value').textContent
const opened = async () => { await userEvent.click(await screen.findByRole('combobox')); return screen.findByRole('listbox') }
const names = (box) => within(box).getAllByRole('option').map((o) => o.textContent)

describe('before there is something to list', () => {
  test.each([[''], ['owner'], ['owner/'], ['a/b/c'], ['../x']])('with the repository "%s" it is a plain text box and nothing is asked of GitHub', async (repo) => {
    const { api } = show({ repo })
    const input = screen.getByLabelText('Branch')
    expect(input.tagName).toBe('INPUT')
    await userEvent.clear(input)
    await userEvent.type(input, 'dev')
    expect(picked()).toBe('dev')
    expect(api.calls.filter((c) => c.bare === '/api/github/branches')).toHaveLength(0)
  })
})

describe('listing the branches', () => {
  test('asks for the repository, shows "Loading branches…" while it waits, then the current branch in a combobox', async () => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const api = mockApi({ [URL_OF('o/r')]: async () => { await gate; return LIST } })
    renderWithProviders(<Host />)
    const loading = await screen.findByLabelText('Branch') // named by the form's label
    expect(loading).toBeDisabled()
    expect(loading).toHaveTextContent('Loading branches…')
    release()
    const box = await screen.findByRole('combobox')
    expect(box).toHaveTextContent('main')
    expect(api.called('GET', '/api/github/branches')).toHaveLength(1)
    expect(api.called('GET', '/api/github/branches')[0].path).toBe('/api/github/branches?repo=o%2Fr')
  })

  test('the list has every branch, the default one marked, and the current one selected', async () => {
    show({ initial: 'develop' })
    const list = await opened()
    expect(names(list)).toEqual(['main' + 'default', 'develop', 'feature/login', 'feature/Logout', 'release'])
    expect(within(list).getByText('default')).toBeInTheDocument()
    expect(within(list).getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true').map((o) => o.textContent)).toEqual(['develop'])
  })

  test('choosing one sets it and closes the list', async () => {
    show()
    const list = await opened()
    await userEvent.click(within(list).getByText('release'))
    expect(picked()).toBe('release')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByRole('combobox')).toHaveTextContent('release')
  })

  test('an empty value shows a prompt instead', async () => {
    show({ initial: '' })
    expect(await screen.findByRole('combobox')).toHaveTextContent('Choose a branch')
  })

  test('a repository without any branch says so', async () => {
    show({}, { [URL_OF('o/r')]: { defaultBranch: null, branches: [], truncated: false } })
    const list = await opened()
    expect(within(list).getByText(/no branches yet/)).toBeInTheDocument()
  })
})

describe('searching', () => {
  const search = () => screen.getByLabelText('Search branches')

  test('typing narrows the list, ignoring case', async () => {
    show()
    const list = await opened()
    await userEvent.type(search(), 'LOG')
    expect(names(list).filter((n) => !n.startsWith('Use'))).toEqual(['feature/login', 'feature/Logout'])
  })

  test('text that is not a branch offers to use it as typed, which sets it', async () => {
    show()
    const list = await opened()
    await userEvent.type(search(), 'brand-new')
    expect(names(list)).toEqual(['Use “brand-new”'])
    await userEvent.click(within(list).getByText(/Use/))
    expect(picked()).toBe('brand-new')
  })

  test('text that is exactly a branch offers no extra option', async () => {
    show()
    const list = await opened()
    await userEvent.type(search(), 'release')
    expect(names(list)).toEqual(['release'])
  })

  test('the search starts empty each time the list is opened', async () => {
    show()
    await opened()
    await userEvent.type(search(), 'rel')
    await userEvent.keyboard('{Escape}')
    await opened()
    expect(search()).toHaveValue('')
  })

  test('many matches: it says how many are left out and to keep typing', async () => {
    const many = Array.from({ length: 130 }, (_, i) => `b${String(i).padStart(3, '0')}`)
    show({ initial: 'b000' }, { [URL_OF('o/r')]: { defaultBranch: 'b000', branches: many, truncated: false } })
    const list = await opened()
    expect(within(list).getAllByRole('option')).toHaveLength(100)
    expect(screen.getByText(/30 more matches: keep typing to narrow the list/)).toBeInTheDocument()
  })

  test('a list that GitHub cut short says so', async () => {
    show({}, { [URL_OF('o/r')]: { ...LIST, truncated: true } })
    await opened()
    expect(screen.getByText(/Only the first 500 branches are listed/)).toBeInTheDocument()
  })
})

describe('the keyboard', () => {
  const search = () => screen.getByLabelText('Search branches')
  const activeName = () => document.getElementById(search().getAttribute('aria-activedescendant')).textContent

  test('the list opens on the current branch, the arrows move (and wrap), Enter chooses', async () => {
    show({ initial: 'develop' })
    await opened()
    expect(activeName()).toBe('develop')
    await userEvent.keyboard('{ArrowDown}')
    expect(activeName()).toBe('feature/login')
    await userEvent.keyboard('{ArrowUp}{ArrowUp}')
    expect(activeName()).toBe('maindefault')
    await userEvent.keyboard('{ArrowUp}')
    expect(activeName()).toBe('release') // wrapped round the top
    await userEvent.keyboard('{Enter}')
    expect(picked()).toBe('release')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  test('typing puts the highlight on the first match, so Enter takes it', async () => {
    show({ initial: 'main' })
    await opened()
    await userEvent.type(search(), 'feature/Lo{Enter}')
    expect(picked()).toBe('feature/login')
  })

  test('typing moves the highlight to the first match, even when it was further down, so Enter takes that one', async () => {
    show({ initial: 'develop' }) // the list opens on "develop", the second entry
    await opened()
    await userEvent.type(search(), 'feature/Lo')
    expect(activeName()).toBe('feature/login')
    await userEvent.keyboard('{Enter}')
    expect(picked()).toBe('feature/login')
  })

  test('Enter with only a typed name uses that name', async () => {
    show()
    await opened()
    await userEvent.type(search(), 'hotfix-9{Enter}')
    expect(picked()).toBe('hotfix-9')
  })

  test('Escape closes the list and changes nothing', async () => {
    show()
    await opened()
    await userEvent.type(search(), 'rel')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(picked()).toBe('main')
  })
})

describe('a branch that is not in the list', () => {
  test('says so, in case the name is wrong; a listed branch does not', async () => {
    show({ initial: 'old-branch' })
    expect(await screen.findByText(/“old-branch” is not among this repository's branches/)).toBeInTheDocument()
    const list = await opened()
    await userEvent.click(within(list).getByText('release'))
    expect(screen.queryByText(/is not among/)).toBeNull()
  })

  test('no such warning when the list was cut short: the branch may simply be further down', async () => {
    show({ initial: 'zzz' }, { [URL_OF('o/r')]: { ...LIST, truncated: true } })
    await screen.findByRole('combobox')
    expect(screen.queryByText(/is not among/)).toBeNull()
  })
})

describe('when the branches cannot be listed', () => {
  test('it is a text box again, with the reason and "Type the branch name."', async () => {
    show({}, { [URL_OF('o/r')]: answer(404, { error: 'GitHub has no such public repository, and the Shipdok GitHub App is not installed on it.', code: 'repo_not_found' }) })
    expect(await screen.findByText(/not installed on it\. Type the branch name\./)).toBeInTheDocument()
    const input = screen.getByLabelText('Branch')
    expect(input.tagName).toBe('INPUT')
    await userEvent.clear(input)
    await userEvent.type(input, 'dev')
    expect(picked()).toBe('dev') // typing always works
  })

  test('a rate limit says so', async () => {
    show({}, { [URL_OF('o/r')]: answer(502, { error: 'GitHub is limiting requests right now. Type the branch name, or try again in a few minutes.', code: 'rate_limited' }) })
    expect(await screen.findByText(/limiting requests right now/)).toBeInTheDocument()
  })

  test('an error with no message still has a plain one', async () => {
    mockApi({ [URL_OF('o/r')]: () => { throw new Error('network down') } })
    renderWithProviders(<Host />)
    expect(await screen.findByText(/Could not load the branches\. Type the branch name\./)).toBeInTheDocument()
  })
})

describe('knowing the default branch', () => {
  test('is reported once the list is loaded', async () => {
    const onDefaultKnown = vi.fn()
    show({ onDefaultKnown })
    await screen.findByRole('combobox')
    expect(onDefaultKnown).toHaveBeenCalledWith('main')
  })

  test('is not reported when the list could not be loaded', async () => {
    const onDefaultKnown = vi.fn()
    show({ onDefaultKnown }, { [URL_OF('o/r')]: answer(404, { error: 'x' }) })
    await screen.findByText(/Type the branch name/)
    expect(onDefaultKnown).not.toHaveBeenCalled()
  })

  test('is not reported when GitHub did not say which it is', async () => {
    const onDefaultKnown = vi.fn()
    show({ onDefaultKnown }, { [URL_OF('o/r')]: { defaultBranch: null, branches: ['a'], truncated: false } })
    await screen.findByRole('combobox')
    expect(onDefaultKnown).not.toHaveBeenCalled()
  })
})

describe('typing the repository', () => {
  test('is not asked of GitHub on every key: only the name it settles on', async () => {
    const api = mockApi({ [URL_OF('o/r')]: LIST, [URL_OF('o/rx')]: LIST, [URL_OF('o/rxy')]: LIST })
    const view = renderWithProviders(<Host repo="o/r" />)
    await screen.findByRole('combobox')
    view.rerender(view.wrap(<Host repo="o/rx" />))
    view.rerender(view.wrap(<Host repo="o/rxy" />))
    await waitFor(() => expect(api.called('GET', '/api/github/branches').map((c) => c.path)).toContain('/api/github/branches?repo=o%2Frxy'), { timeout: 2000 })
    expect(api.called('GET', '/api/github/branches').map((c) => c.path)).not.toContain('/api/github/branches?repo=o%2Frx')
  })

  test('a different repository loads its own list', async () => {
    const other = { defaultBranch: 'trunk', branches: ['trunk', 'x'], truncated: false }
    mockApi({ [URL_OF('o/r')]: LIST, [URL_OF('o/other')]: other })
    const view = renderWithProviders(<Host repo="o/r" initial="trunk" />)
    await screen.findByRole('combobox')
    view.rerender(view.wrap(<Host repo="o/other" initial="trunk" />))
    await waitFor(async () => expect(names(await opened())).toContain('trunkdefault'), { timeout: 2000 })
  })
})
