import { useEffect } from 'react'

// Where /api/docs sends a browser that was not signed in: the dashboard shows its login form here (App.jsx), and once the administrator is
// in, this goes on to the API reference. The link is there in case the browser does not follow.
export default function ApiDocsPage() {
  useEffect(() => { window.location.replace('/api/docs') }, [])
  return (
    <p className="text-sm text-muted-foreground" role="status">
      Opening the <a className="underline" href="/api/docs">API reference</a>…
    </p>
  )
}
