import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api/client'
import type { BrowserTab } from '../api/types'
import { Icon } from '../components/Icon'
import styles from './BrowserPanel.module.css'
import { useCountdown } from './countdown'
import { Journal } from './Journal'
import { PageView } from './PageView'
import { useBrowserSession } from './useBrowserSession'

/** Все вкладки управляемого браузера; кадры приходят только для выбранной. */
export function BrowserPanel({ procurementId, active }: { procurementId: string; active: boolean }) {
  return <BrowserSession key={procurementId} procurementId={procurementId} active={active} />
}

function domainOf(tab: BrowserTab) {
  if (tab.domain) return tab.domain
  try { return new URL(tab.url).hostname.replace(/^www\./, '') } catch { return '' }
}
function stateOf(tab: BrowserTab) {
  return tab.state ?? (tab.blocked ? 'needs_user' : tab.status === 'error' ? 'error' : 'loading')
}
function clock(seconds: number) {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function BrowserSession({ procurementId, active }: { procurementId: string; active: boolean }) {
  const session = useBrowserSession(procurementId, active)
  const { tabs, selected, frames, controllers, cursors, journal, connection, error, send, sendRaw, select, reconnect } = session
  const [expanded, setExpanded] = useState(false)
  const tab = tabs.find((t) => t.id === selected)
  const frame = selected ? frames[selected] : undefined
  const control = selected ? controllers[selected] === 'user' : false
  const chips = useRef<HTMLDivElement>(null)
  const stageBox = useRef<HTMLDivElement>(null)
  const hasTabs = tabs.length > 0

  // В панели капча нечитаемо мелкая: при переходе к ручному управлению окно разворачивается,
  // а когда управление вернулось агенту (Esc, «Готово, продолжить»), сворачивается обратно.
  const [wasControl, setWasControl] = useState(control)
  const [autoExpanded, setAutoExpanded] = useState(false)
  if (control !== wasControl) {
    setWasControl(control)
    if (control && !expanded) {
      setExpanded(true)
      setAutoExpanded(true)
    } else if (!control && autoExpanded) {
      setExpanded(false)
      setAutoExpanded(false)
    }
  }

  // Размер области кадра: сервер подстраивает viewport страницы под панель.
  useEffect(() => {
    const element = stageBox.current
    if (!element || typeof ResizeObserver === 'undefined' || connection !== 'open') return
    let timer: ReturnType<typeof setTimeout>
    const report = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const width = element.clientWidth
        if (!width) return
        const height = expanded ? Math.max(400, window.innerHeight - 200) : Math.round(width * 0.625)
        sendRaw({ type: 'viewport', width, height })
      }, 250)
    }
    const observer = new ResizeObserver(report)
    observer.observe(element)
    report()
    return () => { clearTimeout(timer); observer.disconnect() }
  }, [expanded, connection, sendRaw, selected, hasTabs])

  // Выбранная вкладка всегда видна целиком в ленте вкладок.
  const selectedIndex = tabs.findIndex((t) => t.id === selected)
  useEffect(() => {
    const chip = chips.current?.children[selectedIndex] as HTMLElement | undefined
    chip?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [selectedIndex])

  // Esc закрывает развёрнутое окно, если не занят возвратом управления.
  useEffect(() => {
    if (!expanded) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) setExpanded(false) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [expanded])

  function move(index: number, step: number) {
    const next = tabs[(index + step + tabs.length) % tabs.length]
    select(next.id)
    ;(chips.current?.children[(index + step + tabs.length) % tabs.length] as HTMLButtonElement | undefined)?.focus()
  }

  const status = connection !== 'open' && (
    <p className={styles.connection} role="status">
      {connection === 'lost' ? 'Нет связи с браузером агента.' : 'Подключаемся к браузеру…'}
      {connection === 'lost' && <button type="button" className={styles.link} onClick={reconnect}>Переподключить</button>}
    </p>
  )

  if (tabs.length === 0) {
    return (
      <div className={styles.browser}>
        {status}
        <p className={styles.empty}>Агент пока не открывал страниц</p>
        <Journal events={journal} tabs={tabs} position={undefined} />
      </div>
    )
  }

  const window_ = tab && (
    <BrowserWindow
      key={tab.id}
      procurementId={procurementId}
      tab={tab}
      frame={frame}
      control={control}
      cursor={cursors[tab.id]}
      expanded={expanded}
      stageBox={stageBox}
      send={send}
      onExpand={() => setExpanded((v) => !v)}
    />
  )

  return (
    <div className={styles.browser}>
      {status}
      {error && <p className={styles.notice} role="alert">{error}</p>}
      <div className={styles.chips} role="tablist" aria-label="Страницы агента" ref={chips}>
        {tabs.map((t, index) => {
          const state = stateOf(t)
          const site = domainOf(t)
          return (
            <button
              type="button"
              role="tab"
              key={t.id}
              className={styles.chip}
              aria-selected={selected === t.id}
              tabIndex={selected === t.id ? 0 : -1}
              title={t.url}
              onClick={() => select(t.id)}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
                e.preventDefault()
                move(index, e.key === 'ArrowRight' ? 1 : -1)
              }}
            >
              <span className={styles.fav} aria-hidden="true">{(site[0] ?? '·').toUpperCase()}</span>
              <span className={state === 'skipped' ? styles.struck : state === 'error' ? styles.dim : undefined}>{t.title || site || 'Новая вкладка'}</span>
              {state === 'loading' && <span role="img" aria-label="загружается" className={styles.chipState}><Icon name="spin" className={styles.spin} /></span>}
              {state === 'needs_user' && <span role="img" aria-label="нужна помощь" className={styles.helpDot} />}
            </button>
          )
        })}
      </div>
      {expanded && window_ ? createPortal(
        <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Браузер агента" onMouseDown={(e) => { if (e.target === e.currentTarget) setExpanded(false) }}>
          {window_}
        </div>,
        document.body,
      ) : window_}
      {control && (
        <p className={styles.hint}>Клики и клавиатура уходят на страницу. <kbd>Esc</kbd> вернёт управление агенту.</p>
      )}
      <Journal events={journal} tabs={tabs} position={tab?.position_index} />
    </div>
  )
}

function BrowserWindow({ procurementId, tab, frame, control, cursor, expanded, stageBox, send, onExpand }: {
  procurementId: string
  tab: BrowserTab
  frame: Parameters<typeof PageView>[0]['frame']
  control: boolean
  cursor: string | undefined
  expanded: boolean
  stageBox: React.RefObject<HTMLDivElement | null>
  send: (value: Record<string, unknown>) => boolean
  onExpand: () => void
}) {
  const state = stateOf(tab)
  const needsUser = state === 'needs_user'
  const left = useCountdown(needsUser ? tab.deadline : null, tab.wait_seconds)
  const skip = useMutation({ mutationFn: () => api.skipSource(procurementId, tab.source_id) })
  let host = domainOf(tab)
  let rest = ''
  let secure = false
  try {
    const url = new URL(tab.url)
    host = url.hostname.replace(/^www\./, '')
    rest = `${url.pathname === '/' ? '' : url.pathname}${url.search}`
    try { rest = decodeURI(rest) } catch { /* оставляем как есть */ }
    secure = url.protocol === 'https:'
  } catch { /* адрес ещё не известен */ }
  const giveBack = () => send(needsUser ? { type: 'resume' } : { type: 'control', by: 'agent' })

  return (
    <div className={`${styles.window} ${control ? styles.controlled : ''} ${expanded ? styles.big : ''}`}>
      {control && (
        <div className={styles.controlBar}>
          <Icon name="pointer" />
          <span className={styles.controlText}>Управляете вы{left != null && <span title="Агент ждёт, потом пропустит сайт"> · <span className={styles.hidden}>агент ждёт </span><span className={styles.num}>{clock(left)}</span></span>}</span>
          {needsUser && (
            <button type="button" className={styles.ghost} aria-label="Пропустить сайт" disabled={skip.isPending || skip.isSuccess} onClick={() => skip.mutate()}>
              <span>Пропустить<span className={styles.wide}> сайт</span></span>
            </button>
          )}
          <button type="button" className={styles.primary} aria-label="Готово, продолжить" onClick={giveBack}><span>Готово<span className={styles.wide}>, продолжить</span></span></button>
        </div>
      )}
      <div className={styles.address}>
        {secure && <Icon name="lock" className={styles.lock} />}
        <span className={styles.url} title={tab.url}><b>{host}</b><span>{rest}</span></span>
        {!control && (
          <button type="button" className={needsUser ? styles.primary : styles.plain} onClick={() => send({ type: 'control', by: 'user' })}>
            <Icon name="pointer" />Взять управление
          </button>
        )}
        <button type="button" className={styles.icon} aria-label={expanded ? 'Свернуть' : 'Развернуть'} onClick={onExpand}>
          <Icon name={expanded ? 'shrink' : 'expand'} />
        </button>
      </div>
      <div ref={stageBox} className={styles.stageBox}>
        <PageView frame={frame} title={tab.title || host} control={control} cursor={cursor} send={send} onEscape={giveBack}>
          {state === 'error' && !control && (
            <div className={styles.failed} role="status"><Icon name="x" /><span><b>Страница не открылась</b>{tab.error && <span>{tab.error}</span>}</span></div>
          )}
          {!control && state !== 'error' && (
            <p className={styles.pill} role="status">
              {(state === 'loading' || state === 'reading') && <Icon name="spin" className={styles.spin} />}
              {needsUser ? 'Сайт просит пройти проверку' : tab.action || 'Агент работает на странице'}
            </p>
          )}
        </PageView>
      </div>
      {skip.isError && <p className={styles.notice} role="alert">{skip.error.message}</p>}
    </div>
  )
}
