import type { ProcurementSummary } from './api/types'

export interface NavSubtitle {
  text: string
  /** Точка перед подписью: идёт поиск, нужна помощь или ничего. */
  dot: 'live' | 'warn' | null
}

/** «13 ноября, 10:20»; для прошлых лет «29 октября 2025 г., 10:20». Время местное. */
function formatDateTime(iso: string, now: Date): string {
  const date = new Date(iso)
  const withYear = date.getFullYear() !== now.getFullYear()
  const day = new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    ...(withYear && { year: 'numeric' }),
  }).format(date)
  const time = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(date)
  return `${day}, ${time}`
}

/** Подпись под названием закупки в навигации, по правилам docs/api.md §5.2. */
export function navSubtitle(p: ProcurementSummary, now: Date = new Date()): NavSubtitle {
  if (p.status === 'running') return { text: 'Идёт поиск', dot: 'live' }
  if (p.status === 'needs_user') return { text: 'Нужна ваша помощь', dot: 'warn' }
  if (p.status === 'failed') return { text: 'Прогон не удался', dot: 'warn' }
  return { text: formatDateTime(p.updated_at, now), dot: null }
}
