import { useEffect, useState } from 'react'
import type { SourceBlocked } from '../api/types'

/** Срок ожидания по умолчанию у бэкенда (BrowserManager.wait_seconds). */
export const DEFAULT_WAIT_SECONDS = 300

/**
 * Сколько секунд осталось до `deadline` с бэкенда. Остаток не больше полного
 * срока `waitSeconds`: так расхождение часов клиента и сервера не растягивает таймер.
 */
export function secondsLeft(deadline: string | null | undefined, waitSeconds: number | null | undefined, now: number): number | null {
  if (!deadline) return null
  const at = Date.parse(deadline)
  if (!Number.isFinite(at)) return null
  const left = Math.max(0, (at - now) / 1000)
  return waitSeconds && waitSeconds > 0 ? Math.min(left, waitSeconds) : left
}

/** Целые минуты для текста «через N минут»: не меньше одной. */
export function minutesLeft(seconds: number) {
  return Math.max(1, Math.ceil(seconds / 60))
}

/** Остаток до срока, обновляется раз в секунду. */
export function useCountdown(deadline: string | null | undefined, waitSeconds?: number | null) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!deadline) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [deadline])
  return secondsLeft(deadline, waitSeconds, now)
}

/** Срок карточки чата: с бэкенда, у старых сообщений без него от времени карточки. */
export function deadlineOf(data: Pick<SourceBlocked, 'deadline' | 'wait_seconds'>, createdAt?: string): string | null {
  if (data.deadline) return data.deadline
  const start = createdAt ? Date.parse(createdAt) : NaN
  if (!Number.isFinite(start)) return null
  return new Date(start + (data.wait_seconds ?? DEFAULT_WAIT_SECONDS) * 1000).toISOString()
}
