import './event-source'
import './node-base'
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, vi } from 'vitest'
import { db } from '../mocks/db'
import { server } from '../mocks/server'

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  server.resetHandlers()
  db.reset()
  // окно вопросов помнит свёрнутость в sessionStorage: тесты не должны делить её
  if (typeof sessionStorage !== 'undefined') sessionStorage.clear()
})
afterAll(() => server.close())
