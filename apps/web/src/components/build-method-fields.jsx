import { Input } from '@/components/ui/input'
import { Field } from '@/components/field'
import { NativeSelect } from '@/components/native-select'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { BUILD_METHOD_NAMES, COMMANDS, STATIC_COMMANDS, STATIC_SERVER_NAMES } from '@/lib/build-method'

/**
 * How the image is made, and for Railpack the three optional commands, and for a static site the build, the folder, Node and the web server. Shared by the create form and the Settings tab.
 * `idPrefix` keeps the field ids apart ('' on the create form, 's-' in Settings); `errors` is field -> message. `selectable` false: the method was chosen
 * elsewhere (the second step of creating an app), so only what depends on it is shown.
 */
export function BuildMethodFields({ idPrefix = '', values, onChange, errors = {}, selectable = true }) {
  const railpack = values.build_method === 'railpack'
  const isStatic = values.build_method === 'static'
  return (
    <>
      {selectable && <Field id={`${idPrefix}build_method`} label="Build method"
        hint={railpack
          ? 'Railpack looks at the code, works out how to build it (Node, Python, Go, a static site...) and Shipdok builds that. A Dockerfile in the repository is not used.'
          : isStatic
            ? 'Serves files (HTML, CSS, JavaScript) with a small web server, after an optional build. A Dockerfile in the repository is not used.'
            : 'Builds the Dockerfile in the repository. Choose Railpack to deploy code that has none, or to let Railpack build it instead.'}>
        <NativeSelect id={`${idPrefix}build_method`} value={values.build_method} onChange={(v) => onChange('build_method', v)}>
          {Object.entries(BUILD_METHOD_NAMES).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
        </NativeSelect>
      </Field>}
      {railpack && (
        <>
          {COMMANDS.map(({ key, label, placeholder, hint }) => (
            <Field key={key} id={`${idPrefix}${key}`} label={label} hint={hint} error={errors[key]}>
              <Input id={`${idPrefix}${key}`} placeholder={`${placeholder} (Railpack decides)`} aria-invalid={errors[key] ? true : undefined} value={values[key]} onChange={(e) => onChange(key, e.target.value)} />
            </Field>
          ))}
          <p className="text-sm text-muted-foreground sm:col-span-2">
            With Railpack every build variable is passed as a build secret, and a variable cannot change what Railpack decides (such as the Node version):
            put that in the repository (package.json, .node-version or railpack.json). The commands run inside the build, like the steps of a Dockerfile.
          </p>
        </>
      )}
      {isStatic && (
        <>
          {STATIC_COMMANDS.map(({ key, label, placeholder, hint }) => (
            <Field key={key} id={`${idPrefix}${key}`} label={label} hint={hint} error={errors[key]}>
              <Input id={`${idPrefix}${key}`} placeholder={`${placeholder} (skipped when empty)`} aria-invalid={errors[key] ? true : undefined} value={values[key]} onChange={(e) => onChange(key, e.target.value)} />
            </Field>
          ))}
          <Field id={`${idPrefix}output_dir`} label="Output folder" error={errors.output_dir} hint="The folder that is served, inside the app's folder: where the build puts the site (dist for Vite, build for Create React App). Empty = the app's folder itself.">
            <Input id={`${idPrefix}output_dir`} placeholder="dist" autoComplete="off" spellCheck={false} aria-invalid={errors.output_dir ? true : undefined} value={values.output_dir} onChange={(e) => onChange('output_dir', e.target.value)} />
          </Field>
          <Field id={`${idPrefix}node_version`} label="Node version" error={errors.node_version} hint="Only used for the build. Empty = 22.">
            <Input id={`${idPrefix}node_version`} placeholder="22" autoComplete="off" spellCheck={false} aria-invalid={errors.node_version ? true : undefined} value={values.node_version} onChange={(e) => onChange('node_version', e.target.value)} />
          </Field>
          <Field id={`${idPrefix}static_server`} label="Web server" hint="Both run as a normal user, not root, and need a port of 1024 or more. Dot files such as .env and .git are never served.">
            <NativeSelect id={`${idPrefix}static_server`} value={values.static_server} onChange={(v) => onChange('static_server', v)}>
              {Object.entries(STATIC_SERVER_NAMES).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
            </NativeSelect>
          </Field>
          <div className="flex items-start gap-3 sm:col-span-2">
            <Switch id={`${idPrefix}spa_fallback`} className="mt-0.5" checked={values.spa_fallback} onCheckedChange={(v) => onChange('spa_fallback', v)} />
            <div className="space-y-1">
              <Label htmlFor={`${idPrefix}spa_fallback`}>Single-page app</Label>
              <p className="text-xs text-muted-foreground">An address with no file behind it shows index.html (what a React or Vite site needs when a page is refreshed). Off: it is a plain 404.</p>
            </div>
          </div>
          <p className="text-sm text-muted-foreground sm:col-span-2">
            With a static site every build variable is passed as a build secret, and only the install and build steps can read it. A variable used by the build ends up in the files
            you serve if the build puts it there, so keep secrets out of a front end. The commands run inside the build, like the steps of a Dockerfile.
          </p>
        </>
      )}
    </>
  )
}
