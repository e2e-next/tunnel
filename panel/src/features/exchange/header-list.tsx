/** Headers and query values: names monospaced, values allowed to wrap. */
import { DescriptionDetails, DescriptionList, DescriptionTerm } from '../../components/description-list'
import { Text } from '../../components/text'

export function HeaderList({ values }: { values: Record<string, string> }) {
  const names = Object.keys(values)
  if (!names.length) return <Text className="!text-sm/6 text-zinc-500">None.</Text>
  return (
    <DescriptionList className="!text-xs/6">
      {names.map((name) => (
        <div key={name} className="contents">
          <DescriptionTerm className="!font-mono">{name}</DescriptionTerm>
          <DescriptionDetails className="!font-mono break-all">{values[name]}</DescriptionDetails>
        </div>
      ))}
    </DescriptionList>
  )
}

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return <p className="mt-4 text-xs/6 font-medium text-zinc-500 uppercase">{children}</p>
}
