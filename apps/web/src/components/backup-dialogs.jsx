import { useState } from 'react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api } from '@/lib/api'
import { downloadBackup } from '@/lib/backups'
import { Field } from '@/components/field'

/** Asks for the password again (a backup holds every secret), then hands the file to the browser. */
export function DownloadDialog({ backup, onClose }) {
  const [password, setPassword] = useState('')
  const [problem, setProblem] = useState(null)
  const download = useMutation({
    mutationFn: () => downloadBackup(backup.id, password),
    onSuccess: () => { toast.success('The download has started'); onClose() },
    onError: (err) => setProblem(err.status === 403 ? 'That is not your current password' : err.message),
  })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={(e) => { e.preventDefault(); setProblem(null); download.mutate() }} noValidate className="space-y-4">
          <DialogHeader>
            <DialogTitle>Download this backup</DialogTitle>
            <DialogDescription>
              It holds {backup.kind === 'volumes' ? `all the data in the volumes of ${backup.appName ?? 'the app'}, which may include secrets` : 'every secret Shipdok has'}{backup.encrypted ? ', but it is encrypted with your backup passphrase, which you will need to open it' : ', and it is NOT encrypted: keep it somewhere private'}.
              Enter your password to download it.
            </DialogDescription>
          </DialogHeader>
          <Field id="download-password" label="Your password" error={problem}>
            <Input id="download-password" type="password" autoComplete="current-password" autoFocus aria-invalid={problem ? true : undefined} value={password} onChange={(e) => { setPassword(e.target.value); setProblem(null) }} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!password || download.isPending}>{download.isPending ? 'Downloading…' : 'Download'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Sets, changes or removes the passphrase new backups are encrypted with. */
export function PassphraseDialog({ enabled, onClose }) {
  const client = useQueryClient()
  const [passphrase, setPassphrase] = useState('')
  const [again, setAgain] = useState('')
  const [password, setPassword] = useState('')
  const [remembered, setRemembered] = useState(false)
  const [problem, setProblem] = useState({})
  const [removing, setRemoving] = useState(false)
  const save = useMutation({
    mutationFn: (value) => api('/backups/passphrase', { method: 'PUT', body: { password, passphrase: value } }),
    onSuccess: (data, value) => {
      client.setQueryData(['backups'], data)
      toast.success(value === null ? 'New backups will not be encrypted' : 'New backups will be encrypted with that passphrase')
      onClose()
    },
    onError: (err) => setProblem(err.status === 403 ? { password: 'That is not your current password' } : { form: err.message }),
  })
  const submit = (e) => {
    e.preventDefault()
    const p = {}
    if (removing) { setProblem({}); save.mutate(null); return }
    if (passphrase.length < 12) p.passphrase = 'Use at least 12 characters'
    else if (passphrase.length > 256) p.passphrase = 'Use at most 256 characters'
    else if (passphrase.trim() !== passphrase) p.passphrase = 'Do not start or end it with a space'
    if (again !== passphrase) p.again = 'The two are not the same'
    if (!password) p.password = 'Enter your password'
    setProblem(p)
    if (Object.keys(p).length === 0) save.mutate(passphrase)
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} noValidate className="space-y-4">
          <DialogHeader>
            <DialogTitle>{removing ? 'Stop encrypting backups' : enabled ? 'Change the backup passphrase' : 'Encrypt backups with a passphrase'}</DialogTitle>
            <DialogDescription>
              {removing
                ? 'New backups will be plain files (anyone who gets one can read every secret in it). Backups already made keep the passphrase they were made with.'
                : 'New backups are encrypted with it. It applies to the next backups only. Shipdok keeps it (encrypted) so scheduled backups can use it, but on a new machine it is the ONLY way to open a backup: if you forget it, those backups are lost.'}
            </DialogDescription>
          </DialogHeader>
          {!removing && (
            <>
              <Field id="backup-passphrase" label="Passphrase" error={problem.passphrase} hint="At least 12 characters. A few random words make a good one.">
                <Input id="backup-passphrase" type="password" autoComplete="new-password" aria-invalid={problem.passphrase ? true : undefined} value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
              </Field>
              <Field id="backup-passphrase-again" label="Passphrase again" error={problem.again}>
                <Input id="backup-passphrase-again" type="password" autoComplete="new-password" aria-invalid={problem.again ? true : undefined} value={again} onChange={(e) => setAgain(e.target.value)} />
              </Field>
            </>
          )}
          <Field id="backup-passphrase-password" label="Your password" error={problem.password}>
            <Input id="backup-passphrase-password" type="password" autoComplete="current-password" aria-invalid={problem.password ? true : undefined} value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {!removing && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={remembered} onChange={(e) => setRemembered(e.target.checked)} />
              <span>I have written the passphrase down somewhere safe</span>
            </label>
          )}
          {problem.form && <p role="alert" className="text-sm text-destructive">{problem.form}</p>}
          <DialogFooter className="sm:justify-between">
            {enabled && !removing
              ? <Button type="button" variant="ghost" className="text-destructive" onClick={() => { setRemoving(true); setProblem({}) }}>Stop encrypting…</Button>
              : <span />}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={save.isPending || (!removing && !remembered)}>{save.isPending ? 'Saving…' : removing ? 'Stop encrypting' : 'Save passphrase'}</Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
