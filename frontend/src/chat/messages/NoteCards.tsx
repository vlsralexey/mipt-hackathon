import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import { DiffSummary } from '../../report/DiffSummary'
import { useChat } from '../context'
import { procurementKey } from '../useProcurementEvents'
import { Link } from 'react-router'
import { plural } from '../../plural'
import type { ErrorData, Proposal, SourceBlocked } from '../../api/types'
import { Icon } from '../../components/Icon'
import styles from './cards.module.css'
import { DEFAULT_WAIT_SECONDS, deadlineOf, minutesLeft, useCountdown } from '../../browser/countdown'


/** Ошибка прогона. Для неверного ключа сразу ведём в настройки. */
export function ErrorCard({ text, data }: { text: string | null; data: ErrorData }) {
  return (
    <div className={styles.note} role="alert">
      <Icon name="alert" />
      <p>{text ?? 'Что-то пошло не так.'}</p>
      {data.code === 'llm_auth' && (
        <div className={styles.actions}>
          <Link to="/settings">Открыть настройки</Link>
        </div>
      )}
    </div>
  )
}

/** Предварительный расчёт применяется только явным действием пользователя. */
export function ProposalActions({ text, data, resolve, showVersion = true }: { text: string | null; data: Proposal; showVersion?: boolean; resolve: (action: 'apply' | 'reject') => Promise<unknown> }) {
  const action = useMutation({ mutationFn: (value: 'apply' | 'reject') => resolve(value) })
  return <div className={styles.ask}>
    <div className={styles.q}>{text ?? data.text}</div>
    <DiffSummary diff={data.diff} showVersion={showVersion} />
    {data.status === 'pending' && !action.isSuccess ? <div className={styles.actions}>
      <button type="button" className={styles.btn} disabled={action.isPending} onClick={() => action.mutate('apply')}>{action.isPending && action.variables === 'apply' ? 'Применяем…' : 'Применить изменения'}</button>
      <button type="button" className={styles.btn} disabled={action.isPending} onClick={() => action.mutate('reject')}>Отклонить</button>
    </div> : <p className={styles.hint} role="status">{data.status === 'expired' ? 'Предложение устарело. Попросите агента подготовить новое.' : data.status === 'rejected' || action.variables === 'reject' ? 'Предложение отклонено' : 'Изменения приняты'}</p>}
    {action.isError && <p className={styles.error} role="alert">{action.error.message}</p>}
  </div>
}
export function ProposalCard({ text, data }: { text: string | null; data: Proposal }) {
  const { procurementId } = useChat()
  const client = useQueryClient()
  return <ProposalActions text={text} data={data} resolve={async (action) => {
    const result = await api.resolveProposal(procurementId, data.id, action)
    await client.invalidateQueries({ queryKey: procurementKey(procurementId) })
    return result
  }} />
}

export function SourceBlockedCard({ text, data, createdAt }: { text: string | null; data: SourceBlocked; createdAt?: string }) {
  const { procurementId, openBrowser } = useChat()
  const skip = useMutation({ mutationFn: () => api.skipSource(procurementId, data.source_id) })
  const waiting = data.status === 'waiting' && !skip.isSuccess
  const seconds = useCountdown(waiting ? deadlineOf(data, createdAt) : null, data.wait_seconds ?? DEFAULT_WAIT_SECONDS)
  const left = minutesLeft(seconds ?? 0)
  return <div className={styles.note}>
    <Icon name="alert" />
    <p>{text ?? `${data.name} просит ${data.reason === 'login' ? 'войти на сайт' : 'пройти проверку'}.`}
      {waiting && seconds != null && ` Без неё агент пропустит сайт через ${left} ${plural(left, 'минуту', 'минуты', 'минут')}, поиск продолжится.`}</p>
    {waiting ? <div className={styles.actions}>
      <button type="button" className={styles.btn} onClick={() => openBrowser?.()}>Открыть браузер</button>
      <button type="button" className={styles.btn} disabled={skip.isPending} onClick={() => skip.mutate()}>{skip.isPending ? 'Пропускаем…' : 'Пропустить источник'}</button>
    </div> : <p className={styles.hint}>{data.status === 'resolved' ? 'Проверка пройдена' : 'Источник пропущен'}</p>}
    {skip.isError && <p className={styles.error} role="alert">{skip.error.message}</p>}
  </div>
}
