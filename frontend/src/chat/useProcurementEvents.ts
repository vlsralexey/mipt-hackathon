import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import type { AgentEvent, Message, Procurement, ProcurementSummary, ReportEvent } from '../api/types'
import { mergeMessage } from './merge'

/** Ключ запроса закупки; по нему события обновляют историю чата. */
export const procurementKey = (id: string) => ['procurement', id] as const

/**
 * Подписка на SSE открытой закупки (docs/api.md §4).
 * - `message` — вставить или заменить по `id`;
 * - `agent` — индикатор «агент думает»;
 * - `procurement` — название и статус;
 * - `report` — отчёт устарел, перезапросить (панель отчёта — этап 4).
 * На каждый `open` закупка запрашивается заново: события между обрывом и
 * подключением не переигрываются, а все события — замены по `id`.
 */
export function useProcurementEvents(id: string) {
  const queryClient = useQueryClient()

  useEffect(() => {
    const source = new EventSource(`/api/procurements/${id}/events`)
    const update = (change: (p: Procurement) => Procurement) =>
      queryClient.setQueryData<Procurement>(procurementKey(id), (old) => (old ? change(old) : old))
    const data = <T>(e: Event) => JSON.parse((e as MessageEvent<string>).data) as T

    source.addEventListener('open', () => {
      void queryClient.invalidateQueries({ queryKey: procurementKey(id) })
      // Во время обрыва могли появиться новые версии уже открытого отчёта.
      void queryClient.invalidateQueries({ queryKey: ['reports', id] })
      void queryClient.invalidateQueries({ queryKey: ['procurements'] })
    })
    source.addEventListener('message', (e) => {
      const message = data<Message>(e)
      update((p) => ({ ...p, messages: mergeMessage(p.messages, message) }))
    })
    source.addEventListener('agent', (e) => {
      const { busy } = data<AgentEvent>(e)
      update((p) => ({ ...p, agent_busy: busy }))
    })
    source.addEventListener('procurement', (e) => {
      const summary = data<ProcurementSummary>(e)
      update((p) => ({ ...p, ...summary }))
      void queryClient.invalidateQueries({ queryKey: ['procurements'] })
    })
    source.addEventListener('report', (e) => {
      data<ReportEvent>(e)
      void queryClient.invalidateQueries({ queryKey: ['reports', id] })
    })

    return () => source.close()
  }, [id, queryClient])
}
