/**
 * The rule being edited: the draft, whether it differs from what is saved, and
 * what is wrong with it. Kept apart from the form so the sections stay plain
 * components that render fields and report changes.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Rule } from '../../../api/types'
import { splitKey } from '../../../lib/format'
import { BLANK_RULE } from '../use-rules'

export interface KeyParts {
  method: string
  host: string
  path: string
}

export function useRuleDraft(saved: Rule | undefined, isNew: boolean) {
  const [draft, setDraft] = useState<Rule>(saved ?? BLANK_RULE)
  const [keyParts, setKeyParts] = useState<KeyParts>(() => splitKey(saved?.key ?? 'GET:/'))
  const [jsonText, setJsonText] = useState(() => JSON.stringify(saved?.json_response ?? {}, null, 2))
  const [dirty, setDirty] = useState(false)
  const [jsonError, setJsonError] = useState<string | null>(null)
  /** What the server refused the last save with, for the field it is about. */
  const [serverError, setServerError] = useState<string | null>(null)

  useEffect(() => {
    setDraft(saved ?? BLANK_RULE)
    setKeyParts(splitKey(saved?.key ?? 'GET:/'))
    setJsonText(JSON.stringify(saved?.json_response ?? {}, null, 2))
    setDirty(false)
    setJsonError(null)
    setServerError(null)
  }, [saved?.key])

  const edit = useCallback((patch: Partial<Rule>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setDirty(true)
    // The server's complaint is about the script as it was, so editing the
    // script — or leaving the mode that has one — retires it.
    if ('script' in patch || 'mode' in patch) setServerError(null)
  }, [])

  const editKey = useCallback((patch: Partial<KeyParts>) => {
    setKeyParts((k) => ({ ...k, ...patch }))
    setDirty(true)
  }, [])

  const editJson = useCallback((text: string) => {
    setJsonText(text)
    setJsonError(null)
    setDirty(true)
  }, [])

  const key = useMemo(
    () => (isNew ? `${keyParts.method}:${keyParts.host}${keyParts.path}` : draft.key),
    [isNew, keyParts, draft.key]
  )

  /** The rule to send, or null with jsonError set when the body will not parse. */
  const build = useCallback((): Rule | null => {
    if (draft.mode !== 'json') return { ...draft, key }
    try {
      return { ...draft, key, json_response: JSON.parse(jsonText) }
    } catch (e) {
      setJsonError(`That is not valid JSON: ${(e as Error).message}`)
      return null
    }
  }, [draft, key, jsonText])

  return {
    draft, keyParts, jsonText, jsonError, serverError, dirty, key,
    edit, editKey, editJson, build, setDirty, setServerError,
  }
}
