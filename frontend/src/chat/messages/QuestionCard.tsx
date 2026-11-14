import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import { useEffect, useMemo, useState } from 'react'
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
  onAnswered?: (questionIds: string[]) => void
}

/** Уточняющий вопрос: у каждого есть ответ по умолчанию, поэтому он ничего не блокирует. */
export function QuestionCard({ data, variant = 'card', onAnswered }: QuestionCardProps) {
  const { procurementId, questions = [], positions = [] } = useChat()
  const [applyAll, setApplyAll] = useState(false)
  const positionLabel = (index: number) => {
    const position = positions.find((p) => p.index === index)
    return `Позиция ${index}${position ? `: ${position.name}` : ''}`
  }
  const related = questions.filter((q) =>
    q.id !== data.id && q.position_index !== data.position_index && q.answer === null &&
    /аналог|эквивалент/i.test(data.text) &&
    q.text.trim().toLocaleLowerCase() === data.text.trim().toLocaleLowerCase() &&
    q.default_answer === data.default_answer &&
    q.options.length === data.options.length && q.options.every((option) => data.options.includes(option)),
  )
  const queryClient = useQueryClient()
  const pendingKey = useMemo(() => ['question-answer', procurementId, data.id], [procurementId, data.id])
  const pending = useQuery<{ value: string; accepted: boolean } | null>({ queryKey: pendingKey, queryFn: () => null, enabled: false, initialData: null })
  useEffect(() => {
    if (pending.data && data.answer === pending.data.value) queryClient.setQueryData(pendingKey, null)
  }, [data.answer, pending.data, queryClient, pendingKey])
  const answer = useMutation({
    mutationFn: async ({ value, targets }: { value: string; targets: Question[] }) => {
      for (const target of targets) await api.answerQuestion(procurementId, target.id, value)
    },
    onMutate: ({ value, targets }) => {
      for (const target of targets) queryClient.setQueryData(['question-answer', procurementId, target.id], { value, accepted: false })
    },
    onSuccess: (_result, { value, targets }) => {
      // SSE мог подтвердить ответ раньше HTTP 202. Не восстанавливаем уже снятое ожидание.
      for (const target of targets) queryClient.setQueryData<{ value: string; accepted: boolean } | null>(['question-answer', procurementId, target.id], (current) => current?.value === value ? { value, accepted: true } : current ?? null)
      onAnswered?.(targets.map((target) => target.id))
    },
    onError: (_error, { targets }) => {
      for (const target of targets) queryClient.setQueryData(['question-answer', procurementId, target.id], null)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: procurementKey(procurementId) }),
  })
  const shownAnswer = pending.data?.value ?? data.answer
  const custom = shownAnswer !== null && shownAnswer !== undefined && !data.options.includes(shownAnswer)

  return (
    <div className={variant === 'popup' ? styles.askBare : styles.ask}>
      <div className={styles.hint}>{positionLabel(data.position_index)}</div>
      {/* Пояснение агента не выводим: оно загромождает. Оно остаётся подсказкой при наведении. */}
      <div className={styles.q} title={data.hint ?? undefined}>
        {data.text}
      </div>
      {related.length > 0 && data.answer === null && <label className={styles.hint}>
        <input type="checkbox" checked={applyAll} disabled={answer.isPending || !!pending.data} onChange={(e) => setApplyAll(e.target.checked)} />
        {' '}Применить ответ также к другим позициям с этим вопросом: {related.map((q) => positionLabel(q.position_index)).join('; ')}
      </label>}
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
              onClick={() => answer.mutate({ value: option, targets: applyAll ? [...related, data] : [data] })}
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
