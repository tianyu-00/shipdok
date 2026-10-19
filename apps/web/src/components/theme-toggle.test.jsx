import { describe, test, expect } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeToggle } from './theme-toggle'
import { renderWithProviders } from '@/test/utils'

const choose = async (name) => {
  await userEvent.click(screen.getByRole('button', { name: 'Change theme' }))
  await userEvent.click(await screen.findByRole('menuitemradio', { name }))
}

describe('the theme', () => {
  test('offers light, dark and system', async () => {
    renderWithProviders(<ThemeToggle />)
    await userEvent.click(screen.getByRole('button', { name: 'Change theme' }))
    expect((await screen.findAllByRole('menuitemradio')).map((el) => el.textContent)).toEqual(['Light', 'Dark', 'System'])
  })

  test('dark puts the dark class on the page and is remembered', async () => {
    renderWithProviders(<ThemeToggle />)
    await choose('Dark')
    expect(document.documentElement).toHaveClass('dark')
    expect(localStorage.getItem('shipdok-theme')).toBe('dark')
  })

  test('light removes it', async () => {
    renderWithProviders(<ThemeToggle />)
    await choose('Dark')
    await choose('Light')
    expect(document.documentElement).not.toHaveClass('dark')
    expect(localStorage.getItem('shipdok-theme')).toBe('light')
  })

  test('a remembered choice is used on the next visit', () => {
    localStorage.setItem('shipdok-theme', 'dark')
    renderWithProviders(<ThemeToggle />)
    expect(document.documentElement).toHaveClass('dark')
  })

  test('system follows the operating system setting', async () => {
    window.matchMedia = (q) => ({ matches: q.includes('dark'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
    renderWithProviders(<ThemeToggle />)
    await choose('System')
    expect(localStorage.getItem('shipdok-theme')).toBe('system')
    expect(document.documentElement).toHaveClass('dark')
  })
})
