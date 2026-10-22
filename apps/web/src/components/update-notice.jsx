import { useState } from 'react'
import { ArrowUpCircle } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { UpdateDetails } from '@/components/update-details'
import { useVersion } from '@/lib/queries'
import { dismissedUpdate, dismissUpdate } from '@/lib/dismissed-update'

/** On the apps list while a newer Shipdok is published. Dismissing hides it for that version only (the badge next to the logo stays). */
export function UpdateNotice() {
  const version = useVersion()
  const [dismissed, setDismissed] = useState(dismissedUpdate)
  const v = version.data
  if (!v?.updateAvailable || dismissed === v.latest) return null
  return (
    <Alert className="border-info/50 text-info">
      <ArrowUpCircle className="size-4" aria-hidden="true" />
      <AlertTitle>Shipdok {v.latest} is available</AlertTitle>
      <AlertDescription>
        <p>You are running {v.current ?? 'an unknown version'}.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Popover>
            <PopoverTrigger asChild><Button variant="outline" size="sm">How to update</Button></PopoverTrigger>
            <PopoverContent align="start" className="w-80 text-foreground"><UpdateDetails version={v} /></PopoverContent>
          </Popover>
          <Button variant="ghost" size="sm" onClick={() => { dismissUpdate(v.latest); setDismissed(v.latest) }}>Dismiss</Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}
