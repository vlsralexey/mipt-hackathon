import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api } from '../api/client'

/**
 * Версии и отчёт открытой закупки. `viewing === null` — следить за последней версией:
 * событие `report` сбрасывает ключ `['reports', id]`, и панель сама подгружает новую.
 */
export function useReport(id: string, hasReport: boolean, viewing: number | null) {
  const versions = useQuery({
    queryKey: ['reports', id],
    queryFn: () => api.listReports(id),
    enabled: hasReport,
  })
  const report = useQuery({
    queryKey: ['reports', id, viewing ?? 'latest'],
    queryFn: () => api.getReport(id, viewing ?? 'latest'),
    enabled: hasReport,
    // при переключении версии показываем прежнюю, пока грузится новая
    placeholderData: keepPreviousData,
  })
  const latest = versions.data?.at(-1)?.version ?? null
  return { versions, report, latest }
}
