import '@testing-library/jest-dom/vitest'
import { afterEach, expect, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

// For the Select (a button that opens a list): the value it is showing, kept on the button as data-value.
expect.extend({
  toHaveChosen(el, value) {
    const actual = el?.getAttribute?.('data-value')
    return { pass: actual === String(value), message: () => `expected the choice to be ${JSON.stringify(String(value))}, it is ${JSON.stringify(actual)}` }
  },
})

// jsdom lacks a few browser features that Radix UI and next-themes rely on.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.scrollIntoView ??= () => {}
window.matchMedia ??= (query) => ({
  matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
  document.documentElement.className = ''
})
