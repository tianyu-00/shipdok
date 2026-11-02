import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { Select } from '@/components/select'

function Harness({ initial = 'b', onChange = () => {}, disabled, withPlaceholder }) {
  const [v, setV] = useState(initial)
  return (
    <Select id="s" label="Fruit" value={v} disabled={disabled} onChange={(x) => { setV(x); onChange(x) }}>
      {withPlaceholder && <option value="__none" disabled>Pick one…</option>}
      <option value="a">Apple</option>
      <option value="b">Banana</option>
      <option value="">Nothing</option>
    </Select>
  )
}
const button = () => screen.getByRole('combobox', { name: 'Fruit' })

describe('Select', () => {
  test('shows the chosen option on the button, with no search box, and lists every option when opened', async () => {
    render(<Harness />)
    expect(button()).toHaveTextContent('Banana')
    expect(button()).toHaveAttribute('data-value', 'b')
    await userEvent.click(button())
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Apple', 'Banana', 'Nothing'])
    expect(screen.getByRole('option', { name: 'Banana' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('option', { name: 'Apple' })).toHaveAttribute('aria-selected', 'false')
  })

  test('choosing an option sends its value (an empty one too) and closes the list', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await userEvent.click(button())
    await userEvent.click(screen.getByRole('option', { name: 'Apple' }))
    expect(onChange).toHaveBeenLastCalledWith('a')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(button()).toHaveTextContent('Apple')
    await userEvent.click(button())
    await userEvent.click(screen.getByRole('option', { name: 'Nothing' }))
    expect(onChange).toHaveBeenLastCalledWith('')
    expect(button()).toHaveAttribute('data-value', '')
  })

  test('the keyboard works on the list itself: arrows move (wrapping), Enter or Space chooses, Escape closes without a change', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await userEvent.click(button())
    expect(screen.getByRole('listbox')).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}{Enter}') // from Banana to the next: Nothing
    expect(onChange).toHaveBeenLastCalledWith('')
    await userEvent.click(button())
    await userEvent.keyboard('{ArrowDown}{ }') // wraps from Nothing to Apple
    expect(onChange).toHaveBeenLastCalledWith('a')
    await userEvent.click(button())
    await userEvent.keyboard('{ArrowUp}') // wraps from Apple to Nothing
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  test('a disabled option is a placeholder: shown while it is the value, never offered', async () => {
    render(<Harness initial="__none" withPlaceholder />)
    expect(button()).toHaveTextContent('Pick one…')
    await userEvent.click(button())
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Apple', 'Banana', 'Nothing'])
  })

  test('a disabled select does not open', async () => {
    render(<Harness disabled />)
    expect(button()).toBeDisabled()
    await userEvent.click(button())
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
