import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import type { Procurement, Question } from '../../api/types'
import { Icon } from '../../components/Icon'
import { useChat } from '../context'
import { procurementKey } from '../useProcurementEvents'
import styles from './cards.module.css'

interface QuestionCardProps {
  data: Question
  /** `popup` убирает свой фон и отступы: рамку и тень даёт всплывающее окно. */
  variant?: 'card' | 'popup'
  /** Ответ принят сервером. */
  onAnswered?: () => void
}

/** Уточняющий вопрос: у каждого есть ответ по умолчанию, поэтому он ничего не блокирует. */
export function QuestionCard({ data, variant = 'card', onAnswered }: QuestionCardProps) {
  const { procurementId } = useChat()
  const queryClient = useQueryClient()
  const answer = useMutation({
    mutationFn: (value: string) => api.answerQuestion(procurementId, data.id, value),
    onSuccess: (_result, value) => {
      // сразу показываем ответ; то же самое затем придёт по SSE и заменит по id
      queryClient.setQueryData<Procurement>(procurementKey(procurementId), (old) =>
        old && {
          ...old,
          messages: old.messages.map((m) =>
            m.kind === 'question' && m.data.id === data.id ? { ...m, data: { ...m.data, answer: value } } : m,
          ),
        },
      )
      onAnswered?.()
    },
    // повторный запрос подстраховывает от потери события
    onSettled: () => queryClient.invalidateQueries({ queryKey: procurementKey(procurementId) }),
  })
  const custom = data.answer !== null && !data.options.includes(data.answer)

  return (
    <div className={variant === 'popup' ? styles.askBare : styles.ask}>
      {/* Пояснение агента не выводим: оно загромождает. Оно остаётся подсказкой при наведении. */}
      <div className={styles.q} title={data.hint ?? undefined}>
        {data.text}
      </div>
      <div className={styles.actions} role="group" aria-label="Варианты ответа">
        {data.options.map((option) => {
          const chosen = option === data.answer
          return (
            <button
              key={option}
              type="button"
              className={`${styles.btn} ${chosen ? styles.chosen : ''}`}
              aria-pressed={chosen}
              disabled={answer.isPending}
              onClick={() => answer.mutate(option)}
            >
              {chosen && <Icon name="check" />}
              {option}
            </button>
          )
        })}
      </div>
      {custom && <div className={styles.hint}>Ваш ответ: {data.answer}</div>}
      {data.answer === null && <div className={styles.hint}>По умолчанию: {data.default_answer}</div>}
      {answer.isError && (
        <p className={styles.error} role="alert">
          {answer.error.message}
        </p>
      )}
    </div>
  )
}
