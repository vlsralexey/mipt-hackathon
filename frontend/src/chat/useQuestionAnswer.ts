import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../api/client'
import type { Question } from '../api/types'
import { useChat } from './context'
import { procurementKey } from './useProcurementEvents'

type PendingAnswer = { value: string; accepted: boolean } | null

/**
 * Ответ на вопрос агента: общий для карточки в ленте и всплывающего окна.
 * Ожидание ответа хранится в кэше запросов по id вопроса, поэтому карточка и окно
 * показывают одно и то же состояние «Сохраняем ответ…».
 */
export function useQuestionAnswer(data: Question, onAnswered?: (questionIds: string[]) => void) {
  const { procurementId, questions = [], answered } = useChat()
  const [applyAll, setApplyAll] = useState(false)
  // Тот же вопрос об аналогах для другой позиции (А4 и А3): можно ответить сразу на оба.
  const related = questions.filter((q) =>
    q.id !== data.id && q.position_index !== data.position_index && q.answer === null &&
    /аналог|эквивалент/i.test(data.text) &&
    q.text.trim().toLocaleLowerCase() === data.text.trim().toLocaleLowerCase() &&
    q.default_answer === data.default_answer &&
    q.options.length === data.options.length && q.options.every((option) => data.options.includes(option)),
  )
  const queryClient = useQueryClient()
  const pendingKey = useMemo(() => ['question-answer', procurementId, data.id], [procurementId, data.id])
  const pending = useQuery<PendingAnswer>({ queryKey: pendingKey, queryFn: () => null, enabled: false, initialData: null })
  useEffect(() => {
    if (pending.data && data.answer === pending.data.value) queryClient.setQueryData(pendingKey, null)
  }, [data.answer, pending.data, queryClient, pendingKey])
  const mutation = useMutation({
    mutationFn: async ({ value, targets }: { value: string; targets: Question[] }) => {
      for (const target of targets) await api.answerQuestion(procurementId, target.id, value)
    },
    onMutate: ({ value, targets }) => {
      for (const target of targets) queryClient.setQueryData(['question-answer', procurementId, target.id], { value, accepted: false })
    },
    onSuccess: (_result, { value, targets }) => {
      // SSE мог подтвердить ответ раньше HTTP 202. Не восстанавливаем уже снятое ожидание.
      for (const target of targets) queryClient.setQueryData<PendingAnswer>(['question-answer', procurementId, target.id], (current) => current?.value === value ? { value, accepted: true } : current ?? null)
      const ids = targets.map((target) => target.id)
      answered?.(ids)
      onAnswered?.(ids)
    },
    onError: (_error, { targets }) => {
      for (const target of targets) queryClient.setQueryData(['question-answer', procurementId, target.id], null)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: procurementKey(procurementId) }),
  })
  const shownAnswer = pending.data?.value ?? data.answer
  const busy = mutation.isPending || !!pending.data
  return {
    related,
    applyAll,
    setApplyAll,
    pending: pending.data,
    shownAnswer,
    busy,
    error: mutation.isError ? mutation.error : null,
    /** Выбранный вариант повторно не отправляем: он уже действует. */
    choose(option: string) {
      if (busy || option === shownAnswer) return
      mutation.mutate({ value: option, targets: applyAll ? [...related, data] : [data] })
    },
  }
}
