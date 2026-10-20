import { useEffect, useState } from 'react'

/** `value`, but only after it has stayed the same for `ms`: so a form that is being typed into does not ask the server on every key. */
export function useDebounced(value, ms = 400) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return debounced
}
