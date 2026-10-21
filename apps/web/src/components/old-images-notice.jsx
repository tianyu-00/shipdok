import { Link } from 'react-router-dom'
import { Eraser } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { useOldImages } from '@/lib/queries'
import { formatBytes } from '@/lib/format'

/** Only shown when the user set a size and the old images have reached it (the default is never). The clean-up itself is on the Storage page. */
export function OldImagesNotice() {
  const old = useOldImages()
  if (!old.data?.exceeded) return null
  return (
    <Alert className="border-warning/50 text-warning">
      <Eraser className="size-4" aria-hidden="true" />
      <AlertTitle>Old images are piling up</AlertTitle>
      <AlertDescription>
        Cleaning up could free about {formatBytes(old.data.reclaimableBytes)}.{' '}
        <Link to="/storage" className="font-medium underline">Clean up on the Storage page</Link>
      </AlertDescription>
    </Alert>
  )
}
