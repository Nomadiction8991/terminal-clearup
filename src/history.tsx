import { atom, Badge, Heading, Link, read, Row, Separator, Stack, Text } from 'orca'

type Closure = { at: number; name: string; outcome: string; runId: string; estimatedMemoryBytes?: number }
const history = atom<Closure[]>('closureHistory', [], { persist: 'storage' })

export default function History() {
  const days = new Map<string, Closure[]>()
  for (const entry of read(history)) {
    const day = new Date(entry.at).toLocaleDateString('pt-BR')
    const entries = days.get(day) ?? []
    entries.push(entry)
    days.set(day, entries)
  }

  return (
    <Stack gap="sm">
      <Heading>Histórico de fechamentos</Heading>
      {days.size === 0 ? <Text muted>Nenhum fechamento registrado ainda.</Text> : null}
      {Array.from(days, ([day, entries]) => (
        <Stack key={day} gap="sm">
          <Text muted size="xs" weight="semibold">{day}</Text>
          {entries.map((entry, index) => {
            const bytes = entry.estimatedMemoryBytes
            const memory = typeof bytes === 'number' && bytes > 0
              ? `≈ ${(bytes / 1024 ** 2).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MiB liberados`
              : null
            return (
              <Stack key={entry.runId + ':' + entry.at} gap="sm">
                <Stack gap="xs">
                  <Text weight="semibold" size="sm">{entry.name}</Text>
                  <Row justify="between" gap="xs">
                    <Badge tone={memory ? 'success' : 'neutral'}>
                      {memory ?? 'RAM não medida'}
                    </Badge>
                    <Text muted size="xs">{new Date(entry.at).toLocaleTimeString('pt-BR')}</Text>
                  </Row>
                </Stack>
                {index < entries.length - 1 ? <Separator /> : null}
              </Stack>
            )
          })}
        </Stack>
      ))}
      <Link href="https://github.com/Nomadiction8991/terminal-clearup">Dar estrela no GitHub</Link>
    </Stack>
  )
}
