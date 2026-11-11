export const PAGE_SIZES = [5, 10, 25, 50]
export const DEFAULT_PAGE_SIZE = 10

/** The page size remembered in this browser under `key`, or `fallback` (10 unless a list says otherwise) when there is none, it is not one of the choices, or storage is blocked. */
export function savedPageSize(key, fallback = DEFAULT_PAGE_SIZE) {
  try {
    const n = Number(localStorage.getItem(key))
    return PAGE_SIZES.includes(n) ? n : fallback
  } catch { return fallback }
}

export function savePageSize(key, n) {
  try { localStorage.setItem(key, String(n)) } catch { /* private window or blocked storage: it is only a convenience */ }
}

/** One page (0-based) of a list; a page past the end is the last one. Says how many pages there are and which one it really is. */
export function pageOf(items, page, size) {
  const pages = Math.max(1, Math.ceil(items.length / size))
  const at = Math.min(Math.max(0, page), pages - 1)
  return { items: items.slice(at * size, (at + 1) * size), page: at, pages }
}
