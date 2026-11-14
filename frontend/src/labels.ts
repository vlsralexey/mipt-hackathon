import type { ExclusionReason, PositionStatus, RunStep } from './api/types'

// Подписи коротких статусов — docs/api.md §6.

export const positionStatusLabel: Record<PositionStatus, string> = {
  ok: 'обоснована',
  insufficient: 'недостаточно цен (цена справочно)',
  heterogeneous: 'неоднородная выборка (цена справочно)',
}

/** Короткая причина исключения: для сводок «исключено 6: другая единица 4, выброс 2». */
export const exclusionLabel: Record<ExclusionReason, string> = {
  anomalous_price: 'выброс',
  incomparable: 'не совпадает с ТЗ',
  unit_mismatch: 'другая единица',
  insufficient_data: 'не хватает данных',
  duplicate: 'дубль',
  same_supplier: 'тот же поставщик',
  user_excluded: 'исключено вами',
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
