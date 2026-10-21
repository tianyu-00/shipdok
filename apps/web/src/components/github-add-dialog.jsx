import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { GithubConnectForm } from '@/components/github-connect-form'
import { GithubManualForm } from '@/components/github-manual-form'

/**
 * Add a GitHub app: have Shipdok create one (leaves for github.com and comes back), or enter one that already exists. `initialTab` 'existing' opens the
 * second way, and `initialAppId` fills in the App ID (when it is known from a refused push).
 */
export function GithubAddDialog({ open, onOpenChange, initialTab = 'create', initialAppId = '' }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a GitHub app</DialogTitle>
          <DialogDescription>Connect one for each GitHub account or organisation that has repositories you want to deploy.</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue={initialTab}>
          <TabsList>
            <TabsTrigger value="create">Create one for me</TabsTrigger>
            <TabsTrigger value="existing">I already have one</TabsTrigger>
          </TabsList>
          <TabsContent value="create"><GithubConnectForm /></TabsContent>
          <TabsContent value="existing"><GithubManualForm onDone={() => onOpenChange(false)} initialAppId={initialAppId} /></TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
