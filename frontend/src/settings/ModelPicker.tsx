import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { OpenRouterModel } from '../api/types'
import { Icon } from '../components/Icon'
import styles from './ModelPicker.module.css'

interface ModelPickerProps {
  /** id подписи строки: кнопка и поле поиска называются по ней. */
  labelledBy: string
  value: string
  models: OpenRouterModel[]
  loading: boolean
  refreshing: boolean
  disabled?: boolean
  onRefresh: () => void
  onSelect: (id: string) => void
}

/**
 * Выбор модели: кнопка с текущей моделью раскрывает список с поиском.
 * Поле поиска работает как combobox WAI-ARIA (фокус остаётся в поле, активный пункт
 * через aria-activedescendant): стрелки, Home/End, Enter выбирает, Esc закрывает.
 */
export function ModelPicker({ labelledBy, value, models, loading, refreshing, disabled = false, onRefresh, onSelect }: ModelPickerProps) {
  const base = useId()
  const listId = `${base}-list`
  const valueId = `${base}-value`
  const optionId = (i: number) => `${base}-o${i}`
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  const current = models.find((m) => m.id === value)
  const q = query.trim().toLocaleLowerCase()
  // Текущая модель может отсутствовать в каталоге (введена вручную): показываем её первой.
  const all = value && !current ? [{ id: value, name: value }, ...models] : models
  const options = all.filter((m) => `${m.name} ${m.id}`.toLocaleLowerCase().includes(q))

  function show() {
    setQuery('')
    setActive(Math.max(0, all.findIndex((m) => m.id === value)))
    setOpen(true)
  }

  function close(returnFocus: boolean) {
    setOpen(false)
    if (returnFocus) trigger.current?.focus()
  }

  function choose(id: string) {
    close(true)
    if (id !== value) onSelect(id)
  }

  useEffect(() => {
    if (open) search.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' })
  })

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  function onTriggerKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      show()
    }
  }

  function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    const last = options.length - 1
    const moves: Record<string, () => number> = {
      ArrowDown: () => Math.min(last, active + 1),
      ArrowUp: () => Math.max(0, active - 1),
      Home: () => 0,
      End: () => last,
    }
    if (e.key in moves) {
      e.preventDefault()
      if (last >= 0) setActive(moves[e.key]())
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const option = options[active]
      if (option) choose(option.id)
    } else if (e.key === 'Escape') {
      e.preventDefault() // иначе Esc закроет всю страницу настроек
      close(true)
    } else if (e.key === 'Tab') {
      close(false)
    }
  }

  return (
    <div className={styles.picker} ref={root}>
      <button
        ref={trigger}
        type="button"
        className={styles.trigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-labelledby={`${labelledBy} ${valueId}`}
        disabled={disabled}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={onTriggerKey}
      >
        <span id={valueId} className={styles.current}>
          {value ? (
            <>
              <span className={styles.name}>{current?.name ?? value}</span>
              {current && <span className={styles.id}>{value}</span>}
            </>
          ) : (
            <span className={styles.placeholder}>{loading ? 'Загрузка моделей…' : 'Выберите модель'}</span>
          )}
        </span>
        <Icon name="chev" className={open ? styles.chevOpen : styles.chev} />
      </button>
      {open && (
        <div className={styles.popup}>
          <label className={styles.search}>
            <Icon name="search" className={styles.searchIcon} />
            <input
              ref={search}
              type="text"
              role="combobox"
              aria-label="Найти модель"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={options[active] ? optionId(active) : undefined}
              placeholder="Найти модель"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(0)
              }}
              onKeyDown={onSearchKey}
            />
          </label>
          <ul id={listId} role="listbox" aria-label="Модели" className={styles.list}>
            {options.map((m, i) => (
              <li
                key={m.id}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                className={`${styles.option} ${i === active ? styles.active : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => setActive(i)}
                onClick={() => choose(m.id)}
              >
                <span className={styles.optionText}>
                  <span className={styles.name}>{m.name}</span>
                  {m.name !== m.id && <span className={styles.id}>{m.id}</span>}
                </span>
                {m.id === value ? (
                  <>
                    <Icon name="check" className={styles.mark} />
                    <span className={styles.srOnly}>текущая</span>
                  </>
                ) : <span />}
              </li>
            ))}
          </ul>
          {options.length === 0 && <p className={styles.empty} role="status">Ничего не найдено</p>}
          <div className={styles.footer}>
            <span>Агенту нужны инструменты и JSON-ответы</span>
            <button type="button" className={styles.refresh} disabled={refreshing} onMouseDown={(e) => e.preventDefault()} onClick={onRefresh}>
              {refreshing ? 'Обновляем…' : 'Обновить'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
