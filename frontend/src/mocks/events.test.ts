// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { api } from '../api/client'
import type { Message } from '../api/types'
import { mockTiming } from './handlers'

// В jsdom нет EventSource, поэтому подписываемся напрямую на шину моков;
// SSE-обработчик MSW использует ту же шину.
import { db } from './db'

describe('эмулятор событий', () => {
  it('сообщение пользователя уходит в SSE, затем приходит ответ агента', async () => {
    mockTiming.agentReplyMs = 0
    const [{ id }] = await api.listProcurements()
    const seen: string[] = []
    db.subscribe(id, (e) => seen.push(e.event === 'message' ? `message:${e.data.role}` : `${e.event}`))

    const saved: Message = await api.sendMessage(id, 'Исключи контракт 3810', 1)
    expect(saved.role).toBe('user')
    await new Promise((r) => setTimeout(r, 20))

    expect(seen).toEqual(['message:user', 'agent', 'message:agent', 'agent'])
    mockTiming.agentReplyMs = 1200
  })
})
