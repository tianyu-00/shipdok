import { ArrowUpCircle } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { UpdateDetails } from '@/components/update-details'
import { useVersion } from '@/lib/queries'

/** Next to the logo: the version this Shipdok runs, and "Update available" when a newer one is published. Pressing it says how to update. */
export function VersionIndicator() {
  const version = useVersion()
  if (!version.data) return null
  const { current, updateAvailable, latest } = version.data
  if (!current && !updateAvailable) return null
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label={updateAvailable ? `Version ${current ?? 'unknown'}, update ${latest} available` : `Version ${current}`}
          className="flex shrink-0 items-center gap-1.5 rounded-md py-0 pl-8 pr-1.5 text-xs leading-none sm:py-0.5 sm:pl-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground">
          {current && <span>v{current}</span>}
          {updateAvailable && (
            <span className="flex items-center gap-1 rounded-full border border-info/40 bg-info/10 px-2 py-0.5 font-medium text-info">
              <ArrowUpCircle className="size-3" aria-hidden="true" /><span className="hidden sm:inline">Update available</span>
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80"><UpdateDetails version={version.data} /></PopoverContent>
    </Popover>
  )
}
