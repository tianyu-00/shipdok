import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/field'
import { DEFAULT_METHOD, METHOD_CARDS } from '@/lib/build-methods'

function MethodCard({ card, selected, onChoose }) {
  return (
    <button
      type="button" role="radio" aria-checked={selected} disabled={!card.available} onClick={() => onChoose(card.id)}
      className={`flex flex-col gap-1.5 rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 ${
        selected ? 'border-primary bg-primary/5' : 'hover:border-primary/50'} ${card.available ? '' : 'cursor-not-allowed opacity-60'}`}
    >
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{card.title}</span>
        {!card.available && <Badge variant="secondary">Coming soon</Badge>}
        {card.id === DEFAULT_METHOD && <Badge variant="outline">Default</Badge>}
      </span>
      <span className="text-sm text-muted-foreground">{card.text}</span>
    </button>
  )
}

/** Step 2: where the app is in the repository, and how to build it. Nothing is guessed from the repository: the person chooses. */
export function MethodStep({ repo, rootDir, onRootDir, method, onMethod, onChangeRepo, onBack, onContinue }) {
  return (
    <div className="space-y-5">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Repository:</span> <strong>{repo}</strong>
        <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={onChangeRepo}>Change</Button>
      </p>

      <Field id="step_root_dir" label="Where is the app inside the repository?" hint="Leave . if it is in the top folder. If the repository holds several apps in folders, type the folder of this one, for example backend.">
        <Input id="step_root_dir" autoComplete="off" spellCheck={false} value={rootDir} onChange={(e) => onRootDir(e.target.value)} />
      </Field>

      <div className="space-y-2">
        <p className="text-sm font-medium" id="method-label">How should it be built?</p>
        <div role="radiogroup" aria-labelledby="method-label" className="grid gap-3 sm:grid-cols-2">
          {METHOD_CARDS.map((card) => <MethodCard key={card.id} card={card} selected={method === card.id} onChoose={onMethod} />)}
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onBack}>Back</Button>
        <Button type="button" disabled={!method} onClick={onContinue}>Continue</Button>
      </div>
    </div>
  )
}
