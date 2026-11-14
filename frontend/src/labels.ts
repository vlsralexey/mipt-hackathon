import type { PositionStatus, RunStep } from './api/types'

// Подписи коротких статусов — docs/api.md §6.

export const positionStatusLabel: Record<PositionStatus, string> = {
  ok: 'обоснована',
  insufficient: 'недостаточно цен (цена справочно)',
  heterogeneous: 'неоднородная выборка (цена справочно)',
}

export const stepStatusLabel: Record<RunStep['status'], string> = {
  queued: 'в очереди',
  running: 'ищу',
  ok: 'найдено',
  empty: 'ничего не найдено',
  unavailable: 'не отвечает',
  error: 'ошибка',
  needs_login: 'ждёт проверки',
  skipped: 'пропущен',
}
