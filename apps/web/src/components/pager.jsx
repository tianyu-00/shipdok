import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/select'
import { PAGE_SIZES } from '@/lib/paging'

/** "Per page" and the Newer / Older buttons under a paged list. Shown only when there is more than the smallest page to show. */
export function Pager({ id, count, page, pages, size, onPage, onSize }) {
  if (pages <= 1 && count <= PAGE_SIZES[0]) return null
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="text-xs text-muted-foreground">Per page</label>
        <div className="w-24"><Select id={id} value={String(size)} onChange={(v) => onSize(Number(v))}>
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
        </Select></div>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="icon-sm" aria-label="Newer" title="Newer" disabled={page === 0} onClick={() => onPage(page - 1)}><ChevronLeft className="size-4" /></Button>
        <span className="text-xs text-muted-foreground" aria-live="polite">Page {page + 1} of {pages}</span>
        <Button variant="outline" size="icon-sm" aria-label="Older" title="Older" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}><ChevronRight className="size-4" /></Button>
      </div>
    </div>
  )
}
