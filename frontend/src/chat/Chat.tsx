import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client'
import type { Procurement, Question } from '../api/types'
import { Composer } from '../components/Composer'
import { ChatContext, type DockedState } from './context'
import { mergeMessage } from './merge'
import { QuestionPill, QuestionPopup } from './QuestionPopup'
import { waitingLabel } from './waiting'
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

/** Что окно вопросов помнит, пока открыта вкладка: свёрнуто ли и какие вопросы в нём. */
interface PopupMemory {
  collapsed: boolean
  queued: string[]
}

const memoryKey = (id: string) => `question-popup:${id}`

function recall(id: string): PopupMemory {
  try {
    const raw = sessionStorage.getItem(memoryKey(id))
    const value = raw ? (JSON.parse(raw) as Partial<PopupMemory>) : {}
    return { collapsed: value.collapsed === true, queued: Array.isArray(value.queued) ? value.queued : [] }
  } catch {
    return { collapsed: false, queued: [] }
  }
}

function remember(id: string, memory: PopupMemory) {
  try {
    sessionStorage.setItem(memoryKey(id), JSON.stringify(memory))
  } catch {
    // хранилище недоступно (приватное окно): окно просто не запомнит состояние
  }
}

/** Чат с агентом: история, ответы по SSE, окно уточняющих вопросов и поле ввода. */
export function Chat({ procurement, viewingVersion, onOpenVersion, onOpenBrowser }: ChatProps) {
  const { id } = procurement
  useProcurementEvents(id)
  const queryClient = useQueryClient()
  const [text, setText] = useState('')

  // В окне и в счётчике все неотвеченные вопросы закупки, в том числе пришедшие до
  // перезагрузки. Само окно разворачивается только на новый вопрос (пришёл, пока человек
  // здесь, или был в окне за эту сессию вкладки); со старыми видна строка со счётчиком.
  // Вопрос с одним вариантом в окно не попадает: выбирать нечего, он виден в ленте.
  const [memory] = useState(() => recall(id))
  const [seenAtOpen] = useState(() => {
    const queued = new Set(memory.queued)
    return new Set(procurement.messages.flatMap((m) => m.kind === 'question' && !queued.has(m.data.id) ? [m.data.id] : []))
  })
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set())
  const queue = useMemo(
    () =>
      procurement.messages.flatMap((m) =>
        m.kind === 'question' && m.data.answer === null && m.data.options.length > 1 && !answered.has(m.data.id)
          ? [m.data]
          : [],
      ),
    [procurement.messages, answered],
  )
  const firstFresh = queue.findIndex((q) => !seenAtOpen.has(q.id))
  const [collapsed, setCollapsed] = useState(memory.collapsed)
  // Человек сам открыл окно со старыми вопросами.
  const [pulled, setPulled] = useState(false)
  const [currentId, setCurrentId] = useState<string | null>(null)
  const found = queue.findIndex((q) => q.id === currentId)
  const index = found >= 0 ? found : Math.max(firstFresh, 0)
  const current: Question | undefined = queue[index]
  const shownId = current?.id ?? null
  const expanded = !!current && !collapsed && (firstFresh >= 0 || pulled)

  // Помним только новые вопросы: после перезагрузки окно развернётся на них, а не на старых.
  const queueIds = queue.flatMap((q) => seenAtOpen.has(q.id) ? [] : [q.id]).join(' ')
  useEffect(() => {
    remember(id, { collapsed, queued: queueIds ? queueIds.split(' ') : [] })
  }, [id, collapsed, queueIds])

  // Куда перевести фокус после явного действия: в окно при открытии, на строку при сворачивании.
  const [focusPopup, setFocusPopup] = useState(false)
  const focusPill = useRef(false)
  const pillRef = useCallback((el: HTMLButtonElement | null) => {
    if (el && focusPill.current) el.focus()
    focusPill.current = false
  }, [])

  const markAnswered = useCallback((ids: string[]) => {
    // Окно переходит к следующему неотвеченному вопросу после текущего.
    setCurrentId((chosen) => {
      const cur = chosen ?? shownId
      if (cur && !ids.includes(cur) && queue.some((q) => q.id === cur)) return cur
      const at = queue.findIndex((q) => q.id === cur)
      const after = queue.slice(Math.max(at, 0) + 1).find((q) => !ids.includes(q.id))
      return (after ?? queue.find((q) => !ids.includes(q.id)))?.id ?? null
    })
    setAnswered((prev) => new Set([...prev, ...ids]))
  }, [queue, shownId])
  const collapse = useCallback((fromInside: boolean) => {
    focusPill.current = fromInside
    setCollapsed(true)
    setFocusPopup(false)
  }, [])
  const navigate = useCallback((to: number) => setCurrentId(queue[to]?.id ?? null), [queue])
  const openQuestion = useCallback((questionId?: string) => {
    if (questionId) setCurrentId(questionId)
    setCollapsed(false)
    setPulled(true)
    setFocusPopup(true)
  }, [])
  const docked = useCallback(
    (questionId: string): DockedState | null =>
      !expanded ? null : questionId === current?.id ? 'current' : queue.some((q) => q.id === questionId) ? 'queued' : null,
    [expanded, current, queue],
  )

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

  const announcement = !current ? '' : expanded
    ? `Вопрос ${index + 1} из ${queue.length}: ${current.text}`
    : waitingLabel(queue.length)

  return (
    <ChatContext.Provider value={{
      procurementId: id,
      openVersion: onOpenVersion,
      openBrowser: onOpenBrowser,
      questions: procurement.messages.flatMap((m) => m.kind === 'question' ? [m.data] : []),
      positions: procurement.messages.flatMap((m) => m.kind === 'tz_summary' ? m.data.positions : []),
      docked,
      openQuestion,
      answered: markAnswered,
    }}>
      <Thread messages={procurement.messages} agentBusy={procurement.agent_busy} />
      <div className={styles.composer}>
        <p className={styles.srOnly} aria-live="polite">{announcement}</p>
        {current && (
          <div className={styles.popupSlot}>
            {expanded ? (
              <QuestionPopup
                questions={queue}
                index={index}
                onNavigate={navigate}
                onCollapse={collapse}
                takeFocus={focusPopup}
                onFocusTaken={() => setFocusPopup(false)}
              />
            ) : (
              <QuestionPill ref={pillRef} count={queue.length} onOpen={() => openQuestion()} />
            )}
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
