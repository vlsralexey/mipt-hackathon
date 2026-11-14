import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import type { BrowserTab } from '../api/types'
import styles from './BrowserPanel.module.css'

type Frame = { tab_id: string; data: string; width: number; height: number }
/** Все вкладки управляемого браузера; кадры приходят только для выбранной. */
export function BrowserPanel({ procurementId, active }: { procurementId: string; active: boolean }) {
  return <BrowserSession key={procurementId} procurementId={procurementId} active={active} />
}
function BrowserSession({ procurementId, active }: { procurementId: string; active: boolean }) {
  const viewport = useRef<HTMLDivElement>(null)
  const pressedMouse = useRef(false)
  const pointer = useRef({ x: 0, y: 0 })
  const pressedKeys = useRef(new Set<string>())
  const socket = useRef<WebSocket | null>(null)
  const lastMove = useRef(0)
  const selectedRef = useRef<string | null>(null)
  const [tabs, setTabs] = useState<BrowserTab[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [frames, setFrames] = useState<Record<string, Frame>>({})
  const [controllers, setControllers] = useState<Record<string, string>>({})
  const [connection, setConnection] = useState('Подключение к браузеру…')
  const [error, setError] = useState<string | null>(null)
  const [text, setText] = useState('')
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
      pressedKeys.current.clear()
      pressedMouse.current = false
      ws.onopen = () => { if (disposed || socket.current !== ws) return; setConnection('Браузер подключён'); setError(null) }
      ws.onmessage = (event) => {
        if (disposed || socket.current !== ws) return
        try {
          const value = JSON.parse(String(event.data))
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
          } else if (value.type === 'frame') setFrames((current) => ({ ...current, [value.tab_id]: value as Frame }))
          else if (value.type === 'control') setControllers((current) => ({ ...current, [value.tab_id]: value.by }))
          else if (value.type === 'error') setError(value.detail)
        } catch { setError('Не удалось прочитать обновление браузера. Переподключитесь.') }
      }
      ws.onclose = () => {
        if (!disposed && socket.current === ws) { setControllers({}); setConnection('Связь прервана. Переподключение…'); timer = setTimeout(connect, 2000) }
      }
      ws.onerror = () => { if (!disposed) setError('Нет связи с браузером агента. Проверьте подключение к серверу.') }
    }
    connect()
    return () => { disposed = true; clearTimeout(timer); socket.current?.close(); socket.current = null }
  }, [procurementId, active, retry])

  function send(value: Record<string, unknown>) {
    if (socket.current?.readyState !== WebSocket.OPEN) { setError('Браузер ещё не подключён. Повторите действие после подключения.'); return }
    socket.current.send(JSON.stringify({ ...value, tab_id: selectedRef.current }))
  }
  const tab = tabs.find((t) => t.id === selected)
  const frame = selected ? frames[selected] : undefined
  const userControl = selected ? controllers[selected] === 'user' : false
  function mouse(e: MouseEvent<HTMLImageElement>, event: string) {
    if (!userControl || !frame) return
    const bounds = e.currentTarget.getBoundingClientRect()
    if (event === 'down') e.currentTarget.focus({ preventScroll: true })
    pointer.current = { x: Math.max(0, Math.min(frame.width, Math.round((e.clientX - bounds.left) * frame.width / bounds.width))), y: Math.max(0, Math.min(frame.height, Math.round((e.clientY - bounds.top) * frame.height / bounds.height))) }
    if (event === 'down') pressedMouse.current = true
    if (event === 'up') pressedMouse.current = false
    send({ type: 'mouse', event, ...pointer.current, button: 'left' })
  }
  function keyboard(e: KeyboardEvent, event: string) {
    if (!userControl || e.nativeEvent.isComposing || e.key === 'Unidentified' || e.key === 'Dead') return
    e.preventDefault()
    const key = e.key === ' ' ? 'Space' : e.key
    if (event === 'down') pressedKeys.current.add(key)
    else pressedKeys.current.delete(key)
    send({ type: 'key', event, key })
  }
  // React делегирует wheel пассивно: native listener нужен, чтобы не прокручивать сам интерфейс.
  useEffect(() => {
    const element = viewport.current
    if (!element || !userControl) return
    const up = () => {
      if (pressedMouse.current) {
        send({ type: 'mouse', event: 'up', ...pointer.current, button: 'left' })
        pressedMouse.current = false
      }
    }
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      send({ type: 'wheel', dx: event.deltaX, dy: event.deltaY })
    }
    element.addEventListener('wheel', wheel, { passive: false })
    window.addEventListener('mouseup', up)
    return () => { element.removeEventListener('wheel', wheel); window.removeEventListener('mouseup', up) }
  }, [userControl, selected, frame?.tab_id])
  function releaseKeys() {
    if (!userControl) return
    for (const key of pressedKeys.current) send({ type: 'key', event: 'up', key })
    pressedKeys.current.clear()
    if (pressedMouse.current) send({ type: 'mouse', event: 'up', ...pointer.current, button: 'left' })
    pressedMouse.current = false
  }
  return (
    <div className={styles.browser}>
      <div className={styles.connection} role="status">{connection} <button type="button" onClick={() => setRetry((v) => v + 1)}>Переподключить</button></div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {tabs.length === 0 ? <div className={styles.empty}><h2>Вкладок пока нет</h2><p>Во время поиска здесь видны все открытые страницы агента и его действия. Выберите вкладку, чтобы наблюдать за ней.</p></div> : (
        <>
          <div className={styles.tabs} role="tablist" aria-label="Активные вкладки агента">
            {tabs.map((t) => <button type="button" role="tab" tabIndex={selected === t.id ? 0 : -1} aria-selected={selected === t.id} key={t.id} onKeyDown={(e) => { if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return; e.preventDefault(); const index = tabs.findIndex((entry) => entry.id === t.id); const next = tabs[(index + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]; selectedRef.current = next.id; setSelected(next.id); send({ type: 'select' }); (e.currentTarget.parentElement?.children[(index + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length] as HTMLButtonElement)?.focus() }} onClick={() => { selectedRef.current = t.id; setSelected(t.id); send({ type: 'select' }) }} title={t.url}>
              <span className={t.blocked ? styles.blocked : styles.dot} aria-hidden="true" />
              <span>{t.title || t.url || 'Новая вкладка'}<small>{t.action || t.status}</small></span>
            </button>)}
          </div>
          {tab && <><div className={styles.toolbar}><span className={styles.url} title={tab.url}>{tab.url}</span><button type="button" onClick={() => send({ type: 'control', by: userControl ? 'agent' : 'user' })}>{userControl ? 'Вернуть агенту' : 'Взять управление'}</button>{tab.blocked && <button type="button" onClick={() => send({ type: 'resume' })}>Проверка пройдена</button>}</div>
          <p className={styles.action} role="status">{userControl ? 'Управляете вы. Кликните по странице для ввода с клавиатуры.' : tab.action || 'Агент работает на странице'}</p></>}
          {frame ? <div className={styles.viewport} ref={viewport}><img src={`data:image/jpeg;base64,${frame.data}`} alt={`Страница: ${tab?.title ?? 'браузер агента'}`} tabIndex={userControl ? 0 : -1} draggable={false} onMouseDown={(e) => mouse(e, 'down')} onMouseUp={(e) => mouse(e, 'up')} onMouseMove={(e) => { if (Date.now() - lastMove.current > 40) { lastMove.current = Date.now(); mouse(e, 'move') } }} onKeyDown={(e) => keyboard(e, 'down')} onKeyUp={(e) => keyboard(e, 'up')} onBlur={releaseKeys} /></div> : <p className={styles.empty}>Ожидаем изображение выбранной вкладки…</p>}
          {userControl && <form className={styles.textInput} onSubmit={(e) => { e.preventDefault(); if (text) { send({ type: 'text', text }); setText('') } }}><input aria-label="Текст для страницы браузера" value={text} onChange={(e) => setText(e.target.value)} placeholder="Текст для поля на странице" /><button type="submit" disabled={!text}>Ввести</button></form>}
        </>
      )}
    </div>
  )
}
