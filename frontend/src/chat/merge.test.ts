import { describe, expect, it } from 'vitest'
import type { Message } from '../api/types'
import { mergeMessage } from './merge'

const msg = (id: string, at: string, text = id): Message => ({
  id,
  created_at: `2026-11-13T10:${at}:00+03:00`,
  role: 'agent',
  kind: 'text',
  text,
  data: null,
})

describe('mergeMessage', () => {
  it('добавляет новое сообщение в конец', () => {
    const r = mergeMessage([msg('a', '01')], msg('b', '02'))
    expect(r.map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('заменяет сообщение с тем же id на месте', () => {
    const r = mergeMessage([msg('a', '01'), msg('b', '02')], msg('a', '01', 'новый текст'))
    expect(r.map((m) => m.id)).toEqual(['a', 'b'])
    expect(r[0].text).toBe('новый текст')
  })

  it('повторная доставка не создаёт дубль', () => {
    const once = mergeMessage([msg('a', '01')], msg('b', '02'))
    const twice = mergeMessage(once, msg('b', '02'))
    expect(twice).toHaveLength(2)
  })

  it('вставляет по created_at, если событие пришло не по порядку', () => {
    const r = mergeMessage([msg('a', '01'), msg('c', '03')], msg('b', '02'))
    expect(r.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('при равных датах сохраняет порядок поступления', () => {
    const r = mergeMessage([msg('a', '01')], msg('b', '01'))
    expect(r.map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('не меняет исходный массив', () => {
    const src = [msg('a', '01')]
    mergeMessage(src, msg('b', '02'))
    expect(src).toHaveLength(1)
  })
})
