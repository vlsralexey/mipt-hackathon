import { createContext, useContext } from 'react'

interface ChatContextValue {
  procurementId: string
  /** Открыть версию отчёта в правой панели. */
  openVersion: (version: number) => void
}

export const ChatContext = createContext<ChatContextValue | null>(null)

export function useChat(): ChatContextValue {
  const value = useContext(ChatContext)
  if (!value) throw new Error('useChat вызван вне чата')
  return value
}
