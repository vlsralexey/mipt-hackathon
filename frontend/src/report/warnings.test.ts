import { describe, expect, it } from 'vitest'
import type { PositionReport, Report, SkippedPage } from '../api/types'
import example from '../../../docs/api-examples/report.json'
import { groupWarnings, joinRu, sourceGroup } from './warnings'

const A4 = 'Бумага для офисной техники А4 SvetoCopy'
const A3 = 'Бумага для офисной техники А3 SvetoCopy'
const WRITING = 'Бумага писчая (офсетная) в листах А4'

const page = (url: string, source_id: string, reason: string): SkippedPage => ({ url, source_id, reason })
const UNAVAILABLE = 'Источник недоступен: ошибка сети, таймаут или ограничение запросов'

/** Позиция; `priced: false`: в расчёте нет ни одной цены. */
function position(index: number, name: string, skipped: SkippedPage[] = [], priced = true): PositionReport {
  const included = priced ? [{ normalized_price: '300.00' }] : []
  return { position: { index, name }, skipped_pages: skipped, included } as unknown as PositionReport
}

/** Строки как в настоящем отчёте закупки бумаги (версия 3): бэкенд ставит « : » вместо тире. */
const paper: Pick<Report, 'warnings' | 'positions' | 'sources' | 'rules'> = {
  rules: { min_prices: 3 },
  sources: [
    { source_id: 'eis', name: 'ЕИС : реестр контрактов' },
    { source_id: 'web_suppliers', name: 'Производители и дистрибьюторы' },
    { source_id: 'web_shops', name: 'Открытые магазины' },
  ] as Report['sources'],
  positions: [
    position(1, A4, [
      page('https://zakupki.gov.ru/1', 'eis', UNAVAILABLE),
      page('https://zakupki.gov.ru/2', 'eis', UNAVAILABLE),
      page('https://shop.example/a', 'web_suppliers', 'На странице не найдено предложений по позиции ТЗ'),
      page('https://shop.example/b', 'web_suppliers', 'Источник ограничил доступ к странице'),
    ]),
    position(2, A3, [
      // та же страница ЕИС, что и у позиции 1: считаем один раз
      page('https://zakupki.gov.ru/1', 'eis', UNAVAILABLE),
      page('https://zakupki.gov.ru/9', 'eis', 'Не указан номер строки объекта закупки ЕИС'),
    ]),
    position(3, WRITING, [page('https://market.example/x', 'web_shops', UNAVAILABLE)], false),
  ],
  warnings: [
    `Позиция 1 «${A4}»: доставка не подтверждена у 1 из 6 предложений : цена может быть занижена`,
    `Позиция 2 «${A3}»: НДС не подтверждён у 2 из 3 предложений : цена может быть занижена`,
    `Позиция 2 «${A3}»: доставка не подтверждена у 3 из 3 предложений : цена может быть занижена`,
    `Позиция 3 «${WRITING}»: найдено 0 цен, обоснование недостаточно`,
    `Позиция 3 «${WRITING}»: не по всем контрактам удалось проверить отсутствие неустоек`,
    'Источник «ЕИС : реестр контрактов», позиция 1: Источник недоступен: ошибка сети, таймаут или ограничение запросов',
    'Источник «Производители и дистрибьюторы», позиция 1: Не удалось обработать источник: изменился формат страницы или ответа; Источник ограничил доступ к странице',
    'Источник «ЕИС : реестр контрактов», позиция 2: Источник недоступен: ошибка сети, таймаут или ограничение запросов',
    'Источник «Открытые магазины», позиция 3: Источник недоступен: ошибка сети, таймаут или ограничение запросов',
    'Требования ТЗ при поставке (доставка, разгрузка, занос в помещение 1 этаж) в найденных ценах не отражены',
  ],
}

describe('groupWarnings', () => {
  it('однотипные строки объединяются, всего не больше четырёх пунктов', () => {
    const lines = groupWarnings(paper).map((l) => l.text)
    expect(lines).toEqual([
      'Цена может быть занижена: НДС не подтверждён (поз. 2).',
      'Доставка, разгрузка и занос из ТЗ в ценах не учтены.',
      'Позиция 3: не найдено ни одной цены.',
      '4 страницы не открылись: ЕИС, сайты производителей и магазины.',
    ])
  })

  it('неустойки и занижение не упоминаются у позиции без цен в расчёте', () => {
    const lines = groupWarnings({
      ...paper,
      positions: [position(1, A4), position(3, WRITING, [], false)],
      warnings: [
        `Позиция 1 «${A4}»: не по всем контрактам удалось проверить отсутствие неустоек`,
        `Позиция 3 «${WRITING}»: не по всем контрактам удалось проверить отсутствие неустоек`,
        `Позиция 3 «${WRITING}»: НДС не подтверждён у 1 из 2 предложений : цена может быть занижена`,
      ],
    }).map((l) => l.text)
    expect(lines).toEqual(['Не по всем контрактам удалось проверить отсутствие неустоек (поз. 1).'])
  })

  it('без требований ТЗ к доставке «доставка не подтверждена» остаётся', () => {
    const lines = groupWarnings({ ...paper, warnings: paper.warnings.slice(0, 3) }).map((l) => l.text)
    expect(lines[0]).toBe('Цена может быть занижена: доставка не подтверждена (поз. 1 и 2), НДС не подтверждён (поз. 2).')
  })

  it('страницы, которые не открылись, считаются без повторов и раскрываются списком по источникам', () => {
    const sources = groupWarnings(paper).at(-1)!.sources!
    expect(sources.map((s) => s.name)).toEqual(['ЕИС: реестр контрактов', 'Производители и дистрибьюторы', 'Открытые магазины'])
    expect(sources[0].pages.map((p) => p.url)).toEqual(['https://zakupki.gov.ru/1', 'https://zakupki.gov.ru/2'])
    // отброшенные по смыслу страницы (нет предложений, нет номера строки) в список не попадают
    expect(sources.flatMap((s) => s.pages).some((p) => /не найдено|номер строки/.test(p.reason))).toBe(false)
  })

  it('в текстах нет « : » и длинных тире', () => {
    const all = groupWarnings(paper).flatMap((l) => [l.text, ...(l.sources ?? []).flatMap((s) => [s.name, ...s.pages.map((p) => p.reason)])])
    for (const t of all) {
      expect(t).not.toMatch(/\s:\s/)
      expect(t).not.toMatch(/[\u2014\u2013]/)
    }
  })

  it('источник с ошибкой без страниц: строка «ответил с ошибкой» и причины', () => {
    const lines = groupWarnings({
      ...paper,
      positions: [position(1, A4)],
      warnings: ['Источник «ЕИС : реестр контрактов», позиция 1: источник недоступен'],
    })
    expect(lines).toEqual([
      { text: 'Источник ответил с ошибкой: ЕИС.', sources: [{ name: 'ЕИС: реестр контрактов', pages: [], errors: ['источник недоступен'] }] },
    ])
  })

  it('несколько найденных цен: сказано, сколько нужно; неоднородность остаётся с подробностями', () => {
    const lines = groupWarnings({
      ...paper,
      positions: [position(1, A4), position(2, A3)],
      warnings: [
        `Позиция 1 «${A4}»: найдено 2 цены, обоснование недостаточно`,
        `Позиция 2 «${A3}»: выборка неоднородна (CV = 41 %)`,
      ],
    }).map((l) => l.text)
    expect(lines).toEqual(['Позиция 1: найдено 2 цены, для обоснования нужно не меньше 3.', 'Позиция 2: выборка неоднородна (CV = 41 %).'])
  })

  it('индексация по части цен объединяется без чисел, нераспознанное выводится как есть', () => {
    const lines = groupWarnings({
      ...paper,
      positions: [position(1, A4), position(2, A3)],
      warnings: [
        `Позиция 1 «${A4}»: для 2 цен прошлых периодов нет данных ИПЦ, индексация не применена`,
        `Позиция 2 «${A3}»: для 1 цен прошлых периодов нет данных ИПЦ, индексация не применена`,
        'Порог однородности 40 % мягче методических рекомендаций (33 %)',
        'Порог однородности 40 % мягче методических рекомендаций (33 %)',
      ],
    }).map((l) => l.text)
    expect(lines).toEqual([
      'Для части цен прошлых периодов нет данных ИПЦ, индексация не применена (поз. 1 и 2).',
      'Порог однородности 40 % мягче методических рекомендаций (33 %).',
    ])
  })

  it('пример контракта: запятая вместо двоеточия тоже узнаётся', () => {
    const lines = groupWarnings(example as unknown as Report).map((l) => l.text)
    expect(lines[0]).toBe('Цена может быть занижена: НДС не подтверждён (поз. 1), доставка не подтверждена (поз. 1 и 2).')
    expect(lines).toContain('Позиция 2: найдено 2 цены, для обоснования нужно не меньше 3.')
  })

  it('без предупреждений пусто', () => {
    expect(groupWarnings({ ...paper, warnings: [], positions: [position(1, A4)] })).toEqual([])
  })
})

describe('sourceGroup', () => {
  it('группы источников в нижнем регистре и без своего «и»', () => {
    expect(sourceGroup('ЕИС: реестр контрактов')).toBe('ЕИС')
    expect(sourceGroup('Каталоги производителей и дистрибьюторов')).toBe('сайты производителей')
    expect(sourceGroup('Открытые магазины')).toBe('магазины')
    expect(sourceGroup('Маркетплейсы')).toBe('маркетплейсы')
    expect(sourceGroup('Агрегаторы цен и прайсы')).toBe('агрегаторы цен')
  })
})

describe('joinRu', () => {
  it('перечисление по-русски', () => {
    expect(joinRu(['1'])).toBe('1')
    expect(joinRu(['1', '2'])).toBe('1 и 2')
    expect(joinRu(['1', '2', '3'])).toBe('1, 2 и 3')
  })
})
