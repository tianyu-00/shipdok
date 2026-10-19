// What the dashboard does when this browser stops being signed in (logging out, or signing out everywhere):
// forget every answer so the next person at this screen sees nothing, and show the login form.
export function forgetSession(client) {
  client.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' })
  client.setQueryData(['auth'], (old) => ({ ...(old ?? {}), authenticated: false, username: null }))
}
