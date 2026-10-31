/**
 * Three things have to be true before a call shows up on Traffic, and this page
 * is those three in order. Changes save as they are made: it is the page you
 * come back to and retry on, and a Save button there would only be in the way.
 */
import { useState } from 'react'
import { Badge } from '../../components/badge'
import { Button } from '../../components/button'
import { Description, Field, Label } from '../../components/fieldset'
import { Divider } from '../../components/divider'
import { Heading, Subheading } from '../../components/heading'
import { Input } from '../../components/input'
import { Switch, SwitchField } from '../../components/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/table'
import { Code, Text, TextLink } from '../../components/text'
import { relative } from '../../lib/format'
import { ChipList } from '../../ui/chip-list'
import { CopyButton } from '../../ui/copy-button'
import { ConnectStep } from './connect-step'
import { DeviceSteps } from './device-steps'
import { useConnect } from './use-connect'

export function ConnectPage() {
  const c = useConnect()
  const port = c.proxy?.port ?? 8890

  return (
    <>
      <Heading>Connect a device</Heading>
      <Text className="!mt-1">
        Three things have to be true before a call shows up on Traffic. Each tick below is
        earned from the log, not from this page.
      </Text>

      <Divider className="my-10" />

      <ConnectStep
        n={1}
        title="Point the device at the proxy"
        hint="Set an HTTP proxy on the device's Wi-Fi network. Every address below reaches this machine."
        done={c.steps.pointed}
      >
        {c.proxy?.lan_ips.map((ip) => (
          <div key={ip} className="flex items-center gap-3">
            <Code className="flex-1 !text-xs">{ip}:{port}</Code>
            <CopyButton text={`${ip}:${port}`} />
          </div>
        ))}
        <Text className="!text-xs/6 text-zinc-500">
          An iOS simulator follows this Mac's own proxy settings, so it needs nothing here. An
          Android emulator reaches this machine at{' '}
          <Code className="!text-xs">10.0.2.2:{port}</Code>.
        </Text>
      </ConnectStep>

      <Divider className="my-10" soft />

      <ConnectStep
        n={2}
        title="Install the certificate"
        hint="tunnel signs https responses with its own CA, and the device has to trust it or every call fails."
        done={c.steps.trusted}
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button outline href="/ca.pem">Download ca.pem</Button>
          <Text className="!text-xs/6 text-zinc-500">for this machine</Text>
        </div>
        <div className="flex items-center gap-3">
          <Code className="flex-1 !text-xs">http://ca.tunnel/</Code>
          <Text className="!text-xs/6 text-zinc-500">from the device</Text>
          <CopyButton text="http://ca.tunnel/" />
        </div>
        <Field>
          <Label>Fingerprint</Label>
          <Input
            readOnly
            value={c.ca.fingerprint}
            className="[&_input]:!font-mono [&_input]:!text-xs"
          />
          <Description>Check this against what the device shows before trusting it.</Description>
        </Field>
        <DeviceSteps />
      </ConnectStep>

      <Divider className="my-10" soft />

      <ConnectStep
        n={3}
        title="Choose what to decrypt"
        hint="Only the hosts you list are opened up. Everything else is tunnelled through untouched, which keeps other apps on the device working."
        done={c.steps.chosen}
      >
        <SwitchField>
          <Label>SSL proxying</Label>
          <Description>Off tunnels every https host without reading it.</Description>
          <Switch checked={c.ssl.enabled} onChange={c.setEnabled} />
        </SwitchField>

        <Field>
          <Label>Decrypt these hosts</Label>
          <ChipList
            label="Host to decrypt"
            color="sky"
            values={c.ssl.include}
            onRemove={c.unInclude}
            onAdd={c.include}
            placeholder="api.example.com or *.example.com"
          />
        </Field>

        <Field>
          <Label>Never decrypt</Label>
          <ChipList
            label="Host to leave alone"
            values={c.ssl.exclude}
            onRemove={c.unExclude}
            empty="Nothing excluded."
          />
          <Description>Pinned hosts belong here, so they keep working while you debug.</Description>
        </Field>

        {c.encryptedHosts.length > 0 && (
          <div>
            <Subheading level={3} className="!text-sm/6">Recently tunnelled</Subheading>
            <Table dense className="mt-2 [--gutter:--spacing(0)]">
              <TableHead>
                <TableRow>
                  <TableHeader className="w-full">Host</TableHeader>
                  <TableHeader className="text-right">Tunnels</TableHeader>
                  <TableHeader className="w-0" />
                </TableRow>
              </TableHead>
              <TableBody>
                {c.encryptedHosts.map((h) => (
                  <TableRow key={h.host}>
                    <TableCell className="!font-mono !text-xs">{h.host}</TableCell>
                    <TableCell className="text-right tabular-nums text-zinc-500">{h.tunnels}</TableCell>
                    <TableCell>
                      {c.ssl.include.includes(h.host) ? (
                        <Badge color="sky">Decrypting</Badge>
                      ) : (
                        <Button outline onClick={() => c.include(h.host)}>Decrypt</Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </ConnectStep>

      <Divider className="my-10" />

      <Subheading>Connected devices</Subheading>
      <Text className="!mt-1 !text-sm/6">Whoever has spoken to the proxy, by address.</Text>
      <Table className="mt-4 [--gutter:--spacing(0)]">
        <TableHead>
          <TableRow>
            <TableHeader className="w-full">Client</TableHeader>
            <TableHeader>Last seen</TableHeader>
            <TableHeader className="text-right">Calls</TableHeader>
            <TableHeader className="text-right">Tunnels</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {c.clients.map((client) => (
            <TableRow key={client.client}>
              <TableCell className="!font-mono !text-xs">
                {client.client}
                {client.client === '127.0.0.1' && (
                  <span className="ml-2 font-sans text-zinc-500">this machine</span>
                )}
              </TableCell>
              <TableCell className="text-zinc-500">{relative(client.last_seen)}</TableCell>
              <TableCell className="text-right tabular-nums text-zinc-500">{client.calls}</TableCell>
              <TableCell className="text-right tabular-nums text-zinc-500">{client.tunnels}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Text className="!mt-4 !text-xs/6 text-zinc-500">
        Only the addresses in <Code className="!text-xs">allow_clients</Code> may use the proxy.
        Change that on <TextLink href="#/settings">Settings</TextLink>.
      </Text>
    </>
  )
}
