// The browser side of "Connect GitHub". The app definition goes to GitHub in a normal form post (that is how GitHub's manifest flow
// works: the page leaves Shipdok for github.com, and GitHub sends the browser back with a one-time code).

/** Posts the manifest to GitHub. Refuses any address that is not github.com over https, so a wrong answer from the server cannot send it elsewhere. */
export function postManifest({ postUrl, manifest }) {
  let url
  try { url = new URL(postUrl) } catch { throw new Error('That is not a GitHub address') }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') throw new Error('The manifest can only be sent to GitHub')
  const form = document.createElement('form')
  form.method = 'post'
  form.action = url.toString()
  const field = document.createElement('input')
  field.type = 'hidden'
  field.name = 'manifest'
  field.value = JSON.stringify(manifest)
  form.append(field)
  document.body.append(form)
  try { form.submit() } finally { form.remove() }
}

const ORG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,33}$/

/** Why "Connect GitHub" cannot go ahead with these choices, or null. */
export function connectProblem({ kind, org, name }) {
  if (kind === 'org' && !ORG_RE.test(org.trim())) return 'Enter the organisation name as it appears on GitHub (letters, numbers and dashes)'
  if (name.trim() && !NAME_RE.test(name.trim())) return 'The app name must be 1-34 characters: letters, numbers, spaces, dot, dash, underscore'
  return null
}

/** Why the "I already have a GitHub App" form is not complete, or null. */
export function manualProblem({ appId, privateKey, webhookSecret, password }) {
  if (!appId.trim()) return 'Enter the app ID'
  if (!/^\d{1,20}$/.test(appId.trim())) return 'The app ID must be a number (the App ID on the app\'s settings page, not the Client ID)'
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) return 'Paste the private key: the whole .pem file, starting with -----BEGIN'
  if (!webhookSecret) return 'Enter the webhook secret'
  if (webhookSecret.length < 16) return 'The webhook secret must be at least 16 characters'
  if (!password) return 'Enter your current password'
  return null
}

const ERRORS = {
  login: 'Your session ended before GitHub sent you back. Log in and try connecting again.',
  state: 'This connection attempt expired or was started in another window. Start it again here.',
  exchange_failed: 'GitHub did not hand over the new app (the code may have been used or expired). Try again.',
  github_unreachable: 'Shipdok could not reach GitHub to finish connecting. Try again in a moment.',
  already_connected: 'GitHub was already connected, so nothing was changed. The new app was left on GitHub: delete it there if you do not want it.',
}
export const errorMessage = (code) => ERRORS[code] ?? 'Connecting GitHub did not finish. Try again.'

/** Where the app is installed on repositories (null without a usable slug). */
export const installUrl = (slug) => (typeof slug === 'string' && /^[A-Za-z0-9-]+$/.test(slug) ? `https://github.com/apps/${slug}/installations/new` : null)
