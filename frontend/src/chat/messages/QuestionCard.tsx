import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import { useEffect, useMemo } from 'react'
import type { Question } from '../../api/types'
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
  const pendingKey = useMemo(() => ['question-answer', procurementId, data.id], [procurementId, data.id])
  const pending = useQuery<{ value: string; accepted: boolean } | null>({ queryKey: pendingKey, queryFn: () => null, enabled: false, initialData: null })
  useEffect(() => {
    if (pending.data && data.answer === pending.data.value) queryClient.setQueryData(pendingKey, null)
  }, [data.answer, pending.data, queryClient, pendingKey])
  const answer = useMutation({
    mutationFn: (value: string) => api.answerQuestion(procurementId, data.id, value),
    onMutate: (value) => { queryClient.setQueryData(pendingKey, { value, accepted: false }) },
    onSuccess: (_result, value) => {
      // SSE мог подтвердить ответ раньше HTTP 202. Не восстанавливаем уже снятое ожидание.
      queryClient.setQueryData<{ value: string; accepted: boolean } | null>(pendingKey, (current) => current?.value === value ? { value, accepted: true } : current ?? null)
      onAnswered?.()
    },
    onError: () => { queryClient.setQueryData(pendingKey, null) },
    onSettled: () => queryClient.invalidateQueries({ queryKey: procurementKey(procurementId) }),
  })
  const shownAnswer = pending.data?.value ?? data.answer
  const custom = shownAnswer !== null && shownAnswer !== undefined && !data.options.includes(shownAnswer)

  return (
    <div className={variant === 'popup' ? styles.askBare : styles.ask}>
      {/* Пояснение агента не выводим: оно загромождает. Оно остаётся подсказкой при наведении. */}
      <div className={styles.q} title={data.hint ?? undefined}>
        {data.text}
      </div>
      <div className={styles.actions} role="group" aria-label="Варианты ответа">
        {data.options.map((option) => {
          const chosen = option === shownAnswer
          return (
            <button
              key={option}
              type="button"
              className={`${styles.btn} ${chosen ? styles.chosen : ''}`}
              aria-pressed={chosen}
              disabled={answer.isPending || !!pending.data}
              onClick={() => answer.mutate(option)}
            >
              {chosen && <Icon name="check" />}
              {option}
            </button>
          )
        })}
      </div>
      {custom && <div className={styles.hint}>Ваш ответ: {shownAnswer}</div>}
      {pending.data && <div className={styles.hint} role="status">{pending.data.accepted ? 'Ответ принят, применяем…' : 'Сохраняем ответ…'}</div>}
      {!pending.data && data.answer === null && <div className={styles.hint}>По умолчанию: {data.default_answer}</div>}
      {answer.isError && (
        <p className={styles.error} role="alert">
          {answer.error.message}
        </p>
      )}
    </div>
  )
}
