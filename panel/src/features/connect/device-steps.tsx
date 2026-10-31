/**
 * The per-platform instructions. They are folded away because most of the time
 * you already know them, and the two that people get wrong (iOS trust, Android
 * user certificates) are stated as their own step rather than a footnote.
 */
import { Disclosure, DisclosureButton, DisclosurePanel } from '@headlessui/react'
import { ChevronRightIcon } from '@heroicons/react/20/solid'

const IOS = [
  'Settings › Wi-Fi › the network › Configure Proxy › Manual, then the address above.',
  'Open http://ca.tunnel/ in Safari and let it download the profile.',
  'Settings › General › VPN & Device Management, then install the profile.',
  'Settings › General › About › Certificate Trust Settings, and switch tunnel on. Without this last step iOS still refuses every https call.',
]

const ANDROID = [
  'Wi-Fi › the network › Advanced › Proxy › Manual, then the address above. An emulator reaches this machine at 10.0.2.2.',
  'Open http://ca.tunnel/ in Chrome, then Settings › Security › Encryption & credentials › Install a certificate › CA certificate.',
  'From Android 7 an app only trusts user certificates if it says so: add a network_security_config.xml that trusts the user store, in a debug build.',
  'Turn certificate pinning off in debug builds, or pinning rejects tunnel before you see anything.',
]

function Steps({ title, steps }: { title: string; steps: string[] }) {
  return (
    <Disclosure>
      <DisclosureButton className="group flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm/6 font-medium text-zinc-950 hover:bg-zinc-950/5 dark:text-white dark:hover:bg-white/5">
        <ChevronRightIcon className="size-4 fill-zinc-400 transition group-data-open:rotate-90" />
        {title}
      </DisclosureButton>
      <DisclosurePanel>
        <ol className="mt-1 ml-4 list-decimal space-y-2 pl-4 text-sm/6 text-zinc-500 dark:text-zinc-400">
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </DisclosurePanel>
    </Disclosure>
  )
}

export function DeviceSteps() {
  return (
    <div className="pt-2">
      <Steps title="On iOS" steps={IOS} />
      <Steps title="On Android" steps={ANDROID} />
    </div>
  )
}
