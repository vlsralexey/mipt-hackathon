import procurementExample from '../../../docs/api-examples/procurement.json'
import reportExample from '../../../docs/api-examples/report.json'
import type {
  Edit,
  Message,
  Procurement,
  ProcurementSummary,
  Report,
  Settings,
  VersionInfo,
} from '../api/types'

// Данные условные: берём примеры контракта, как есть. См. docs/api.md §7.

export type MockEvent =
  | { event: 'message'; data: Message }
  | { event: 'agent'; data: { busy: boolean } }
  | { event: 'procurement'; data: ProcurementSummary }
  | { event: 'report'; data: { version: number; cause: string } }

type Listener = (e: MockEvent) => void

export function summaryOf(p: Procurement): ProcurementSummary {
  const { filename: _f, agent_busy: _b, messages: _m, ...summary } = p
  return summary
}

export class MockDb {
  settings: Settings = { has_api_key: false, key_source: null, model: '' }
  procurements = new Map<string, Procurement>()
  reports = new Map<string, Report[]>()
  private listeners = new Map<string, Set<Listener>>()
  private counter = 0

  constructor() {
    this.reset()
  }

  reset() {
    this.settings = { has_api_key: false, key_source: null, model: '' }
    this.procurements.clear()
    this.reports.clear()
    this.listeners.clear()
    this.counter = 0
    const p = structuredClone(procurementExample) as unknown as Procurement
    const r = structuredClone(reportExample) as unknown as Report
    this.procurements.set(p.id, p)
    this.reports.set(p.id, [r])
  }

  nextId(prefix: string): string {
    this.counter += 1
    return `${prefix}_mock${this.counter}`
  }

  versions(id: string): VersionInfo[] {
    return (this.reports.get(id) ?? []).map((r) => ({
      version: r.version,
      created_at: r.created_at,
      cause: r.cause,
      total: r.total,
      total_justified: r.total_justified,
    }))
  }

  edits(id: string): Edit[] {
    const latest = this.reports.get(id)?.at(-1)
    return latest ? latest.edits.map((e) => e.edit) : []
  }

  subscribe(id: string, listener: Listener): () => void {
    const set = this.listeners.get(id) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(id, set)
    return () => set.delete(listener)
  }

  publish(id: string, e: MockEvent) {
    for (const l of this.listeners.get(id) ?? []) l(e)
  }

  /** Добавляет сообщение в историю или заменяет по `id` и рассылает подписчикам SSE. */
  addMessage(id: string, message: Message) {
    const p = this.procurements.get(id)
    if (!p) return
    const index = p.messages.findIndex((m) => m.id === message.id)
    if (index === -1) p.messages.push(message)
    else p.messages[index] = message
    this.publish(id, { event: 'message', data: message })
  }

  /** Сообщает подписчикам об изменении названия или статуса закупки. */
  publishSummary(id: string) {
    const p = this.procurements.get(id)
    if (p) this.publish(id, { event: 'procurement', data: summaryOf(p) })
  }
}

export const db = new MockDb()
