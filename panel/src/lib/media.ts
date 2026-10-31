import { useEffect, useState } from 'react'

/**
 * Traffic shows the open call in a column beside the list on a laptop and in a
 * dialog on a phone. Both are real components with their own backdrop and focus
 * behaviour, so the page renders one or the other rather than hiding one with a
 * class: a hidden dialog still lays its backdrop over the page.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const mql = matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    mql.addEventListener('change', onChange)
    onChange()
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/** Tailwind's lg, the width at which the sidebar stops being a drawer. */
export const useIsWide = () => useMediaQuery('(min-width: 64rem)')
