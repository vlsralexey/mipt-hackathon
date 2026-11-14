import { describe, expect, it } from 'vitest'
import {
  formatAmount,
  formatDay,
  formatIsoDate,
  formatLongDate,
  formatMoney,
  formatNumber,
  formatPercent,
  formatQuantity,
  formatShare,
  formatSize,
  formatSupplier,
  hostOf,
  quotesRu,
  tidyText,
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
  it('разделяет разряды и согласует единицу с числом', () => {
    expect(formatQuantity('2500', 'пачка')).toBe('2\u202f500\u00a0пачек')
    expect(formatQuantity('1', 'пачка')).toBe('1\u00a0пачка')
    expect(formatQuantity('22', 'рулон')).toBe('22\u00a0рулона')
    expect(formatQuantity('11', 'штука')).toBe('11\u00a0штук')
    expect(formatQuantity('2.5', 'пачка')).toBe('2,5\u00a0пачки')
    expect(formatQuantity('3', 'Упаковка (10 шт)')).toBe('3\u00a0упаковки (10 шт)')
  })

  it('сокращения ставит как есть, незнакомое название отделяет точкой', () => {
    expect(formatQuantity('50', 'шт')).toBe('50\u00a0шт')
    expect(formatQuantity('1.22', 'мкг')).toBe('1,22\u00a0мкг')
    expect(formatQuantity('5', 'упак.')).toBe('5\u00a0упак.')
    expect(formatQuantity('2', 'условная единица')).toBe('2\u00a0·\u00a0условная единица')
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
  it('дата словами без «г.» и короткие проценты', () => {
    expect(formatDay('2026-10-19')).toBe('19 октября 2026')
    expect(formatDay('2026-11-13T10:20:00+03:00')).toBe('13 ноября 2026')
    expect(formatDay(null)).toBeNull()
    expect(formatShare('0.1188')).toBe('11,9 %')
    expect(formatShare('0.33')).toBe('33 %')
  })
  it('« : » из текстов бэкенда становится двоеточием', () => {
    expect(tidyText('ЕИС : реестр контрактов')).toBe('ЕИС: реестр контрактов')
    expect(tidyText('у 1 из 6 предложений : цена может быть занижена')).toBe('у 1 из 6 предложений: цена может быть занижена')
    expect(tidyText('IQR: [Q1 − 1.5 × IQR]')).toBe('IQR: [Q1 − 1.5 × IQR]')
    expect(tidyText('Формулы — по аналогии')).toBe('Формулы: по аналогии')
  })
})

describe('поставщики и домены в строках цен', () => {
  it('ФИО из реестра: фамилия и инициалы', () => {
    expect(formatSupplier('ГАБИБОВ МАЛИК АРТУРОВИЧ')).toBe('Габибов М.\u00a0А.')
    expect(formatSupplier('САМАРЕЦ ЮЛИАНА ВЛАДИМИРОВНА')).toBe('Самарец Ю.\u00a0В.')
    expect(formatSupplier('ИП ИВАНОВ ИВАН ИВАНОВИЧ')).toBe('ИП Иванов И.\u00a0И.')
    expect(formatSupplier('ИП Петров А. В.')).toBe('ИП Петров А. В.')
  })

  it('организации: ёлочки, сокращённая форма, регистр только у названия целиком прописными', () => {
    expect(formatSupplier('ООО "ТД "ТЕМА"')).toBe('ООО «ТД «Тема»»')
    expect(formatSupplier('ООО "ТЦ "С.Т.И.К."')).toBe('ООО «ТЦ «С.Т.И.К.»»')
    expect(formatSupplier('ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "КОМПЛЕКС ТЕНДЕР"')).toBe('ООО «Комплекс Тендер»')
    expect(formatSupplier('ООО «Офис-Снаб»')).toBe('ООО «Офис-Снаб»')
    expect(formatSupplier('ООО "ЛЕНТА-М"')).toBe('ООО «Лента-М»')
    // три слова прописными без отчества: не человек
    expect(formatSupplier('ГБУЗ ГОРОДСКАЯ БОЛЬНИЦА')).toBe('ГБУЗ Городская Больница')
    expect(quotesRu('"А" и "Б"')).toBe('«А» и «Б»')
  })

  it('домен без www, кириллический по-русски', () => {
    expect(hostOf('https://www.pragmatic.ru/a')).toBe('pragmatic.ru')
    expect(hostOf('https://xn----9sbmbhf5afe0b1k.xn--p1ai/x')).toBe('бизнес-меню.рф')
    expect(hostOf('не адрес')).toBeNull()
  })
})
