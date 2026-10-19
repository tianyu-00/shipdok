// Public access settings: what can be checked while typing (the server checks again), and the address GitHub is given.

/** Why the typed address will not do, in words, or null. An empty address means "none" and is fine. */
export function publicUrlProblem(text) {
  const v = text.trim()
  if (!v) return null
  if (!/^https?:\/\//i.test(v)) return 'The address must start with https:// (or http://), for example https://shipdok.example.com'
  let url
  try {
    url = new URL(v)
  } catch {
    return 'That does not look like an address'
  }
  if (url.username || url.password) return 'Leave out the user name and password'
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return 'Give only the address, without a path (for example https://shipdok.example.com)'
  return null
}

/** Where GitHub delivers pushes, for an address (null when there is none). */
export const webhookUrl = (publicUrl) => (publicUrl ? `${publicUrl.replace(/\/+$/, '')}/api/webhooks/github` : null)
