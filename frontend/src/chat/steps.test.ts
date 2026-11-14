import { describe, expect, it } from 'vitest'
import type { RunStep } from '../api/types'
import { groupSteps } from './steps'

const step = (over: Partial<RunStep>): RunStep => ({
  source_id: 'eis',
  name: 'ЕИС Закупки',
  level: 1,
  position_index: 1,
  status: 'ok',
  found: 0,
  relevant: 0,
  note: null,
  ...over,
})

describe('groupSteps', () => {
  it('складывает найденное и подошедшее по позициям одного источника', () => {
    const rows = groupSteps([
      step({ position_index: 1, found: 3, relevant: 3 }),
      step({ position_index: 2, found: 2, relevant: 1 }),
      step({ source_id: 'shops', name: 'Маркетплейсы', found: 4, relevant: 2 }),
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ source_id: 'eis', found: 5, relevant: 4 })
    expect(rows[1]).toMatchObject({ source_id: 'shops', found: 4, relevant: 2 })
  })

  it('незавершённое побеждает: поиск идёт, пока хоть одна позиция в работе', () => {
    const [row] = groupSteps([
      step({ status: 'ok', found: 3, relevant: 3 }),
      step({ position_index: 2, status: 'running', found: 0, relevant: null }),
    ])
    expect(row.status).toBe('running')
    expect(row.relevant).toBeNull()
  })

  it('ошибка важнее «ничего не найдено», «найдено» важнее ошибки', () => {
    expect(
      groupSteps([step({ status: 'empty' }), step({ position_index: 2, status: 'error' })])[0].status,
    ).toBe('error')
    expect(
      groupSteps([step({ status: 'error' }), step({ position_index: 2, status: 'ok' })])[0].status,
    ).toBe('ok')
  })

  it('берёт первое примечание и сохраняет порядок источников', () => {
    const rows = groupSteps([
      step({ source_id: 'a', name: 'А', note: 'цены не публикуются' }),
      step({ source_id: 'b', name: 'Б' }),
      step({ source_id: 'a', name: 'А', position_index: 2, note: 'другое' }),
    ])
    expect(rows.map((r) => r.source_id)).toEqual(['a', 'b'])
    expect(rows[0].note).toBe('цены не публикуются')
  })
})
