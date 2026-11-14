import { describe, expect, it } from 'vitest'
import type { OfferEntry, Report } from '../api/types'
import report from '../../../docs/api-examples/report.json'
import { priceSteps } from './priceSteps'

const entries = (report as unknown as Report).positions[0]
const find = (label: string) =>
  [...entries.included, ...entries.excluded].find((e) => e.label === label) as OfferEntry

describe('priceSteps', () => {
  it('для чистой цены показывает страницу, единицу ТЗ и итог без лишнего', () => {
    const steps = priceSteps(find('1.1'))
    expect(steps).toHaveLength(3)
    expect(steps[0]).toMatch(/^На странице: 305,00\s₽ за 1 пач$/)
    expect(steps.at(-1)).toMatch(/^Расчётная цена: 305,00\s₽$/)
  })

  it('неизвестные НДС и доставка объясняются своими примечаниями', () => {
    const steps = priceSteps(find('1.5'))
    expect(steps).toContain('НДС: НДС на странице не указан')
    expect(steps).toContain('Доставка: Стоимость доставки не указана на странице')
    // фасовка: цена за коробку из 5 пачек приводится к пачке
    expect(steps[0]).toMatch(/1\s320,00\s₽ за 5 пачка/)
  })

  it('добавленная доставка показана суммой', () => {
    const base = find('1.1')
    const steps = priceSteps({
      ...base,
      delivery: { status: 'added', added_per_unit: '12.00', note: 'Доставка отдельно' },
    })
    expect(steps.join('\n')).toMatch(/Доставка: Доставка отдельно \(\+12,00\s₽\)/)
  })
})
