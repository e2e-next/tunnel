/**
 * ⌘K: the keyboard way to every page, every rule and the two switches a run
 * flips most. Headless UI's Combobox does the filtering, the focus and the
 * arrow keys, which is most of what makes a palette feel right.
 */
import { Combobox, ComboboxInput, ComboboxOption, ComboboxOptions, Dialog, DialogBackdrop, DialogPanel } from '@headlessui/react'
import { MagnifyingGlassIcon } from '@heroicons/react/20/solid'
import { useEffect, useState } from 'react'
import { useCommands, type Command } from './use-commands'

export function CommandPalette() {
  const commands = useCommands()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  function close() {
    setOpen(false)
    setQ('')
  }

  const shown = q
    ? commands.filter((c) => c.label.toLowerCase().includes(q.toLowerCase())).slice(0, 12)
    : commands.slice(0, 9)

  return (
    <Dialog open={open} onClose={close} className="relative z-50">
      <DialogBackdrop
        transition
        className="fixed inset-0 bg-zinc-950/25 transition data-closed:opacity-0"
      />
      <div className="fixed inset-0 overflow-y-auto p-4 pt-[20vh]">
        <DialogPanel
          transition
          className="mx-auto max-w-xl transform overflow-hidden rounded-xl bg-white shadow-2xl ring-1 ring-zinc-950/5 transition data-closed:scale-95 data-closed:opacity-0 dark:bg-zinc-800 dark:ring-white/10"
        >
          <Combobox
            onChange={(command: Command | null) => {
              if (!command) return
              command.run()
              close()
            }}
          >
            <div className="flex items-center border-b border-zinc-950/5 px-4 dark:border-white/10">
              <MagnifyingGlassIcon className="size-5 fill-zinc-400" />
              <ComboboxInput
                autoFocus
                placeholder="Go to a page, a rule or a session…"
                className="w-full border-0 bg-transparent py-3.5 pl-3 text-sm/6 text-zinc-950 placeholder:text-zinc-400 focus:ring-0 focus:outline-none dark:text-white"
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            {shown.length > 0 ? (
              <ComboboxOptions static className="max-h-80 overflow-y-auto p-2">
                {shown.map((command) => (
                  <ComboboxOption
                    key={command.id}
                    value={command}
                    className="flex cursor-default items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm/6 text-zinc-950 select-none data-focus:bg-zinc-950/5 dark:text-white dark:data-focus:bg-white/5"
                  >
                    <span className="truncate">{command.label}</span>
                    <span className="shrink-0 text-xs/5 text-zinc-500">{command.hint}</span>
                  </ComboboxOption>
                ))}
              </ComboboxOptions>
            ) : (
              <p className="p-6 text-center text-sm/6 text-zinc-500">Nothing goes by that name.</p>
            )}
          </Combobox>
        </DialogPanel>
      </div>
    </Dialog>
  )
}
