import { describe, expect, it } from 'vitest'
import type { Message } from '../api/types'
import { groupMessages } from './groups'

const m = (id: string, role: Message['role']): Message => ({
  id,
  created_at: '2026-11-13T10:00:00+03:00',
  role,
  kind: 'text',
  text: id,
  data: null,
})

describe('groupMessages', () => {
  it('склеивает подряд идущие сообщения пользователя', () => {
    const groups = groupMessages([m('1', 'user'), m('2', 'user'), m('3', 'agent'), m('4', 'user')])
    expect(groups.map((g) => g.map((x) => x.id))).toEqual([['1', '2'], ['3'], ['4']])
  })

  it('сообщения агента и системы не склеиваются', () => {
    const groups = groupMessages([m('1', 'agent'), m('2', 'agent'), m('3', 'system')])
    expect(groups).toHaveLength(3)
  })
})
