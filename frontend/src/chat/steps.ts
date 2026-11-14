import type { RunStep } from '../api/types'

export interface SourceRow {
  source_id: string
  name: string
  level: 1 | 2
  status: RunStep['status']
  found: number
  /** `null`, пока хотя бы по одной позиции сопоставление не закончено. */
  relevant: number | null
  note: string | null
}

// Что показывать, если по разным позициям у источника разные статусы: незавершённое важнее.
const priority: RunStep['status'][] = [
  'running',
  'queued',
  'needs_login',
  'ok',
  'error',
  'unavailable',
  'empty',
  'skipped',
]

/**
 * Шаги идут по паре «источник × позиция». В списке хода поиска они группируются по
 * источнику; суммируются штуки (найдено, подошло), а не деньги (docs/api.md §5.3).
 */
export function groupSteps(steps: RunStep[]): SourceRow[] {
  const bySource = new Map<string, RunStep[]>()
  for (const step of steps) {
    bySource.set(step.source_id, [...(bySource.get(step.source_id) ?? []), step])
  }
  return [...bySource.entries()].map(([source_id, group]) => ({
    source_id,
    name: group[0].name,
    level: group[0].level,
    status: priority.find((s) => group.some((g) => g.status === s)) ?? group[0].status,
    found: group.reduce((sum, g) => sum + g.found, 0),
    relevant: group.some((g) => g.relevant === null)
      ? null
      : group.reduce((sum, g) => sum + (g.relevant ?? 0), 0),
    note: group.find((g) => g.note)?.note ?? null,
  }))
}
