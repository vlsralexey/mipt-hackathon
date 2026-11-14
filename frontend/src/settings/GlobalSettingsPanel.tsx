import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { Message } from '../api/types'
import { Composer } from '../components/Composer'
import { Markdown } from '../chat/Markdown'
import { mergeMessage } from '../chat/merge'
import { ProposalActions } from '../chat/messages/NoteCards'
import styles from './SettingsPanels.module.css'

export function GlobalSettingsPanel() {
  const client = useQueryClient()
  const config = useQuery({ queryKey: ['config'], queryFn: api.getConfig })
  const changes = useQuery({ queryKey: ['config-changes'], queryFn: api.getConfigChanges })
  const messages = useQuery({ queryKey: ['config-messages'], queryFn: api.getConfigMessages })
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
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
  const send = useMutation({
    mutationFn: (text: string) => api.sendConfigMessage(text),
    onSuccess: (message) => { client.setQueryData<Message[]>(['config-messages'], (old) => mergeMessage(old ?? [], message)) },
    onError: (_error, value) => setText((current) => current || value),
  })
  const cancel = useMutation({ mutationFn: (id: string) => api.cancelConfigChange(id), onSuccess: () => { void client.invalidateQueries({ queryKey: ['config-changes'] }); void client.invalidateQueries({ queryKey: ['config'] }); void client.invalidateQueries({ queryKey: ['config-messages'] }) } })
  const problem = config.error ?? changes.error ?? messages.error
  return <div className={styles.section}>
    <h2>Общие источники и правила</h2>
    <p>Эти настройки используются для новых закупок. Уже созданные сохраняют свою базу, пока вы не выберете пересчёт по общим.</p>
    {config.isPending && <p role="status">Загрузка правил и источников…</p>}
    {problem && <div className={styles.error} role="alert"><p>{problem.message}</p><button type="button" onClick={() => { void config.refetch(); void changes.refetch(); void messages.refetch() }}>Повторить загрузку</button></div>}
    <details><summary>Правила расчёта</summary><dl className={styles.values}>{config.data?.rules.map((rule) => <div key={rule.key}><dt title={rule.description}>{rule.title}</dt><dd>{rule.display}<small>{rule.description}</small></dd></div>)}</dl></details>
    <details><summary>Источники поиска</summary><dl className={styles.values}>{config.data?.sources.map((source) => <div key={source.id}><dt>{source.name}<small>Уровень {source.level}</small></dt><dd>{source.enabled ? 'Включён' : 'Отключён'}<small>{source.sites.join(', ')}</small>{source.vat_note && <small>{source.vat_note}</small>}{source.delivery_note && <small>{source.delivery_note}</small>}</dd></div>)}</dl></details>
    <h3>Изменить через агента</h3>
    <p>Например: «Отключи источник» или «Измени порог разброса». Агент покажет изменения для подтверждения.</p>
    <div className={styles.chat} aria-label="Чат настроек">{messages.data?.map((message) => <div key={message.id} className={message.role === 'user' ? styles.user : styles.message}>
      {message.kind === 'proposal' ? <ProposalActions showVersion={false} text={message.text} data={message.data} resolve={async (action) => { const result = await api.resolveConfigProposal(message.data.id, action); await Promise.all([client.invalidateQueries({ queryKey: ['config-messages'] }), client.invalidateQueries({ queryKey: ['config'] }), client.invalidateQueries({ queryKey: ['config-changes'] })]); return result }} /> : message.text ? <Markdown text={message.text} /> : null}
    </div>)}</div>
    {busy && <p role="status">Агент готовит изменения…</p>}
    <Composer text={text} onTextChange={setText} label="Сообщение агенту настроек" placeholder="Что изменить в источниках или правилах?" pending={send.isPending} error={send.error?.message} onSubmit={() => { const value = text.trim(); if (value) { setText(''); send.mutate(value) } }} />
    <details><summary>Журнал изменений</summary><ul className={styles.history}>{changes.data?.length === 0 && <li>Общие настройки ещё не менялись.</li>}{changes.data?.map((change) => <li key={change.id}><time dateTime={change.created_at}>{new Date(change.created_at).toLocaleString('ru-RU')}</time><strong>{change.title}</strong><p>{change.before} → {change.after}</p><p>{change.reason}</p>{change.status === 'active' ? <button type="button" disabled={cancel.isPending} onClick={() => cancel.mutate(change.id)}>Отменить это изменение</button> : <span>Изменение отменено</span>}</li>)}</ul></details>
    {cancel.isError && <p className={styles.error} role="alert">{cancel.error.message}</p>}
  </div>
}
