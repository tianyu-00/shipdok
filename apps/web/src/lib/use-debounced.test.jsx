import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDebounced } from './use-debounced'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('useDebounced', () => {
  test('starts with the value it is given', () => {
    expect(renderHook(() => useDebounced('a', 400)).result.current).toBe('a')
  })

  test('follows a change only after the quiet time', () => {
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, 400), { initialProps: { v: 'a' } })
    rerender({ v: 'b' })
    act(() => { vi.advanceTimersByTime(399) })
    expect(result.current).toBe('a')
    act(() => { vi.advanceTimersByTime(1) })
    expect(result.current).toBe('b')
  })

  test('typing on keeps restarting the wait, and only the last value arrives', () => {
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, 400), { initialProps: { v: '' } })
    for (const v of ['o', 'ow', 'own', 'owner']) {
      rerender({ v })
      act(() => { vi.advanceTimersByTime(300) })
    }
    expect(result.current).toBe('')
    act(() => { vi.advanceTimersByTime(100) })
    expect(result.current).toBe('owner')
  })
})
