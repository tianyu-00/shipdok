// Helping the administrator choose a good password. The authoritative checks (length, patterns, the username) run on
// the server; here is only what can be said while typing.

/** How much to trust a password by its length alone. Length is what counts; "clever" symbols add little. */
export function strength(password) {
  if (!password) return null
  const n = password.length
  if (n < 12) return { level: 0, label: 'Too short' }
  if (n < 16) return { level: 1, label: 'Acceptable' }
  if (n < 24) return { level: 2, label: 'Good' }
  return { level: 3, label: 'Strong' }
}
