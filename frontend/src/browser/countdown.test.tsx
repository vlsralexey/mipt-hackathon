import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatContext } from '../chat/context'
import { SourceBlockedCard } from '../chat/messages/NoteCards'
import { deadlineOf, minutesLeft, secondsLeft } from './countdown'

const NOW = Date.parse('2026-11-14T12:00:00Z')
afterEach(() => vi.useRealTimers())

describe('срок ручной проверки', () => {
  it('считает остаток от deadline бэкенда и не превышает полный срок', () => {
    expect(secondsLeft('2026-11-14T12:04:00Z', 300, NOW)).toBe(240)
    // Часы клиента отстают от сервера: таймер не растягивается дольше срока.
    expect(secondsLeft('2026-11-14T12:10:00Z', 300, NOW)).toBe(300)
    expect(secondsLeft('2026-11-14T11:59:00Z', 300, NOW)).toBe(0)
    expect(secondsLeft(null, 300, NOW)).toBeNull()
  })

  it('берёт срок карточки с бэкенда, а у старой карточки считает от её времени', () => {
    expect(deadlineOf({ deadline: '2026-11-14T12:03:00Z', wait_seconds: 300 }, '2026-11-14T11:00:00Z')).toBe('2026-11-14T12:03:00Z')
    expect(deadlineOf({}, '2026-11-14T12:00:00Z')).toBe('2026-11-14T12:05:00.000Z')
    expect(deadlineOf({}, undefined)).toBeNull()
    expect(minutesLeft(240)).toBe(4)
    expect(minutesLeft(10)).toBe(1)
  })

  it('текст в чате совпадает с таймером браузера', () => {
    vi.useFakeTimers({ now: NOW })
    const client = new QueryClient()
    render(
      <QueryClientProvider client={client}>
        <ChatContext.Provider value={{ procurementId: 'p1', openVersion: () => {} }}>
          <SourceBlockedCard
            text={null}
            createdAt="2026-11-14T11:59:00Z"
            data={{ source_id: 'shop', name: 'Магазин', url: 'https://shop.example', reason: 'captcha', status: 'waiting', deadline: '2026-11-14T12:02:30Z', wait_seconds: 300 }}
          />
        </ChatContext.Provider>
      </QueryClientProvider>,
    )
    expect(screen.getByText(/пропустит сайт через 3 минуты/)).toBeInTheDocument()
  })
})
