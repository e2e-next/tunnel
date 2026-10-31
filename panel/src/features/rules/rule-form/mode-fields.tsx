/**
 * The fields that belong to the chosen mode, and nothing else: a rule in JSON
 * mode has no business showing a replay strategy. Each mode's block sits next
 * to the radio that picks it, so the consequence of the choice is visible.
 */
import { Description, ErrorMessage, Field, Label } from '../../../components/fieldset'
import { Input } from '../../../components/input'
import { Listbox, ListboxDescription, ListboxLabel, ListboxOption } from '../../../components/listbox'
import { Radio, RadioField, RadioGroup } from '../../../components/radio'
import { Textarea } from '../../../components/textarea'
import type { Rule, RuleMode } from '../../../api/types'

const MODES: { value: RuleMode; label: string; hint: string }[] = [
  { value: 'json', label: 'JSON', hint: 'Answer with a body you write here.' },
  {
    value: 'script',
    label: 'Script',
    hint: 'Answer from a JavaScript handler, so the response can depend on the query, the headers or how many times it has been called.',
  },
  { value: 'replay', label: 'Replay', hint: 'Answer from what a session recorded.' },
  { value: 'passthrough', label: 'Passthrough', hint: 'Forward to the real server, or to another address.' },
]

const STRATEGIES = [
  { value: 'match', label: 'Match the request', hint: 'Pick the recording whose query matches; the newest wins a tie.' },
  { value: 'sequence', label: 'In order', hint: 'Hand them back one at a time, in the order they were recorded.' },
  { value: 'last', label: 'The last one', hint: 'Always answer with the most recent recording.' },
]

export function ModeFields({
  draft,
  jsonText,
  jsonError,
  scriptError,
  sessions,
  currentSession,
  onEdit,
  onEditJson,
}: {
  draft: Rule
  jsonText: string
  jsonError: string | null
  /** What the server said about this script, line number and all. */
  scriptError: string | null
  sessions: Record<string, number>
  currentSession: string
  onEdit: (patch: Partial<Rule>) => void
  onEditJson: (text: string) => void
}) {
  return (
    <>
      <RadioGroup value={draft.mode} onChange={(mode) => onEdit({ mode: mode as RuleMode })}>
        {MODES.map((m) => (
          <RadioField key={m.value}>
            <Radio value={m.value} />
            <Label>{m.label}</Label>
            <Description>{m.hint}</Description>
          </RadioField>
        ))}
      </RadioGroup>

      {draft.mode === 'json' && (
        <Field>
          <Label>Response body</Label>
          <Textarea
            rows={12}
            value={jsonText}
            invalid={!!jsonError}
            onChange={(e) => onEditJson(e.target.value)}
            className="[&_textarea]:!font-mono [&_textarea]:!text-xs"
          />
          {jsonError ? <ErrorMessage>{jsonError}</ErrorMessage> : <Description>Sent as JSON.</Description>}
        </Field>
      )}

      {draft.mode === 'script' && (
        <Field>
          <Label>Handler</Label>
          <Textarea
            rows={16}
            value={draft.script}
            invalid={!!scriptError}
            onChange={(e) => onEdit({ script: e.target.value })}
            className="[&_textarea]:!font-mono [&_textarea]:!text-xs"
          />
          {scriptError ? (
            <ErrorMessage>{scriptError}</ErrorMessage>
          ) : (
            <Description>
              A JavaScript <span className="font-mono">handler(ctx)</span>. It reads ctx.query,
              ctx.headers, ctx.json and ctx.state, and returns an object or array for JSON,
              a string, or ctx.reply(body, status, headers).
              A syntax error is reported here with its line.
            </Description>
          )}
        </Field>
      )}

      {draft.mode === 'replay' && (
        <>
          <Field>
            <Label>Session</Label>
            <Listbox
              value={draft.replay_session}
              onChange={(session: string) => onEdit({ replay_session: session })}
            >
              <ListboxOption value="">
                <ListboxLabel>Follow the current session</ListboxLabel>
                <ListboxDescription>{currentSession}</ListboxDescription>
              </ListboxOption>
              {/*
                `sessions` now carries the names replay rules pin, recorded or
                not, so this is no longer the only thing standing between
                `tunnel set --session acct_a` and an empty-looking field. It
                stays for two reasons. This component is handed `sessions` as a
                prop and shows it: that the options cover the value is its own
                invariant, not something to borrow from a hook two layers up.
                And one case is still only covered here — `replay_session`
                survives a rule being switched to another mode, the shared set
                takes only rules whose mode is `replay`, so a json rule still
                carrying a name renders through this option the moment the draft
                goes back to Replay.
              */}
              {draft.replay_session && !(draft.replay_session in sessions) && (
                <ListboxOption value={draft.replay_session}>
                  <ListboxLabel className="font-mono">{draft.replay_session}</ListboxLabel>
                  <ListboxDescription>No recordings yet</ListboxDescription>
                </ListboxOption>
              )}
              {Object.entries(sessions).map(([name, count]) => (
                <ListboxOption key={name} value={name}>
                  <ListboxLabel className="font-mono">{name}</ListboxLabel>
                  <ListboxDescription>{count} recorded</ListboxDescription>
                </ListboxOption>
              ))}
            </Listbox>
          </Field>
          <Field>
            <Label>Which recording</Label>
            <RadioGroup
              value={draft.replay_strategy}
              onChange={(s) => onEdit({ replay_strategy: s as Rule['replay_strategy'] })}
            >
              {STRATEGIES.map((s) => (
                <RadioField key={s.value}>
                  <Radio value={s.value} />
                  <Label>{s.label}</Label>
                  <Description>{s.hint}</Description>
                </RadioField>
              ))}
            </RadioGroup>
          </Field>
        </>
      )}

      {draft.mode === 'passthrough' && (
        <Field>
          <Label>Target</Label>
          <Input
            placeholder="http://127.0.0.1:9001"
            value={draft.target}
            onChange={(e) => onEdit({ target: e.target.value })}
            className="[&_input]:!font-mono [&_input]:!text-xs"
          />
          <Description>Empty forwards to the host the client asked for.</Description>
        </Field>
      )}
    </>
  )
}
