import type { KeyboardEvent } from 'react'
import type { Question } from '../api/types'
import { Icon } from '../components/Icon'
import { QuestionCard } from './messages/QuestionCard'
import styles from './QuestionPopup.module.css'

interface QuestionPopupProps {
  question: Question
  /** Закрыли крестиком или Esc без ответа: вопрос остаётся в ленте. */
  onClose: () => void
  /** Ответили кнопкой. */
  onAnswered: () => void
}

/**
 * Новый вопрос агента всплывает над полем ввода. Фокус не забираем: человек мог печатать.
 * Закрытие без ответа не теряет вопрос, он появится в ленте (решает Chat).
 */
export function QuestionPopup({ question, onClose, onAnswered }: QuestionPopupProps) {
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose()
  }
  return (
    <div className={styles.popup} role="dialog" aria-modal="false" aria-label="Вопрос агента" onKeyDown={onKeyDown}>
      <button type="button" className={styles.close} aria-label="Закрыть" title="Вопрос останется в чате" onClick={onClose}>
        <Icon name="x" />
      </button>
      <QuestionCard data={question} variant="popup" onAnswered={onAnswered} />
    </div>
  )
}
