import { HardDrive } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { formatBytes } from '@/lib/format'

// Only shown when space is getting short; at "ok" there is nothing to say.
export function StorageBanner({ disk }) {
  if (!disk || disk.level === 'ok') return null
  const critical = disk.level === 'critical'
  return (
    <Alert variant={critical ? 'destructive' : 'default'} className={critical ? undefined : 'border-warning/50 text-warning'}>
      <HardDrive className="size-4" />
      <AlertTitle>{critical ? 'The disk is almost full' : 'The disk is getting full'}</AlertTitle>
      <AlertDescription>
        {disk.freePercent}% free ({formatBytes(disk.freeBytes)} of {formatBytes(disk.totalBytes)}).{' '}
        {critical ? 'New builds are held back until you free space: prune old images or delete old logs.' : 'Consider pruning old images or deleting old logs.'}
      </AlertDescription>
    </Alert>
  )
}
