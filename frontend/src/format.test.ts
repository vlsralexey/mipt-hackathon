import { describe, expect, it } from 'vitest'
import {
  formatAmount,
  formatIsoDate,
  formatLongDate,
  formatMoney,
  formatNumber,
  formatPercent,
  formatQuantity,
  formatSize,
} from './format'

describe('formatMoney', () => {
  it('форматирует строку из API, ничего не считая', () => {
    expect(formatMoney('761250.00')).toBe('761 250,00 ₽')
    expect(formatMoney('304.50')).toBe('304,50 ₽')
  })
  it('показывает «нет» для null', () => {
    expect(formatMoney(null)).toBe('нет')
  })
})

describe('formatSize', () => {
  it('показывает килобайты и мегабайты', () => {
    expect(formatSize(42 * 1024)).toBe('42\u00a0КБ')
    expect(formatSize(10)).toBe('1\u00a0КБ')
    expect(formatSize(Math.round(1.3 * 1024 * 1024))).toBe('1,3\u00a0МБ')
  })
})

describe('formatQuantity', () => {
  it('разделяет разряды и оставляет единицу как в ТЗ', () => {
    expect(formatQuantity('2500', 'пачка')).toBe('2\u202f500\u00a0·\u00a0пачка')
    expect(formatQuantity('50', 'шт')).toBe('50\u00a0·\u00a0шт')
    expect(formatQuantity('1.22', 'мкг')).toBe('1,22\u00a0·\u00a0мкг')
  })
})

describe('форматы отчёта', () => {
  it('число, сумма без валюты и проценты', () => {
    expect(formatNumber('2500')).toBe('2\u202f500')
    expect(formatAmount('793990.00')).toBe('793\u202f990,00')
    expect(formatPercent('0.0468')).toBe('4,68\u00a0%')
    expect(formatPercent('0.33')).toBe('33,00\u00a0%')
  })
  it('даты', () => {
    expect(formatIsoDate('2026-08-12')).toBe('12.08.2026')
    expect(formatIsoDate(null)).toBe('нет')
    expect(formatLongDate('2026-11-13T10:20:00+03:00')).toBe('13 ноября 2026 г.')
  })
})
