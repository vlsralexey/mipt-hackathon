import type { Money } from './api/types'

/** Как показываем отсутствующее значение: без длинных тире. */
export const NONE = 'нет'

const rub = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** "761250.00" → "761 250,00 ₽". Деньги не считаем, только показываем строку. */
export function formatMoney(value: Money | null): string {
  if (value === null) return NONE
  const n = Number(value)
  if (!Number.isFinite(n)) return value
  return `${rub.format(n).replace(/ /g, ' ')} ₽`
}

/** 43008 → "42 КБ", 1363148 → "1,3 МБ". */
export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}\u00a0КБ`
  const mb = bytes / (1024 * 1024)
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(mb)}\u00a0МБ`
}

/** "2500" → "2 500", "1.22" → "1,22". Для количеств и штук, не для денег. */
export function formatNumber(value: string): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return value
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 6 }).format(n).replace(/\u00a0/g, '\u202f')
}

/** ("2500", "пачка") → "2 500 · пачка". Единицу берём как в ТЗ и не склоняем. */
export function formatQuantity(quantity: string, unit: string): string {
  return `${formatNumber(quantity)}\u00a0·\u00a0${unit}`
}

/** "761250.00" → "761 250,00" без знака валюты (для крупного итога). */
export function formatAmount(value: Money): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return value
  return rub.format(n).replace(/\u00a0/g, '\u202f')
}

/** Доля строкой → проценты: "0.0468" → "4,68 %". */
export function formatPercent(fraction: string): string {
  const n = Number(fraction)
  if (!Number.isFinite(n)) return fraction
  return `${rub.format(n * 100)}\u00a0%`
}

/** "2026-08-12" → "12.08.2026"; без даты — прочерк. */
export function formatIsoDate(iso: string | null): string {
  if (!iso) return NONE
  const [y, m, d] = iso.split('-')
  return d && m && y ? `${d}.${m}.${y}` : iso
}

/** "2026-11-13T10:20:00+03:00" → "13 ноября 2026". */
export function formatLongDate(iso: string): string {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso))
}
