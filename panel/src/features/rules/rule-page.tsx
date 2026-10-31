/**
 * One rule, in full. Laid out as a settings page because a rule has more fields
 * than fit a dialog and several need a sentence of explanation. Saving is
 * explicit: the moment it lands, clients see a different answer.
 */
import { ChevronLeftIcon } from '@heroicons/react/16/solid'
import { useState } from 'react'
import { Alert, AlertActions, AlertDescription, AlertTitle } from '../../components/alert'
import { Badge } from '../../components/badge'
import { Button } from '../../components/button'
import { Description, Field, Label } from '../../components/fieldset'
import { Divider } from '../../components/divider'
import { Heading } from '../../components/heading'
import { Input } from '../../components/input'
import { Select } from '../../components/select'
import { Switch } from '../../components/switch'
import { Text } from '../../components/text'
import { modeColor } from '../../lib/format'
import { go } from '../../router'
import { FormSection } from '../../ui/form-section'
import { useToasts } from '../notifications/use-toasts'
import { useSessions } from '../session/use-sessions'
import { ModeFields } from './rule-form/mode-fields'
import { FaultFields, ResponseFields } from './rule-form/response-fields'
import { useRuleDraft } from './rule-form/use-rule-draft'
import { useRules } from './use-rules'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

export function RulePage({ param }: { param: string }) {
  const { find, hits, save, remove, resetState } = useRules()
  const { sessions, current } = useSessions()
  const { failed } = useToasts()
  const isNew = param === 'new'
  const saved = isNew ? undefined : find(param)
  const form = useRuleDraft(saved, isNew)
  const [deleting, setDeleting] = useState(false)

  if (!isNew && !saved) {
    return (
      <>
        <Heading>Rule not found</Heading>
        <Text className="!mt-2">
          No rule goes by <span className="font-mono text-xs">{param}</span>. It may have been
          deleted.
        </Text>
        <Button className="mt-6" href="#/rules">Back to rules</Button>
      </>
    )
  }

  const { draft, keyParts, key } = form

  async function submit() {
    const rule = form.build()
    if (!rule) return
    const err = await save(rule, isNew ? 'Rule created' : 'Rule saved')
    if (err) {
      // A script the server cannot compile is refused with the line number in
      // it, and that belongs on the field it is about rather than in a toast
      // across the page. Everything else has no field to go on.
      if (draft.mode === 'script' && /script syntax error/i.test(err.message)) {
        form.setServerError(err.message)
      } else {
        failed('Could not save the rule', err)
      }
      return
    }
    form.setDirty(false)
    if (isNew) go('/rules')
  }

  async function duplicate() {
    const err = await save({ ...draft, key: `${draft.key}.copy` }, 'Rule duplicated')
    if (err) failed('Could not save the rule', err)
  }

  return (
    <>
      <div className="max-lg:hidden">
        <a
          href="#/rules"
          className="inline-flex items-center gap-2 text-sm/6 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          <ChevronLeftIcon className="size-4 fill-zinc-400" />
          Rules
        </a>
      </div>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-4 lg:mt-8">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <Heading className="!font-mono !text-xl/8 break-all">{isNew ? 'New rule' : draft.key}</Heading>
            <Badge color={modeColor[draft.mode]}>{draft.mode}</Badge>
          </div>
          {!isNew && (
            <Text className="!mt-1 !text-sm/6">
              {hits(draft.key)} hit{hits(draft.key) === 1 ? '' : 's'} in the log
              {draft.description && ` · ${draft.description}`}
            </Text>
          )}
        </div>
        <div className="flex items-center gap-4">
          <Switch
            checked={draft.enabled}
            aria-label="Enabled"
            onChange={(on) => form.edit({ enabled: on })}
          />
          {!isNew && (
            <>
              <Button outline onClick={duplicate}>
                Duplicate
              </Button>
              <Button plain onClick={() => resetState(draft.key)}>Reset state</Button>
              <Button plain className="!text-rose-600 dark:!text-rose-400" onClick={() => setDeleting(true)}>
                Delete
              </Button>
            </>
          )}
        </div>
      </div>

      <Divider className="my-10" />

      <FormSection title="Key" hint="Which calls this rule answers. A * matches any host or any part of a path.">
        {isNew ? (
          <>
            <div className="flex gap-3">
              <Field className="w-32">
                <Label>Method</Label>
                <Select value={keyParts.method} onChange={(e) => form.editKey({ method: e.target.value })}>
                  {METHODS.map((m) => <option key={m}>{m}</option>)}
                </Select>
              </Field>
              <Field className="flex-1">
                <Label>Host</Label>
                <Input
                  placeholder="any host"
                  value={keyParts.host}
                  onChange={(e) => form.editKey({ host: e.target.value })}
                  className="[&_input]:!font-mono [&_input]:!text-xs"
                />
              </Field>
            </div>
            <Field>
              <Label>Path</Label>
              <Input
                placeholder="/v5/feed"
                value={keyParts.path}
                onChange={(e) => form.editKey({ path: e.target.value })}
                className="[&_input]:!font-mono [&_input]:!text-xs"
              />
              <Description>
                Becomes <span className="font-mono">{key}</span>
              </Description>
            </Field>
          </>
        ) : (
          <Field>
            <Input
              readOnly
              aria-label="Key"
              value={draft.key}
              className="[&_input]:!font-mono [&_input]:!text-xs"
            />
            <Description>Duplicate the rule to answer a different endpoint.</Description>
          </Field>
        )}
      </FormSection>

      <Divider className="my-10" soft />

      <FormSection title="Mode" hint="Where the answer comes from.">
        <ModeFields
          draft={draft}
          jsonText={form.jsonText}
          jsonError={form.jsonError}
          scriptError={form.serverError}
          sessions={sessions}
          currentSession={current}
          onEdit={form.edit}
          onEditJson={form.editJson}
        />
      </FormSection>

      <Divider className="my-10" soft />

      <FormSection title="Response" hint="What goes back on the wire, whichever mode answers.">
        <ResponseFields draft={draft} onEdit={form.edit} />
      </FormSection>

      <Divider className="my-10" soft />

      <FormSection title="Fault" hint="Break the response on purpose, to see what the client does.">
        <FaultFields draft={draft} onEdit={form.edit} />
      </FormSection>

      <Divider className="my-10" soft />

      <FormSection title="Note" hint="A line for the next person, or for you next week.">
        <Field>
          <Input
            aria-label="Note"
            value={draft.description}
            placeholder="The payment-required branch"
            onChange={(e) => form.edit({ description: e.target.value })}
          />
        </Field>
      </FormSection>

      <div className="sticky bottom-0 -mx-6 mt-10 flex justify-end gap-4 border-t border-zinc-950/10 bg-white px-6 py-4 lg:-mx-10 lg:px-10 dark:border-white/10 dark:bg-zinc-900">
        <Button plain href="#/rules">Cancel</Button>
        <Button onClick={submit} disabled={!form.dirty && !isNew}>
          {isNew ? 'Create rule' : 'Save changes'}
        </Button>
      </div>

      <Alert open={deleting} onClose={() => setDeleting(false)}>
        <AlertTitle>Delete this rule?</AlertTitle>
        <AlertDescription>
          <span className="font-mono text-xs">{draft.key}</span> stops answering, and calls to it
          go wherever the current mode sends them.
        </AlertDescription>
        <AlertActions>
          <Button plain onClick={() => setDeleting(false)}>Cancel</Button>
          <Button color="red" onClick={() => { remove(draft.key); go('/rules') }}>Delete rule</Button>
        </AlertActions>
      </Alert>
    </>
  )
}
