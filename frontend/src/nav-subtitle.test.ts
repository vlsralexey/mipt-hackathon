import { describe, expect, it } from 'vitest'
import type { ProcurementSummary } from './api/types'
import { navSubtitle } from './nav-subtitle'

const base: ProcurementSummary = {
  id: 'p1',
  title: 'Закупка',
  created_at: '2026-11-11T10:00:00+03:00',
  updated_at: '2026-11-11T12:00:00+03:00',
  status: 'ready',
  latest_version: 1,
  total: '100.00',
  total_justified: '100.00',
  positions_total: 3,
  positions_unjustified: 0,
}
const now = new Date('2026-11-14T12:00:00+03:00')

describe('navSubtitle', () => {
  it('поиск идёт, пульсирующая точка', () => {
    expect(navSubtitle({ ...base, status: 'running' }, now)).toEqual({ text: 'Идёт поиск', dot: 'live' })
  })
  it('нужна капча или вход', () => {
    expect(navSubtitle({ ...base, status: 'needs_user' }, now)).toEqual({
      text: 'Нужна ваша помощь',
      dot: 'warn',
    })
  })
  it('число позиций без обоснования в подписи не показывается: только дата и время', () => {
    const r = navSubtitle({ ...base, positions_unjustified: 3 }, now)
    expect(r).toEqual({ text: '11 ноября, 12:00', dot: null })
    expect(r.text).not.toMatch(/обоснован/)
  })
  it('иначе дата и время обновления, с годом только для прошлых лет', () => {
    expect(navSubtitle(base, now)).toEqual({ text: '11 ноября, 12:00', dot: null })
    expect(navSubtitle({ ...base, updated_at: '2025-10-29T12:00:00+03:00' }, now).text).toBe(
      '29 октября 2025 г., 12:00',
    )
  })
  it('время показывается местное с ведущим нулём', () => {
    expect(navSubtitle({ ...base, updated_at: '2026-11-11T09:05:00+03:00' }, now).text).toBe('11 ноября, 09:05')
  })
  it('прогон не удался: предупреждающая точка', () => {
    expect(navSubtitle({ ...base, status: 'failed' }, now)).toEqual({ text: 'Прогон не удался', dot: 'warn' })
  })
  it('новая закупка без прогона показывает дату', () => {
    expect(navSubtitle({ ...base, status: 'new', latest_version: null }, now).dot).toBeNull()
  })
})
