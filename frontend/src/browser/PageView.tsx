import { useEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react'
import type { BrowserFrame } from '../api/types'
import styles from './BrowserPanel.module.css'

const BUTTONS = ['left', 'middle', 'right'] as const
// Клавиши, которые уходят на страницу как нажатия, а не как вставка текста.
const NAMED = new Set([' ', 'Space'])

type Send = (value: Record<string, unknown>) => unknown

/**
 * Кадр страницы и, в режиме управления, невидимое поле ввода поверх него.
 * Печатные символы любой раскладки, IME и вставка из буфера уходят текстом,
 * служебные клавиши и сочетания с Ctrl/Cmd/Alt уходят нажатиями. Esc страница не получает.
 */
export function PageView({ frame, title, control, cursor, send, onEscape, children }: {
  frame: BrowserFrame | undefined
  title: string
  control: boolean
  cursor: string | undefined
  send: Send
  onEscape: () => void
  children?: React.ReactNode
}) {
  const capture = useRef<HTMLTextAreaElement>(null)
  const pressed = useRef(new Set<string>())
  const mouseDown = useRef<{ button: string; x: number; y: number } | null>(null)
  const lastMove = useRef(0)
  const width = frame?.width ?? 1280
  const height = frame?.height ?? 800

  function point(e: { clientX: number; clientY: number }, element: Element) {
    const box = element.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(width, Math.round((e.clientX - box.left) * width / box.width))),
      y: Math.max(0, Math.min(height, Math.round((e.clientY - box.top) * height / box.height))),
    }
  }
  function mouse(e: MouseEvent<HTMLTextAreaElement>, event: 'down' | 'up' | 'move') {
    if (!control || !frame) return
    const at = point(e, e.currentTarget)
    if (event === 'move') {
      if (Date.now() - lastMove.current < 40) return
      lastMove.current = Date.now()
      send({ type: 'mouse', event, ...at })
      return
    }
    const button = BUTTONS[e.button] ?? 'left'
    const count = Math.max(1, Math.min(3, e.detail || 1))
    if (event === 'down') mouseDown.current = { button, ...at }
    else mouseDown.current = null
    send({ type: 'mouse', event, ...at, button, ...(count > 1 ? { click_count: count } : {}) })
  }
  function releaseAll() {
    for (const key of pressed.current) send({ type: 'key', event: 'up', key })
    pressed.current.clear()
    if (mouseDown.current) {
      const { button, x, y } = mouseDown.current
      send({ type: 'mouse', event: 'up', x, y, button })
      mouseDown.current = null
    }
  }
  function keyName(e: KeyboardEvent) {
    if (e.key === ' ') return 'Space'
    // Ctrl+A на русской раскладке приходит как «ф»: странице нужна латинская клавиша.
    if ((e.ctrlKey || e.metaKey || e.altKey) && e.key.length === 1) {
      const code = /^Key([A-Z])$/.exec(e.code)?.[1] ?? /^Digit(\d)$/.exec(e.code)?.[1]
      if (code) return code.toLowerCase()
    }
    return e.key
  }
  function flushText(element: HTMLTextAreaElement) {
    const text = element.value
    element.value = ''
    if (text) send({ type: 'text', text })
  }
  function keyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (!control || e.nativeEvent.isComposing || ['Process', 'Unidentified', 'Dead'].includes(e.key)) return
    if (e.key === 'Escape') { e.preventDefault(); releaseAll(); onEscape(); return }
    const modified = e.ctrlKey || e.metaKey || e.altKey
    // Печатный символ без модификаторов придёт событием input и уйдёт текстом.
    if (e.key.length === 1 && !modified && !NAMED.has(e.key)) return
    // Вставка: браузер пришлёт событие paste с текстом из буфера пользователя.
    if (modified && e.code === 'KeyV' && !e.altKey) return
    e.preventDefault()
    const key = keyName(e)
    pressed.current.add(key)
    send({ type: 'key', event: 'down', key })
  }
  function keyUp(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (!control) return
    const key = keyName(e)
    if (!pressed.current.has(key)) return
    e.preventDefault()
    pressed.current.delete(key)
    send({ type: 'key', event: 'up', key })
  }

  // Колесо: React подписывается пассивно, а нам нужно не прокручивать сам интерфейс.
  useEffect(() => {
    const element = capture.current
    if (!element || !control) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      send({ type: 'wheel', dx: event.deltaX, dy: event.deltaY })
    }
    const up = () => {
      if (!mouseDown.current) return
      const { button, x, y } = mouseDown.current
      send({ type: 'mouse', event: 'up', x, y, button })
      mouseDown.current = null
    }
    element.addEventListener('wheel', wheel, { passive: false })
    window.addEventListener('mouseup', up)
    return () => { element.removeEventListener('wheel', wheel); window.removeEventListener('mouseup', up) }
  }, [control, send, frame?.tab_id])

  useEffect(() => {
    if (control) capture.current?.focus({ preventScroll: true })
  }, [control])

  return (
    <div className={styles.stage} style={{ aspectRatio: `${width} / ${height}`, ['--ratio' as string]: width / height }}>
      {frame
        ? <img src={`data:image/${frame.format ?? 'jpeg'};base64,${frame.data}`} alt={`Страница: ${title}`} draggable={false} />
        : <p className={styles.waiting}>Ждём изображение страницы…</p>}
      {control && frame && (
        <textarea
          ref={capture}
          className={styles.capture}
          style={{ cursor: cursor ?? 'default' }}
          aria-label="Ввод на страницу"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onMouseDown={(e) => mouse(e, 'down')}
          onMouseUp={(e) => mouse(e, 'up')}
          onMouseMove={(e) => mouse(e, 'move')}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={keyDown}
          onKeyUp={keyUp}
          onInput={(e) => { if (!(e.nativeEvent as InputEvent).isComposing) flushText(e.currentTarget) }}
          onCompositionEnd={(e) => flushText(e.currentTarget)}
          onPaste={(e) => {
            e.preventDefault()
            const text = e.clipboardData.getData('text/plain')
            if (text) send({ type: 'text', text: text.slice(0, 10000) })
          }}
          onBlur={releaseAll}
        />
      )}
      {children}
    </div>
  )
}
