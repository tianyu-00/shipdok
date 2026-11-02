export const PAGE_SIZES = [5, 10, 25, 50]
export const DEFAULT_PAGE_SIZE = 10

/** The page size remembered in this browser under `key`, or the default when there is none, it is not one of the choices, or storage is blocked. */
export function savedPageSize(key) {
  try {
    const n = Number(localStorage.getItem(key))
    return PAGE_SIZES.includes(n) ? n : DEFAULT_PAGE_SIZE
  } catch { return DEFAULT_PAGE_SIZE }
}

export function savePageSize(key, n) {
  try { localStorage.setItem(key, String(n)) } catch { /* private window or blocked storage: it is only a convenience */ }
}
