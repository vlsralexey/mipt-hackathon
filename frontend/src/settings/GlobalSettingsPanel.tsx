import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import type { ConfigChange, Message, Proposal } from '../api/types'
import { Composer } from '../components/Composer'
import { Icon } from '../components/Icon'
import { Markdown } from '../chat/Markdown'
import { mergeMessage } from '../chat/merge'
import { Problem } from './SettingsParts'
import styles from './SettingsPanels.module.css'

const SUGGESTIONS = ['Разброс не выше 25 %', 'Отключи магазины', 'Индексация с 3 месяцев']

/** Агент общих настроек: просьба словами, предложение «было → стало», журнал с отменой. */
export function GlobalSettingsPanel({ className }: { className?: string }) {
  const client = useQueryClient()
  const changes = useQuery({ queryKey: ['config-changes'], queryFn: api.getConfigChanges })
  const messages = useQuery({ queryKey: ['config-messages'], queryFn: api.getConfigMessages })
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const composer = useRef<HTMLDivElement>(null)
  const thread = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const source = new EventSource('/api/config/events')
    const refresh = () => {
      void client.invalidateQueries({ queryKey: ['config'] })
      void client.invalidateQueries({ queryKey: ['config-changes'] })
    }
    source.addEventListener('open', () => { refresh(); void client.invalidateQueries({ queryKey: ['config-messages'] }) })
    source.addEventListener('message', (e) => {
      try {
        const message = JSON.parse((e as MessageEvent<string>).data) as Message
        client.setQueryData<Message[]>(['config-messages'], (old) => mergeMessage(old ?? [], message))
      } catch { void client.invalidateQueries({ queryKey: ['config-messages'] }) }
    })
    source.addEventListener('agent', (e) => { try { setBusy(JSON.parse((e as MessageEvent<string>).data).busy) } catch { setBusy(false) } })
    source.addEventListener('config', refresh)
    return () => source.close()
  }, [client])

  // Новое сообщение прокручивает переписку вниз
  const count = messages.data?.length ?? 0
  useEffect(() => {
    const el = thread.current
    if (el) el.scrollTop = el.scrollHeight
  }, [count, busy])

  const send = useMutation({
    mutationFn: (value: string) => api.sendConfigMessage(value),
    onSuccess: (message) => { client.setQueryData<Message[]>(['config-messages'], (old) => mergeMessage(old ?? [], message)) },
    onError: (_error, value) => setText((current) => current || value),
  })
  const refreshAll = () => Promise.all([
    client.invalidateQueries({ queryKey: ['config-messages'] }),
    client.invalidateQueries({ queryKey: ['config'] }),
    client.invalidateQueries({ queryKey: ['config-changes'] }),
  ])

  function suggest(value: string) {
    setText(value)
    const field = composer.current?.querySelector('textarea')
    field?.focus()
    // Курсор в конец подставленного текста, чтобы можно было сразу дописать
    requestAnimationFrame(() => field?.setSelectionRange(value.length, value.length))
  }

  return (
    <aside className={`${styles.agent} ${className ?? ''}`} aria-labelledby="agent-heading">
      <h2 id="agent-heading">Изменить правила</h2>
      <div ref={thread} className={styles.thread} aria-label="Чат настроек">
        {messages.isError && <Problem message={messages.error.message} retrying={messages.isFetching} onRetry={() => void messages.refetch()} />}
        {messages.isSuccess && count === 0 && <p className={styles.intro}>Напишите, что поменять. Агент покажет изменение, применится оно только после вашего подтверждения.</p>}
        {messages.data?.map((message) => message.kind === 'proposal'
          ? <ConfigProposal key={message.id} data={message.data} resolve={async (action) => { const result = await api.resolveConfigProposal(message.data.id, action); await refreshAll(); return result }} />
          : message.text ? <div key={message.id} className={message.role === 'user' ? styles.user : styles.message}><Markdown text={message.text} /></div> : null)}
        {busy && <p className={styles.busy} role="status"><Icon name="spin" className={styles.spin} />Агент готовит изменения…</p>}
      </div>
      <div className={styles.suggestions}>
        {SUGGESTIONS.map((value) => <button key={value} type="button" className={styles.chip} onClick={() => suggest(value)}>{value}</button>)}
      </div>
      <div ref={composer} className={styles.composer}>
        <Composer text={text} onTextChange={setText} label="Сообщение агенту настроек" placeholder="Что изменить?" pending={send.isPending} error={send.error?.message} onSubmit={() => { const value = text.trim(); if (value) { setText(''); send.mutate(value) } }} />
      </div>
      <History changes={changes.data} error={changes.error} retrying={changes.isFetching} onRetry={() => void changes.refetch()} onCancelled={refreshAll} />
    </aside>
  )
}

/** Предложение агента: что меняется, было → стало, применяется только нажатием. */
function ConfigProposal({ data, resolve }: { data: Proposal; resolve: (action: 'apply' | 'reject') => Promise<unknown> }) {
  const action = useMutation({ mutationFn: (value: 'apply' | 'reject') => resolve(value) })
  const rules = data.diff.rules_changed
  const pending = data.status === 'pending' && !action.isSuccess
  return (
    <div className={styles.proposal}>
      {rules.length > 0 ? rules.map((rule) => (
        <div key={rule.key} className={styles.proposalRule}>
          <span>{rule.title}</span>
          <span className={styles.proposalValues}>{rule.before} <span className={styles.arrow}>→</span> {rule.after}</span>
        </div>
      )) : <p>{data.text}</p>}
      <p className={styles.proposalNote}>Действует на новые закупки. Посчитанные не изменятся.</p>
      {pending ? (
        <div className={styles.proposalActions}>
          <button type="button" className={styles.primary} disabled={action.isPending} onClick={() => action.mutate('apply')}>{action.isPending && action.variables === 'apply' ? 'Применяем…' : 'Применить'}</button>
          <button type="button" className={styles.secondary} disabled={action.isPending} onClick={() => action.mutate('reject')}>Отклонить</button>
        </div>
      ) : (
        <p className={styles.proposalDone} role="status">
          {data.status === 'expired' ? 'Предложение устарело. Попросите агента подготовить новое.'
            : data.status === 'rejected' || action.variables === 'reject' ? 'Отклонено' : <><Icon name="check" />Применено</>}
        </p>
      )}
      {action.isError && <p className={styles.error} role="alert">{action.error.message}</p>}
    </div>
  )
}

function History({ changes, error, retrying, onRetry, onCancelled }: { changes?: ConfigChange[]; error: Error | null; retrying: boolean; onRetry: () => void; onCancelled: () => Promise<unknown> }) {
  const cancel = useMutation({ mutationFn: (id: string) => api.cancelConfigChange(id), onSuccess: onCancelled })
  return (
    <section className={styles.history} aria-labelledby="history-heading">
      <h3 id="history-heading">История</h3>
      {error && <Problem message={error.message} retrying={retrying} onRetry={onRetry} />}
      {changes?.length === 0 && <p className={styles.historyEmpty}>Общие правила ещё не менялись.</p>}
      {changes && changes.length > 0 && (
        <ul>
          {changes.map((change) => (
            <li key={change.id} className={change.status === 'cancelled' ? styles.cancelled : undefined}>
              <div className={styles.historyHead}>
                <strong>{change.title}</strong>
                <time dateTime={change.created_at}>{new Date(change.created_at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}</time>
              </div>
              <p className={styles.historyValues}>{change.before} → {change.after}</p>
              {change.reason && <p className={styles.historyReason}>{change.reason}</p>}
              {change.status === 'active'
                ? <button type="button" className={styles.textButton} aria-label={`Отменить изменение: ${change.title}`} disabled={cancel.isPending} onClick={() => cancel.mutate(change.id)}>{cancel.isPending && cancel.variables === change.id ? 'Отменяем…' : 'Отменить'}</button>
                : <span className={styles.historyCancelled}>Отменено</span>}
            </li>
          ))}
        </ul>
      )}
      {cancel.isError && <p className={styles.error} role="alert">{cancel.error.message}</p>}
    </section>
  )
}
