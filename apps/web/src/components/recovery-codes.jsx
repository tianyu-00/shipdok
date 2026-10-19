import { useState } from 'react'
import { Copy, Download, Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { downloadCodes, printCodes } from '@/lib/recovery'

/**
 * The ten recovery codes, shown once. There is no way back to this screen: the server keeps only hashes. The person
 * has to say they saved them before it can be closed.
 */
export function RecoveryCodes({ codes, onDone }) {
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const [blocked, setBlocked] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'))
      setCopied(true)
    } catch {
      /* they are on screen: select them by hand */
    }
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        If you forget your password, one of these codes lets you set a new one. Each code works once. This is the only time they are
        shown: save them somewhere safe, such as a password manager or a printout. Anyone who has one can take over your account.
      </p>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-nowrap">
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={copy}><Copy className="size-4" aria-hidden="true" />{copied ? 'Copied' : 'Copy'}</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => downloadCodes(codes)}><Download className="size-4" aria-hidden="true" />Download</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setBlocked(!printCodes(codes))}><Printer className="size-4" aria-hidden="true" />Print</Button>
      </div>
      {blocked && <p role="alert" className="text-sm text-destructive">The browser blocked the print window. Allow pop-ups for this page, or use Download.</p>}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="size-4" />
        I have saved these codes
      </label>
      <Button type="button" disabled={!saved} onClick={onDone}>Done</Button>
    </div>
  )
}
