import { Input } from '@/components/ui/input'
import { Field } from '@/components/field'
import { NativeSelect } from '@/components/native-select'
import { BUILD_METHOD_NAMES, COMMANDS } from '@/lib/build-method'

/**
 * How the image is made, and for Railpack the three optional commands. Shared by the create form and the Settings tab.
 * `idPrefix` keeps the field ids apart ('' on the create form, 's-' in Settings); `errors` is field -> message.
 */
export function BuildMethodFields({ idPrefix = '', values, onChange, errors = {} }) {
  const railpack = values.build_method === 'railpack'
  return (
    <>
      <Field id={`${idPrefix}build_method`} label="Build method"
        hint={railpack
          ? 'Railpack looks at the code, works out how to build it (Node, Python, Go, a static site...) and Shipdok builds that. A Dockerfile in the repository is not used.'
          : 'Builds the Dockerfile in the repository. Choose Railpack to deploy code that has none, or to let Railpack build it instead.'}>
        <NativeSelect id={`${idPrefix}build_method`} value={values.build_method} onChange={(v) => onChange('build_method', v)}>
          {Object.entries(BUILD_METHOD_NAMES).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
        </NativeSelect>
      </Field>
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
    </>
  )
}
