import { createContext, useContext } from 'react'
import type { Question } from '../api/types'

/** Где сейчас вопрос из окна над полем ввода: открыт в нём или ждёт своей очереди. */
export type DockedState = 'current' | 'queued'

interface ChatContextValue {
  procurementId: string
  questions?: Question[]
  positions?: { index: number; name: string }[]
  openBrowser?: () => void
  /** Открыть версию отчёта в правой панели. */
  openVersion: (version: number) => void
  /** Вопрос показан в окне над полем ввода: в ленте он сжат до строки «открыт ниже». */
  docked?: (questionId: string) => DockedState | null
  /** Развернуть окно вопросов на этом вопросе. */
  openQuestion?: (questionId: string) => void
  /** Сервер принял ответ: вопрос уходит из окна, не дожидаясь события. */
  answered?: (questionIds: string[]) => void
}

export const ChatContext = createContext<ChatContextValue | null>(null)

export function useChat(): ChatContextValue {
  const value = useContext(ChatContext)
  if (!value) throw new Error('useChat вызван вне чата')
  return value
}
