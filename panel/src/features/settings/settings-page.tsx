/**
 * What is set once and then left alone. What a run switches lives in the
 * sidebar instead, which is why this page can save explicitly without being in
 * anyone's way.
 */
import { DescriptionDetails, DescriptionList, DescriptionTerm } from '../../components/description-list'
import { Button } from '../../components/button'
import { Description, ErrorMessage, Field, Label } from '../../components/fieldset'
import { Divider } from '../../components/divider'
import { Heading } from '../../components/heading'
import { Input } from '../../components/input'
import { Radio, RadioField, RadioGroup } from '../../components/radio'
import { Switch, SwitchField } from '../../components/switch'
import { Code, Text } from '../../components/text'
import type { Config } from '../../api/types'
import { ChipList } from '../../ui/chip-list'
import { FormSection } from '../../ui/form-section'
import { useSettings } from './use-settings'

export function SettingsPage() {
  const { draft, edit, errors, valid, dirty, saving, save, reset, health, ca } = useSettings()

  return (
    <form
      className="mx-auto max-w-4xl"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <Heading>Settings</Heading>
      <Text className="!mt-1">
        Set once and left alone. The session, the mode and recording are in the sidebar,
        because a run switches those.
      </Text>

      <Divider className="my-10" />

      <FormSection
        title="Default mode"
        hint="What happens to an endpoint no rule covers. The sidebar switches the same value."
      >
        <RadioGroup
          value={draft.default_mode}
          onChange={(mode) => edit({ default_mode: mode as Config['default_mode'] })}
        >
          <RadioField>
            <Radio value="passthrough" />
            <Label>Live</Label>
            <Description>The call reaches the real server.</Description>
          </RadioField>
          <RadioField>
            <Radio value="replay" />
            <Label>Replay</Label>
            <Description>
              The call is answered from the current session's recordings, and refused if
              nothing was recorded for it.
            </Description>
          </RadioField>
        </RadioGroup>
      </FormSection>

      <Divider className="my-10" soft />

      <FormSection title="Replay" hint="How a replayed response announces itself.">
        <SwitchField>
          <Label>Mark replayed responses</Label>
          <Description>
            Adds an <Code className="!text-xs">x-tunnel-replay</Code> header, so a client or a
            test can tell a replay from a live answer.
          </Description>
          <Switch checked={draft.replay_marker} onChange={(on) => edit({ replay_marker: on })} />
        </SwitchField>
      </FormSection>

      <Divider className="my-10" soft />

      <FormSection title="Log" hint="How much traffic the panel keeps, and what it records automatically.">
        <Field>
          <Label>Calls kept</Label>
          <Input
            type="number"
            value={draft.max_requests_history}
            invalid={!!errors.max_requests_history}
            onChange={(e) => edit({ max_requests_history: Number(e.target.value) })}
            className="max-w-40"
          />
          {errors.max_requests_history ? (
            <ErrorMessage>{errors.max_requests_history}</ErrorMessage>
          ) : (
            <Description>
              Older calls are dropped. Bodies are held in memory, so this costs RAM.
            </Description>
          )}
        </Field>
        <SwitchField>
          <Label>Record every run</Label>
          <Description>
            Starts recording into the current session as soon as the server comes up.
          </Description>
          <Switch
            checked={draft.auto_record_requests}
            onChange={(on) => edit({ auto_record_requests: on })}
          />
        </SwitchField>
        <Field>
          <Label>Hidden headers</Label>
          <ChipList
            label="Header to hide"
            values={draft.redact_headers}
            onRemove={(name) => edit({ redact_headers: draft.redact_headers.filter((h) => h !== name) })}
            onAdd={(name) => edit({ redact_headers: [...draft.redact_headers, name.toLowerCase()] })}
            placeholder="x-session-token"
          />
          <Description>
            Shown as <Code className="!text-xs">&lt;redacted&gt;</Code> in the log and in recordings
            on disk. Credentials belong here.
          </Description>
        </Field>
      </FormSection>

      <Divider className="my-10" soft />

      <FormSection
        title="Access"
        hint="Who may use the proxy port. The management port is loopback only and never listens wider."
      >
        <Field>
          <Label>Allowed clients</Label>
          <div className="mt-2 flex flex-wrap gap-2">
            {draft.allow_clients.map((client) => (
              <Code key={client} className="!text-xs">{client}</Code>
            ))}
          </div>
          <Description>
            Changed from the command line, deliberately:{' '}
            <Code className="!text-xs">tunnel config --allow-clients 192.168.0.0/24</Code>
          </Description>
        </Field>
      </FormSection>

      <Divider className="my-10" soft />

      <FormSection title="Server" hint="Where this server keeps things, for when you need to look.">
        <DescriptionList className="!text-sm/6">
          <DescriptionTerm>Version</DescriptionTerm>
          <DescriptionDetails>tunnel {health.version}</DescriptionDetails>
          <DescriptionTerm>Proxy</DescriptionTerm>
          <DescriptionDetails className="!font-mono !text-xs">
            {health.proxy ? `${health.proxy.host}:${health.proxy.port}` : 'off'}
          </DescriptionDetails>
          <DescriptionTerm>Config</DescriptionTerm>
          <DescriptionDetails className="!font-mono !text-xs break-all">{health.config_dir}</DescriptionDetails>
          <DescriptionTerm>State</DescriptionTerm>
          <DescriptionDetails className="!font-mono !text-xs break-all">{health.state_dir}</DescriptionDetails>
          <DescriptionTerm>Recordings</DescriptionTerm>
          <DescriptionDetails className="!font-mono !text-xs break-all">{health.data_dir}</DescriptionDetails>
          <DescriptionTerm>Certificate</DescriptionTerm>
          <DescriptionDetails className="!font-mono !text-xs break-all">{ca.ca_file}</DescriptionDetails>
          <DescriptionTerm>Fingerprint</DescriptionTerm>
          <DescriptionDetails className="!font-mono !text-xs break-all">{ca.fingerprint}</DescriptionDetails>
          <DescriptionTerm>Valid until</DescriptionTerm>
          <DescriptionDetails>{ca.not_after.slice(0, 10)}</DescriptionDetails>
        </DescriptionList>
      </FormSection>

      <div className="mt-10 flex justify-end gap-4">
        <Button plain type="button" disabled={!dirty} onClick={reset}>Reset</Button>
        <Button type="submit" disabled={!dirty || !valid || saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </form>
  )
}
