import { describe, expect, it } from 'vitest'
import type { OfferEntry, Report } from '../api/types'
import report from '../../../docs/api-examples/report.json'
import { priceSteps } from './priceSteps'

const entries = (report as unknown as Report).positions[0]
const find = (label: string) =>
  [...entries.included, ...entries.excluded].find((e) => e.label === label) as OfferEntry

describe('priceSteps', () => {
  it('чистая цена: страница, НДС, индексация, доставка без лишней строки единицы, итог', () => {
    const { steps, total } = priceSteps(find('1.1'))
    expect(steps.map((s) => s.label)).toEqual(['На странице', 'НДС', 'Индексация', 'Доставка'])
    expect(steps[0].text).toMatch(/^305,00\s₽ за 1 пач$/)
    expect(steps.every((s) => !s.changes)).toBe(true)
    expect(total).toMatch(/^305,00\s₽$/)
  })

  it('фасовка приводится к единице ТЗ, неизвестные НДС и доставка объясняются примечаниями', () => {
    const { steps } = priceSteps(find('1.5'))
    expect(steps[0].text).toMatch(/1\s320,00\s₽ за 5 пачка/)
    expect(steps[1]).toEqual({ label: 'За единицу ТЗ', text: expect.stringMatching(/264,00/), changes: true })
    expect(steps).toContainEqual({ label: 'НДС', text: 'НДС на странице не указан', changes: false })
    expect(steps).toContainEqual({ label: 'Доставка', text: 'Стоимость доставки не указана на странице', changes: false })
  })

  it('добавленная доставка показана суммой и выделена', () => {
    const base = find('1.1')
    const { steps } = priceSteps({
      ...base,
      delivery: { status: 'added', added_per_unit: '12.00', note: 'Доставка отдельно' },
    })
    expect(steps.at(-1)!.text).toMatch(/^Доставка отдельно \(\+12,00\s₽\)$/)
    expect(steps.at(-1)!.changes).toBe(true)
  })
})
