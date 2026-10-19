// The one place the dashboard talks to the API. Same origin: in development Vite forwards /api, in Docker nginx does,
// so the session cookie travels by itself and no CORS is involved.

export class ApiError extends Error {
  constructor(status, message, body = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body // the parsed JSON answer, which can carry more than the message (a disk warning, a list of problems)
  }
}

// Called when a request that needs a login is refused (the session ran out); the app then shows the login page.
let onUnauthorized = () => {}
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn ?? (() => {})
}

/**
 * @param {string} path   for example '/apps' (the /api prefix is added)
 * @param {{method?: string, body?: unknown, signal?: AbortSignal}} [options]
 */
export async function api(path, { method = 'GET', body, signal } = {}) {
  let res
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal,
    })
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    throw new ApiError(0, 'Cannot reach the Shipdok API. Is it running?')
  }

  if (res.status === 204) return null
  let data = null
  try {
    data = await res.json()
  } catch {
    /* an empty or non-JSON body */
  }
  if (!res.ok) {
    // /auth/* answers 401 for a wrong password; that is not "your session ran out".
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized()
    // The API refuses state-changing requests from an address it was not told about (WEB_ORIGIN). From a person's point of
    // view every button then "does nothing", so say what is wrong and how to fix it.
    if (res.status === 403 && data?.error === 'Origin not allowed') {
      throw new ApiError(403, `The server does not accept requests from this address (${window.location.origin}). Open the dashboard at the address set as WEB_ORIGIN, or add this one to WEB_ORIGIN in infrastructure/.env and restart the API.`, data)
    }
    throw new ApiError(res.status, data?.error ?? `The request failed (${res.status})`, data)
  }
  return data
}
