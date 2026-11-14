import { forwardRef, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { Question } from '../api/types'
import { Icon } from '../components/Icon'
import { useChat } from './context'
import { useQuestionAnswer } from './useQuestionAnswer'
import { waitingLabel } from './waiting'
import styles from './QuestionPopup.module.css'

/**
 * Клавиши окна действуют, только когда фокус в окне или нигде. В поле ввода цифры и стрелки
 * остаются обычным текстом и движением курсора.
 */
function ownsKeys(root: HTMLElement | null, e: KeyboardEvent): boolean {
  if (!root || e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return false
  const active = document.activeElement
  return !active || active === document.body || root.contains(active)
}

/** «позиция 1, Бумага А4 SvetoCopy»: название до первой запятой, чтобы строка была короткой. */
function usePositionName() {
  const { positions = [] } = useChat()
  return (index: number) => positions.find((p) => p.index === index)?.name.split(',')[0].trim() ?? null
}

interface QuestionPopupProps {
  questions: Question[]
  index: number
  onNavigate: (index: number) => void
  /** Свернуть в строку над полем ввода. `fromInside`: фокус был в окне, его надо вернуть на строку. */
  onCollapse: (fromInside: boolean) => void
  /** Окно открыли явно (из строки или из ленты): фокус переходит в окно. */
  takeFocus?: boolean
  onFocusTaken?: () => void
}

/**
 * Уточняющие вопросы агента над полем ввода. Окно не модальное: лента, отчёт и браузер
 * доступны, фокус само не забирает. Неотвеченные вопросы листаются, ответ ведёт к следующему.
 */
export function QuestionPopup({ questions, index, onNavigate, onCollapse, takeFocus, onFocusTaken }: QuestionPopupProps) {
  const root = useRef<HTMLElement>(null)
  // Фокус был в окне: после смены вопроса (кнопка ответа исчезла) возвращаем его в окно.
  const focusInside = useRef(false)
  const question = questions[index]
  const positionName = usePositionName()
  const name = positionName(question.position_index)

  useEffect(() => {
    if (!takeFocus) return
    root.current?.focus({ preventScroll: true })
    onFocusTaken?.()
  }, [takeFocus, onFocusTaken])

  useLayoutEffect(() => {
    const active = document.activeElement
    if (focusInside.current && (!active || active === document.body)) root.current?.focus({ preventScroll: true })
  }, [question.id, index])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!ownsKeys(root.current, e)) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onCollapse(root.current?.contains(document.activeElement) ?? false)
      } else if (e.key === 'ArrowLeft' && index > 0) {
        e.preventDefault()
        onNavigate(index - 1)
      } else if (e.key === 'ArrowRight' && index < questions.length - 1) {
        e.preventDefault()
        onNavigate(index + 1)
      }
    }
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) focusInside.current = false
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [index, questions.length, onNavigate, onCollapse])

  return (
    <section
      ref={root}
      className={styles.popup}
      role="dialog"
      aria-modal="false"
      aria-label="Уточняющий вопрос"
      tabIndex={-1}
      onFocus={() => { focusInside.current = true }}
      onBlur={(e) => {
        if (e.relatedTarget && !root.current?.contains(e.relatedTarget)) focusInside.current = false
      }}
    >
      <div className={styles.head}>
        <span className={styles.meta} title={name ?? undefined}>
          Вопрос {index + 1} из {questions.length} · позиция {question.position_index}{name ? `, ${name}` : ''}
        </span>
        <button type="button" className={styles.icon} aria-label="Предыдущий вопрос" title="Предыдущий (←)"
          disabled={index === 0} onClick={() => onNavigate(index - 1)}>
          <Icon name="left" />
        </button>
        <button type="button" className={styles.icon} aria-label="Следующий вопрос" title="Следующий (→)"
          disabled={index >= questions.length - 1} onClick={() => onNavigate(index + 1)}>
          <Icon name="right" />
        </button>
        <button type="button" className={styles.icon} aria-label="Свернуть" title="Свернуть (Esc)"
          onClick={() => onCollapse(root.current?.contains(document.activeElement) ?? false)}>
          <Icon name="chev" />
        </button>
      </div>
      {/* key: у каждого вопроса свой выбор «с нуля» и свой флажок общего ответа */}
      <QuestionBody key={question.id} data={question} root={root} />
    </section>
  )
}

function QuestionBody({ data, root }: { data: Question; root: RefObject<HTMLElement | null> }) {
  const { related, applyAll, setApplyAll, pending, shownAnswer, busy, error, choose } = useQuestionAnswer(data)
  const positionName = usePositionName()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!/^[1-9]$/.test(e.key) || !ownsKeys(root.current, e)) return
      const option = data.options[Number(e.key) - 1]
      if (option === undefined) return
      e.preventDefault()
      choose(option)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [data.options, choose, root])

  const relatedLabel = related.length === 1
    ? `позиции ${related[0].position_index}${positionName(related[0].position_index) ? `, ${positionName(related[0].position_index)}` : ''}`
    : `позиций ${related.map((q) => q.position_index).join(', ')}`

  return (
    <>
      <p className={styles.q} title={data.hint ?? undefined}>{data.text}</p>
      <div className={styles.options} role="group" aria-label="Варианты ответа">
        {data.options.map((option, i) => {
          const chosen = option === shownAnswer
          const isDefault = option === data.default_answer
          const key = i < 9 ? String(i + 1) : undefined
          return (
            <button
              key={option}
              type="button"
              className={`${styles.option} ${isDefault ? styles.default : ''} ${chosen ? styles.chosen : ''}`}
              aria-pressed={chosen}
              aria-keyshortcuts={key}
              disabled={busy}
              onClick={() => choose(option)}
            >
              <span className={styles.key} aria-hidden="true">{chosen ? <Icon name="check" /> : key}</span>
              <span className={styles.label}>{option}</span>
              {/* пробел разделяет слова в имени кнопки; во flex-раскладке он не виден */}
              {isDefault && <>{' '}<span className={styles.note}>по умолчанию</span></>}
            </button>
          )
        })}
      </div>
      {related.length > 0 && (
        <label className={styles.same}>
          <input type="checkbox" checked={applyAll} disabled={busy} onChange={(e) => setApplyAll(e.target.checked)} />
          Тот же ответ для {relatedLabel}
        </label>
      )}
      {error ? (
        <p className={styles.error} role="alert">{error.message}</p>
      ) : (
        <p className={styles.foot} role="status">
          {pending
            ? pending.accepted ? 'Ответ принят, применяем…' : 'Сохраняем ответ…'
            : 'Без ответа агент продолжит с вариантом по умолчанию.'}
        </p>
      )}
    </>
  )
}

interface QuestionPillProps {
  count: number
  onOpen: () => void
}

/** Свёрнутое окно вопросов: строка над полем ввода со счётчиком. */
export const QuestionPill = forwardRef<HTMLButtonElement, QuestionPillProps>(function QuestionPill({ count, onOpen }, ref) {
  return (
    <button ref={ref} type="button" className={styles.pill} onClick={onOpen}>
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.pillText}>{waitingLabel(count)}</span>{' '}
      <span className={styles.pillAction}>Открыть</span>
    </button>
  )
})
