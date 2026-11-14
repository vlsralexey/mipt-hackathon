import { describe, expect, it } from 'vitest'
import type { OfferEntry, PositionReport, Report } from '../api/types'
import example from '../../../docs/api-examples/report.json'
import { calcSteps, exclusionText, humanRule, noCalcText, priceNote, positionLabels, shortPositionLabel, shortPositionLabels, weakReason } from './position-text'

const report = () => structuredClone(example) as unknown as Report
const entry = (over: Partial<OfferEntry>): OfferEntry =>
  ({ normalized_price: null, comparison: [], reason: '', exclusion: null, ...over }) as OfferEntry

describe('calcSteps', () => {
  it('позиция 1 примера: среднее со слагаемыми, разброс с порогом, выбросы, сумма', () => {
    const r = report()
    const steps = calcSteps(r.positions[0], r.rules)
    expect(steps.map((s) => s.label)).toEqual(['Средняя цена', 'Разброс', 'Выбросы', 'НМЦК позиции'])
    // цены по возрастанию
    expect(steps[0].formula).toMatch(/^\(290,00 \+ 305,00 \+ 318,50\) \/ 3$/)
    expect(steps[0].result).toMatch(/^304,50\s₽$/)
    expect(steps[1].formula).toMatch(/^14,26 \/ 304,50$/)
    expect(steps[1].result).toBe('4,7 %')
    expect(steps[1].note).toBe('не больше 33 %: цены однородны')
    // границы коридора уже на линейке и в причинах исключения: здесь без повтора
    expect(steps[2].formula).toMatch(/^520,00\s₽ вне коридора, отклонение от медианы больше 50 %$/)
    expect(steps[2].note).toBeUndefined()
    expect(steps[3].formula).toMatch(/^304,50\s₽ × 2\s500\sпачек$/)
    expect(steps[3].result).toMatch(/^761\s250,00\s₽$/)
  })

  it('больше 8 цен: сумма сокращается', () => {
    const r = report()
    const p = r.positions[0]
    p.included = Array.from({ length: 9 }, () => p.included[0])
    p.stats = { ...p.stats!, n: 9 }
    expect(calcSteps(p, r.rules)[0].formula).toBe('(сумма 9 цен) / 9')
  })

  it('недостаточно цен: итог позиции не определён, цена справочно', () => {
    const r = report()
    const steps = calcSteps(r.positions[1], r.rules)
    expect(steps[2].formula).toMatch(/^нет, все цены в коридоре/)
    expect(steps[3].formula).toMatch(/^не определена: 2 цены, нужно не меньше 3, цена 274,75\s₽ справочно$/)
    expect(steps[3].result).toBeUndefined()
  })

  it('неоднородные цены: так и сказано в разбросе', () => {
    const r = report()
    const p = { ...r.positions[0], status: 'heterogeneous' as const, unit_price: null, total: null }
    const steps = calcSteps(p, r.rules)
    expect(steps[1].note).toBe('больше 33 %: цены неоднородны')
    expect(steps[3].formula).toMatch(/^не определена: цены неоднородны/)
  })

  it('без статистики шагов нет, есть объяснение', () => {
    const p = {
      stats: null,
      excluded: [entry({ exclusion: 'unit_mismatch' }), entry({ exclusion: 'unit_mismatch' }), entry({ exclusion: 'anomalous_price' })],
    } as unknown as PositionReport
    expect(calcSteps(p, {})).toEqual([])
    expect(noCalcText(p)).toBe('Цен для расчёта нет: 3 найденных предложения исключены (другая единица: 2, выброс: 1).')
    expect(noCalcText({ ...p, excluded: [] })).toMatch(/Подходящих цен не нашлось/)
  })
})

describe('состояние позиции', () => {
  it('короткие подписи для итога и таблицы', () => {
    const r = report()
    expect(weakReason(r.positions[0])).toBeNull()
    expect(weakReason(r.positions[1])).toBe('мало цен')
    expect(priceNote(r.positions[1])).toBe('справочно')
    const none = { ...r.positions[1], stats: null, reference_price: null }
    expect(weakReason(none)).toBe('нет цен')
    expect(priceNote(none)).toBe('нет цен')
    expect(weakReason({ ...r.positions[0], status: 'heterogeneous' })).toBe('цены неоднородны')
  })
})

describe('exclusionText', () => {
  const stats = report().positions[0].stats
  it('выброс: ниже или выше коридора с границей', () => {
    expect(exclusionText(entry({ exclusion: 'anomalous_price', normalized_price: '520.00' }), stats)).toMatch(/^Выброс: выше коридора 467,63\s₽$/)
    expect(exclusionText(entry({ exclusion: 'anomalous_price', normalized_price: '100.00' }), stats)).toMatch(/^Выброс: ниже коридора 155,88\s₽$/)
  })
  it('выброс без статистики: правило из причины', () => {
    const e = entry({ exclusion: 'anomalous_price', normalized_price: '663.80', reason: 'Аномальная цена: Отклонение от медианы более 50.0 %' })
    expect(exclusionText(e, null)).toBe('Выброс: отклонение от медианы больше 50 %')
  })
  it('несовпадение: какие существенные характеристики', () => {
    const e = entry({
      exclusion: 'incomparable',
      reason: 'Не соответствует: Товарный знак',
      comparison: [
        { name: 'Товарный знак', required: 'SvetoCopy', offered: 'Снегурочка', essential: true, ok: false },
        { name: 'Цвет', required: 'белый', offered: 'серый', essential: false, ok: false },
      ],
    })
    expect(exclusionText(e, stats)).toBe('Не совпадает с ТЗ: Товарный знак')
  })
  it('другая единица и прочие причины', () => {
    expect(exclusionText(entry({ exclusion: 'unit_mismatch', reason: 'Нельзя перевести шт в пачка' }), stats)).toBe('Другая единица: «шт» не переводится в «пачка»')
    expect(exclusionText(entry({ exclusion: 'duplicate', reason: '' }), stats)).toBe('Дубль')
    expect(exclusionText(entry({ exclusion: 'duplicate', reason: 'Дубль строки 1.2 : та же цена' }), stats)).toBe('Дубль строки 1.2: та же цена')
  })
})

describe('humanRule', () => {
  it('правила выбросов по-русски', () => {
    expect(humanRule('IQR: [Q1 − 1.5 × IQR; Q3 + 1.5 × IQR]')).toBe('IQR')
    expect(humanRule('Меньше 5 цен: исключаются цены, отклоняющиеся от медианы более чем на 50 %')).toBe('отклонение от медианы больше 50 %')
    expect(humanRule('Своё правило')).toBe('своё правило')
  })
})

describe('короткие подписи позиций в переключателе', () => {
  it('берёт первые слова названия до 24 символов с многоточием', () => {
    expect(shortPositionLabel('Бумага писчая офсетная А4, 65 г/м²', 2)).toBe('Бумага писчая офсетная…')
    expect(shortPositionLabel('Бумага А4 SvetoCopy, 80 г/м²', 1)).toBe('Бумага А4 SvetoCopy, 80…')
    expect(shortPositionLabel('Скрепки 28 мм', 3)).toBe('Скрепки 28 мм')
    expect(shortPositionLabel('Электрофотографическаябумага повышенной белизны', 1)).toBe('Электрофотографическаяб…')
    for (const label of [shortPositionLabel('Бумага писчая офсетная А4, 65 г/м²', 2), shortPositionLabel('Бумага А4 SvetoCopy, 80 г/м²', 1)]) {
      expect(label.length).toBeLessThanOrEqual(24)
    }
  })

  it('без названия остаётся «Позиция N»', () => {
    expect(shortPositionLabel('  ', 4)).toBe('Позиция 4')
  })
})

const labelsOf = (...names: string[]) => positionLabels(names.map((name, i) => ({ index: i + 1, name })))

describe('positionLabels: вкладки и строки таблицы различимы', () => {
  it('закупка бумаги: общие слова убраны, формат и марка остались', () => {
    const labels = labelsOf(
      'Бумага для офисной техники А4 SvetoCopy',
      'Бумага для офисной техники А3 SvetoCopy',
      'Бумага писчая (офсетная) в листах А4',
    )
    expect([...labels.values()].map((l) => l.tab)).toEqual(['А4 SvetoCopy', 'А3 SvetoCopy', 'Писчая А4'])
    expect([...labels.values()].map((l) => l.row)).toEqual(['Бумага А4 SvetoCopy', 'Бумага А3 SvetoCopy', 'Бумага писчая А4'])
  })

  it('число с единицей не разрывается, короткое название в таблице целиком', () => {
    const labels = labelsOf('Бумага А4 SvetoCopy, 80 г/м²', 'Бумага писчая офсетная А4, 65 г/м²')
    expect(labels.get(1)).toEqual({ tab: 'SvetoCopy 80 г/м²', row: 'Бумага А4 SvetoCopy, 80 г/м²' })
    expect(labels.get(2)).toEqual({ tab: 'Писчая 65 г/м²', row: 'Бумага писчая А4 65 г/м²' })
  })

  it('марка различает похожие позиции, короткие названия не ломаются', () => {
    const cartridges = labelsOf('Картридж лазерный чёрный для HP LaserJet', 'Картридж лазерный чёрный для Canon i-SENSYS', 'Тонер')
    expect([...cartridges.values()].map((l) => l.tab)).toEqual(['HP LaserJet', 'Canon i-SENSYS', 'Тонер'])
    expect(cartridges.get(1)?.row).toBe('Картридж HP LaserJet')
    expect([...labelsOf('Ручка синяя', 'Ручка красная').values()].map((l) => l.tab)).toEqual(['Синяя', 'Красная'])
  })

  it('одна позиция: формат и марка; одинаковые названия: первые слова', () => {
    expect(labelsOf('Бумага для офисной техники А4 SvetoCopy').get(1)).toEqual({ tab: 'А4 SvetoCopy', row: 'Бумага А4 SvetoCopy' })
    expect(shortPositionLabels([{ index: 1, name: 'Скрепки' }, { index: 2, name: 'Скрепки' }]).get(2)).toBe('Скрепки')
  })
})
