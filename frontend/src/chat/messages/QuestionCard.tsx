import type { Question } from '../../api/types'
import { Icon } from '../../components/Icon'
import { useChat } from '../context'
import { useQuestionAnswer } from '../useQuestionAnswer'
import styles from './cards.module.css'

interface QuestionCardProps {
  data: Question
}

/** Уточняющий вопрос: у каждого есть ответ по умолчанию, поэтому он ничего не блокирует. */
export function QuestionCard({ data }: QuestionCardProps) {
  const { positions = [], docked, openQuestion } = useChat()
  const state = docked?.(data.id) ?? null
  const positionLabel = (index: number) => {
    const position = positions.find((p) => p.index === index)
    return `Позиция ${index}${position ? `: ${position.name}` : ''}`
  }
  if (state) {
    // Вопрос открыт в окне над полем ввода: здесь только строка, по клику окно встаёт на него.
    return (
      <button type="button" className={styles.docked} onClick={() => openQuestion?.(data.id)}>
        <span className={styles.dockedText}>Позиция {data.position_index}: {data.text}</span>
        <span className={styles.dockedNote}>{state === 'current' ? 'открыт ниже' : 'в очереди'}</span>
      </button>
    )
  }
  return <QuestionBody data={data} positionLabel={positionLabel} />
}

function QuestionBody({ data, positionLabel }: QuestionCardProps & { positionLabel: (index: number) => string }) {
  const { related, applyAll, setApplyAll, pending, shownAnswer, busy, error, choose } = useQuestionAnswer(data)
  // С одним вариантом выбирать нечего: это допущение, другой ответ дают сообщением в чат.
  const choosable = data.options.length > 1
  const custom = shownAnswer !== null && shownAnswer !== undefined && (!choosable || !data.options.includes(shownAnswer))

  return (
    <div className={styles.ask}>
      <div className={styles.hint}>{positionLabel(data.position_index)}</div>
      {/* Пояснение агента не выводим: оно загромождает. Оно остаётся подсказкой при наведении. */}
      <div className={styles.q} title={data.hint ?? undefined}>
        {data.text}
      </div>
      {related.length > 0 && data.answer === null && <label className={styles.hint}>
        <input type="checkbox" checked={applyAll} disabled={busy} onChange={(e) => setApplyAll(e.target.checked)} />
        {' '}Применить ответ также к другим позициям с этим вопросом: {related.map((q) => positionLabel(q.position_index)).join('; ')}
      </label>}
      {choosable && <div className={styles.actions} role="group" aria-label="Варианты ответа">
        {data.options.map((option) => {
          const chosen = option === shownAnswer
          return (
            <button
              key={option}
              type="button"
              className={`${styles.btn} ${chosen ? styles.chosen : ''}`}
              aria-pressed={chosen}
              disabled={chosen || busy}
              onClick={() => choose(option)}
            >
              {chosen && <Icon name="check" />}
              {option}
            </button>
          )
        })}
      </div>}
      {custom && <div className={styles.hint}>Ваш ответ: {shownAnswer}</div>}
      {pending && <div className={styles.hint} role="status">{pending.accepted ? 'Ответ принят, применяем…' : 'Сохраняем ответ…'}</div>}
      {!pending && data.answer === null && <div className={styles.hint}>По умолчанию: {data.default_answer}</div>}
      {error && (
        <p className={styles.error} role="alert">
          {error.message}
        </p>
      )}
    </div>
  )
}
