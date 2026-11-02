import { useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useBackups } from '@/lib/queries'
import { keptBackups } from '@/lib/backups'
import { DownloadDialog, ReclaimBackupDialog } from '@/components/backup-dialogs'
import { BackupTable, DeleteBackupDialog } from '@/components/backup-table'

/**
 * Backups of an app's data that no app's Settings tab lists any more: the app was deleted, or it has no persistent storage now. They are kept on purpose
 * (they may be the only copy), so they are shown here, where they can be downloaded or deleted. The card is not there at all when there are none.
 */
export default function KeptBackups() {
  const backups = useBackups()
  const [downloading, setDownloading] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [reclaiming, setReclaiming] = useState(null)
  const kept = keptBackups(backups.data)
  if (kept.length === 0) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Backups kept without an app</CardTitle>
        <CardDescription>
          These are backups of data that belonged to an app that has since been deleted, or that no longer has persistent storage, so no app page lists them.
          They stay until you delete them (for each app name only the newest ones are kept). Use Reclaim (the box icon) to put the data into an app, usually a new one: its storage paths are added to that app.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <BackupTable backups={kept} showApp onDownload={setDownloading} onDelete={setDeleting} onReclaim={setReclaiming} />
      </CardContent>
      {reclaiming && <ReclaimBackupDialog backup={reclaiming} onClose={() => setReclaiming(null)} />}
      {downloading && <DownloadDialog backup={downloading} onClose={() => setDownloading(null)} />}
      <DeleteBackupDialog backup={deleting} onClose={() => setDeleting(null)} />
    </Card>
  )
}
