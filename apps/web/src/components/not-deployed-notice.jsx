import { Rocket } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

/** Creating an app only saves it: nothing is built or started until Deploy is pressed. Shown until the app has a deployment, whatever became of it. */
export function NotDeployedNotice({ app }) {
  if (app.latest_deployment !== null) return null // (not when it is missing from the answer: then nothing is known, and nothing is claimed)
  return (
    <Alert className="border-primary/40">
      <Rocket className="size-4" aria-hidden="true" />
      <AlertTitle>Not deployed yet</AlertTitle>
      <AlertDescription>Creating an app does not build or start it. Check the settings, add any variables it needs, then press Deploy when you are ready.</AlertDescription>
    </Alert>
  )
}
