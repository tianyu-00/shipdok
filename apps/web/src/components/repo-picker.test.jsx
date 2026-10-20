import { describe, test, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RepoPicker } from './repo-picker'
import { mockApi, answer, renderWithProviders } from '@/test/utils'
import { useRepos } from '@/lib/queries'

beforeEach(() => vi.clearAllMocks())

const REPOS = { repos: [
  { fullName: 'tianyu-00/site', private: true, defaultBranch: 'trunk' },
  { fullName: 'tianyu-00/api', private: false, defaultBranch: 'main' },
  { fullName: 'acme/widgets', private: true, defaultBranch: 'main' },
] }

function Host({ initial = '' }) {
  const repos = useRepos()
  const [value, setValue] = useState(initial)
  return (
    <div>
      <label htmlFor="r">Repository</label>
      <RepoPicker id="r" value={value} onChange={setValue} repos={repos} />
      <output data-testid="value">{value}</output>
    </div>
  )
}
const show = (routes = { 'GET /api/github/repos': REPOS }, props) => { mockApi(routes); return renderWithProviders(<Host {...props} />) }
const picked = () => screen.getByTestId('value').textContent
const opened = async () => { await userEvent.click(await screen.findByRole('combobox')); return screen.findByRole('listbox') }
const options = (box) => within(box).getAllByRole('option').map((o) => o.textContent)
const search = () => screen.getByLabelText('Search repositories')

describe('before the repositories are known', () => {
  test('shows "Loading repositories…" while they load', async () => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    mockApi({ 'GET /api/github/repos': async () => { await gate; return REPOS } })
    renderWithProviders(<Host />)
    const loading = await screen.findByLabelText('Repository')
    expect(loading).toBeDisabled()
    expect(loading).toHaveTextContent('Loading repositories…')
    release()
    expect(await screen.findByRole('combobox')).toBeInTheDocument()
  })
})

describe('the list', () => {
  test('asks for a repository when none is chosen', async () => {
    show()
    expect(await screen.findByRole('combobox')).toHaveTextContent('Choose a repository')
  })

  test('has every repository the app can see, alphabetical, each marked private or public, with a count', async () => {
    show()
    const list = await opened()
    expect(options(list)).toEqual(['acme/widgetsprivate', 'tianyu-00/apipublic', 'tianyu-00/siteprivate'])
    expect(screen.getByText(/3 repositories the Shipdok GitHub App can see/)).toBeInTheDocument()
    expect(screen.getByText(/Paste a GitHub link or type owner\/name to use any public repository/)).toBeInTheDocument()
  })

  test('the chosen repository is shown with its badge, and has the check in the list', async () => {
    show({ 'GET /api/github/repos': REPOS }, { initial: 'tianyu-00/site' })
    const box = await screen.findByRole('combobox')
    expect(box).toHaveTextContent('tianyu-00/site')
    expect(box).toHaveTextContent('private')
    const list = await opened()
    expect(within(list).getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true').map((o) => o.textContent)).toEqual(['tianyu-00/siteprivate'])
  })

  test('a repository that is not in the list (typed earlier, public) is shown without a badge', async () => {
    show({ 'GET /api/github/repos': REPOS }, { initial: 'someone/else' })
    const box = await screen.findByRole('combobox')
    expect(box).toHaveTextContent('someone/else')
    expect(box).not.toHaveTextContent(/private|public/)
  })

  test('choosing one sets it and closes the list', async () => {
    show()
    const list = await opened()
    await userEvent.click(within(list).getByText('tianyu-00/api'))
    expect(picked()).toBe('tianyu-00/api')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  test('says so when the app can see no repository yet', async () => {
    show({ 'GET /api/github/repos': { repos: [] } })
    const list = await opened()
    expect(within(list).getByText('No repository matches.')).toBeInTheDocument()
    expect(screen.getByText(/cannot see any repository yet: install it on one from the GitHub page/)).toBeInTheDocument()
  })

  test('many repositories: only the first are drawn and it says to keep typing', async () => {
    const many = { repos: Array.from({ length: 130 }, (_, i) => ({ fullName: `o/r${String(i).padStart(3, '0')}`, private: false })) }
    show({ 'GET /api/github/repos': many })
    const list = await opened()
    expect(within(list).getAllByRole('option')).toHaveLength(100)
    expect(screen.getByText(/30 more matches: keep typing/)).toBeInTheDocument()
  })
})

describe('searching', () => {
  test('narrows the list, ignoring case', async () => {
    show()
    const list = await opened()
    await userEvent.type(search(), 'ACME')
    expect(options(list).filter((o) => !o.startsWith('Use'))).toEqual(['acme/widgetsprivate'])
  })

  test('an owner/name that is not listed is offered to use as typed (a public repository)', async () => {
    show()
    const list = await opened()
    await userEvent.type(search(), 'someone/else')
    expect(options(list)).toEqual(['Use “someone/else”'])
    await userEvent.click(within(list).getByText(/Use/))
    expect(picked()).toBe('someone/else')
  })

  test('a pasted GitHub link finds a listed repository, or offers the one it points at', async () => {
    show()
    await opened()
    await userEvent.click(search())
    await userEvent.paste('https://github.com/tianyu-00/site.git')
    expect(options(screen.getByRole('listbox'))).toEqual(['tianyu-00/siteprivate'])
    await userEvent.clear(search())
    await userEvent.paste('https://github.com/someone/else')
    expect(options(screen.getByRole('listbox'))).toEqual(['Use “someone/else”'])
  })

  test('text that cannot be a repository finds nothing and offers nothing', async () => {
    show()
    const list = await opened()
    await userEvent.type(search(), 'zzz')
    expect(within(list).getByText('No repository matches.')).toBeInTheDocument()
  })

  test('the search starts empty each time the list is opened', async () => {
    show()
    await opened()
    await userEvent.type(search(), 'acme')
    await userEvent.keyboard('{Escape}')
    await opened()
    expect(search()).toHaveValue('')
  })
})

describe('the keyboard', () => {
  test('arrows move (and wrap), Enter chooses, Escape closes without changing anything', async () => {
    show({ 'GET /api/github/repos': REPOS }, { initial: 'tianyu-00/api' })
    await opened()
    const active = () => document.getElementById(search().getAttribute('aria-activedescendant')).textContent
    expect(active()).toBe('tianyu-00/apipublic') // opens on the current one
    await userEvent.keyboard('{ArrowDown}')
    expect(active()).toBe('tianyu-00/siteprivate')
    await userEvent.keyboard('{ArrowDown}')
    expect(active()).toBe('acme/widgetsprivate') // wrapped round the bottom
    await userEvent.keyboard('{Enter}')
    expect(picked()).toBe('acme/widgets')
    await opened()
    await userEvent.keyboard('{Escape}')
    expect(picked()).toBe('acme/widgets')
  })

  test('typing then Enter takes the first match', async () => {
    show()
    await opened()
    await userEvent.type(search(), 'tianyu-00/s{Enter}')
    expect(picked()).toBe('tianyu-00/site')
  })

  test('the highlighted option is scrolled into view as the arrows move', async () => {
    const scrolled = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function () { scrolled.push(this.textContent) }
    try {
      show()
      await opened()
      scrolled.length = 0
      await userEvent.keyboard('{ArrowDown}')
      expect(scrolled.at(-1)).toBe('tianyu-00/apipublic')
    } finally {
      if (original) Element.prototype.scrollIntoView = original
      else delete Element.prototype.scrollIntoView
    }
  })
})

describe('without a GitHub App, or when the list cannot be loaded', () => {
  test.each([
    ['no GitHub App connected (501)', answer(501, { error: 'GitHub is not connected' })],
    ['a failure (500)', answer(500, { error: 'boom' })],
  ])('%s: a plain text box that still takes typing', async (_, reply) => {
    show({ 'GET /api/github/repos': reply })
    const input = await screen.findByPlaceholderText(/owner\/repo/)
    expect(input.tagName).toBe('INPUT')
    await userEvent.type(input, 'a/b')
    expect(picked()).toBe('a/b')
    expect(screen.queryByRole('combobox')).toBeNull()
  })
})
