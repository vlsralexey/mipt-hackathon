import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserFrame, BrowserTab, JournalEvent } from '../api/types'

export type Connection = 'connecting' | 'open' | 'lost'
const JOURNAL_LIMIT = 50

/** Подписка на WS /api/browser: вкладки, кадр выбранной вкладки, управление и журнал. */
export function useBrowserSession(procurementId: string, active: boolean) {
  const socket = useRef<WebSocket | null>(null)
  const selectedRef = useRef<string | null>(null)
  const [tabs, setTabs] = useState<BrowserTab[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [frames, setFrames] = useState<Record<string, BrowserFrame>>({})
  const [controllers, setControllers] = useState<Record<string, string>>({})
  const [cursors, setCursors] = useState<Record<string, string>>({})
  const [journal, setJournal] = useState<JournalEvent[]>([])
  const [connection, setConnection] = useState<Connection>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    if (!active || typeof WebSocket === 'undefined') return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const connect = () => {
      if (disposed) return
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${protocol}//${location.host}/api/browser?procurement_id=${encodeURIComponent(procurementId)}`)
      socket.current = ws
      setControllers({})
      setConnection('connecting')
      ws.onopen = () => { if (disposed || socket.current !== ws) return; setConnection('open'); setError(null) }
      ws.onmessage = (event) => {
        if (disposed || socket.current !== ws) return
        let value
        try { value = JSON.parse(String(event.data)) } catch { setError('Не удалось прочитать обновление браузера'); return }
        if (value.type === 'tabs') {
          const next = value.tabs as BrowserTab[]
          setTabs(next)
          setSelected((current) => {
            const id = next.some((t) => t.id === current) ? current : value.selected_tab_id ?? next[0]?.id ?? null
            selectedRef.current = id
            if (id && id !== value.selected_tab_id) ws.send(JSON.stringify({ type: 'select', tab_id: id }))
            return id
          })
          setFrames((current) => Object.fromEntries(Object.entries(current).filter(([id]) => next.some((t) => t.id === id))))
        } else if (value.type === 'frame') setFrames((current) => ({ ...current, [value.tab_id]: value as BrowserFrame }))
        else if (value.type === 'control') setControllers((current) => ({ ...current, [value.tab_id]: value.by }))
        else if (value.type === 'cursor') setCursors((current) => ({ ...current, [value.tab_id]: value.cursor }))
        else if (value.type === 'journal') {
          const events = value.events as JournalEvent[]
          setJournal((current) => (value.full ? events : [...current, ...events]).slice(-JOURNAL_LIMIT))
        } else if (value.type === 'error') setError(value.detail)
      }
      ws.onclose = () => {
        if (!disposed && socket.current === ws) { setControllers({}); setConnection('lost'); timer = setTimeout(connect, 2000) }
      }
      ws.onerror = () => { if (!disposed) setConnection('lost') }
    }
    connect()
    return () => { disposed = true; clearTimeout(timer); socket.current?.close(); socket.current = null }
  }, [procurementId, active, retry])

  // Ошибка действия видна несколько секунд и уходит сама.
  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => setError(null), 6000)
    return () => clearTimeout(timer)
  }, [error])

  const send = useCallback((value: Record<string, unknown>) => {
    if (socket.current?.readyState !== WebSocket.OPEN) { setError('Браузер ещё не подключён'); return false }
    socket.current.send(JSON.stringify({ ...value, tab_id: selectedRef.current }))
    return true
  }, [])
  const sendRaw = useCallback((value: Record<string, unknown>) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(value))
  }, [])
  const select = useCallback((id: string) => {
    selectedRef.current = id
    setSelected(id)
    send({ type: 'select' })
  }, [send])
  const reconnect = useCallback(() => setRetry((v) => v + 1), [])

  return { tabs, selected, frames, controllers, cursors, journal, connection, error, send, sendRaw, select, reconnect }
}
