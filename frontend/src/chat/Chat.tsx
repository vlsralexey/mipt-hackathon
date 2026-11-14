import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { api } from '../api/client'
import type { Procurement } from '../api/types'
import { Composer } from '../components/Composer'
import { ChatContext } from './context'
import { mergeMessage } from './merge'
import { QuestionPopup } from './QuestionPopup'
import { Thread } from './Thread'
import { procurementKey, useProcurementEvents } from './useProcurementEvents'
import styles from './Chat.module.css'

interface ChatProps {
  procurement: Procurement
  /** Версия, открытая в панели отчёта: по ней агент понимает, о какой таблице речь. */
  viewingVersion: number | null
  onOpenVersion: (version: number) => void
  onOpenBrowser?: () => void
}

/** Чат с агентом: история, ответы по SSE, всплывающие вопросы и поле ввода. */
export function Chat({ procurement, viewingVersion, onOpenVersion, onOpenBrowser }: ChatProps) {
  const { id } = procurement
  useProcurementEvents(id)
  const queryClient = useQueryClient()
  const [text, setText] = useState('')

  // Вопросы, которые были в чате при открытии закупки, не всплывают: они уже в ленте.
  // Всплывают только те, что пришли, пока человек здесь, и пока на них нет ответа.
  const [seenAtOpen] = useState(
    () => new Set(procurement.messages.filter((m) => m.kind === 'question').map((m) => m.id)),
  )
  const [handled, setHandled] = useState<ReadonlySet<string>>(new Set())
  const pending = useMemo(
    () =>
      procurement.messages.flatMap((m) =>
        m.kind === 'question' && m.data.answer === null && !seenAtOpen.has(m.id) && !handled.has(m.id)
          ? [m]
          : [],
      ),
    [procurement.messages, seenAtOpen, handled],
  )
  const popup = pending[0]
  const hiddenIds = useMemo(() => new Set(pending.map((m) => m.id)), [pending])
  const markHandled = (messageId: string) => setHandled((prev) => new Set(prev).add(messageId))

  const send = useMutation({
    mutationFn: (body: string) => api.sendMessage(id, body, viewingVersion ?? undefined),
    onSuccess: (message) =>
      // то же сообщение затем придёт по SSE и заменит это по id, дубля не будет
      queryClient.setQueryData<Procurement>(procurementKey(id), (old) =>
        old ? { ...old, messages: mergeMessage(old.messages, message) } : old,
      ),
    // при ошибке возвращаем текст в поле, если пользователь успел начать новый
    onError: (_error, body) => setText((current) => current || body),
  })

  function submit() {
    const body = text.trim()
    if (!body) return
    setText('')
    send.mutate(body)
  }

  return (
    <ChatContext.Provider value={{ procurementId: id, openVersion: onOpenVersion, openBrowser: onOpenBrowser }}>
      <Thread messages={procurement.messages} hiddenIds={hiddenIds} agentBusy={procurement.agent_busy} />
      <div className={styles.composer}>
        {popup && popup.kind === 'question' && (
          // key: следующий вопрос в очереди открывается как новое окно, с выбором «с нуля»
          <div className={styles.popupSlot}>
            <QuestionPopup
              key={popup.id}
              question={popup.data}
              onClose={() => markHandled(popup.id)}
              onAnswered={() => markHandled(popup.id)}
            />
          </div>
        )}
        <Composer
          text={text}
          onTextChange={setText}
          placeholder="Уточните требования или спросите про расчёт"
          label="Сообщение агенту"
          error={send.error?.message ?? null}
          onSubmit={submit}
        />
      </div>
    </ChatContext.Provider>
  )
}
