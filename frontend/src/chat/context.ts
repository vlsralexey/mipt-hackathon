import { createContext, useContext } from 'react'
import type { Question } from '../api/types'

interface ChatContextValue {
  procurementId: string
  questions?: Question[]
  positions?: { index: number; name: string }[]
  openBrowser?: () => void
  /** Открыть версию отчёта в правой панели. */
  openVersion: (version: number) => void
}

export const ChatContext = createContext<ChatContextValue | null>(null)

export function useChat(): ChatContextValue {
  const value = useContext(ChatContext)
  if (!value) throw new Error('useChat вызван вне чата')
  return value
}
