import { useEffect, useLayoutEffect, useRef } from 'react'
import type { Message } from '../api/types'
import { groupMessages } from './groups'
import { ChatMessage } from './messages/ChatMessage'
import styles from './Thread.module.css'

const NEAR_BOTTOM_PX = 120

interface ThreadProps {
  messages: Message[]
  agentBusy: boolean
}

/** Лента сообщений. Прокручивается к новому, только если читатель и так был внизу. */
export function Thread({ messages, agentBusy }: ThreadProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  const last = messages.at(-1)
  // при замене сообщения на месте (ход поиска) меняется содержимое, а не id, поэтому следим и за ним
  const tick = `${last?.id}:${JSON.stringify(last?.data ?? null).length}:${agentBusy}`

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stuck.current) el.scrollTop = el.scrollHeight
  }, [tick])

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onScroll = () => {
      stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    // Окно вопросов над полем ввода сжимает ленту: читатель внизу остаётся внизу.
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (stuck.current) el.scrollTop = el.scrollHeight
    })
    resize?.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      resize?.disconnect()
    }
  }, [])

  return (
    <div className={styles.thread} ref={scroller}>
      <div className={styles.inner}>
        {groupMessages(messages).map((group) =>
          group[0].role === 'user' ? (
            <div key={group[0].id} className={styles.userBlock}>
              {group.map((m) => (
                <ChatMessage key={m.id} message={m} />
              ))}
            </div>
          ) : (
            <ChatMessage key={group[0].id} message={group[0]} />
          ),
        )}
        <div className={styles.busy} role="status">
          {agentBusy && (
            <>
              Агент думает<span className={styles.dots} aria-hidden="true" />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
