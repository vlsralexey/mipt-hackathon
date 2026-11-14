import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../api/client'
import type { Settings } from '../api/types'
import { Icon } from '../components/Icon'
import { useGoBack } from '../useGoBack'
import styles from './SettingsPage.module.css'

/** Ключ и модель сохраняются на сервере; сохранённый ключ никогда не загружается в форму. */
export function SettingsPage() {
  const goBack = useGoBack()

  // Esc закрывает страницу, если его не обработали раньше (например, список или поле)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) goBack()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [goBack])

  return (
    <div className={styles.page}>
      <button type="button" className={styles.close} aria-label="Закрыть настройки" title="Закрыть (Esc)" onClick={goBack}>
        <Icon name="x" />
      </button>
      <div className={styles.scroll}>
        <div className={styles.column}>
          <h1>Настройки</h1>
          <SettingsContent />
        </div>
      </div>
    </div>
  )
}

function SettingsContent() {
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.getSettings })
  if (settings.isPending) return <p role="status">Загрузка настроек…</p>
  if (settings.isError) return (
    <div role="alert">
      <p>{settings.error.message}</p>
      <button className={styles.secondary} type="button" onClick={() => void settings.refetch()}>Повторить</button>
    </div>
  )
  return <SettingsForm settings={settings.data} />
}

function SettingsForm({ settings }: { settings: Settings }) {
  const queryClient = useQueryClient()
  const [key, setKey] = useState('')
  const [model, setModel] = useState(settings.model)
  const [search, setSearch] = useState('')
  const models = useQuery({
    queryKey: ['openrouter-models'], queryFn: api.listModels, staleTime: 5 * 60 * 1000, retry: false,
  })
  const catalog = models.data ?? []
  const query = search.trim().toLocaleLowerCase()
  const filtered = catalog.filter((entry) => `${entry.name} ${entry.id}`.toLocaleLowerCase().includes(query))
  const selected = catalog.find((entry) => entry.id === model)
  const save = useMutation({
    mutationFn: (patch: Parameters<typeof api.putSettings>[0]) => api.putSettings(patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(['settings'], updated)
      setKey('')
      setModel(updated.model)
    },
  })
  const changed = key.trim() !== '' || model.trim() !== settings.model
  const keyStatus = settings.key_source === 'settings'
    ? 'Ключ сохранён в настройках.'
    : settings.key_source === 'env'
      ? 'Используется ключ из окружения сервера.'
      : 'Ключ не задан. Добавьте его, чтобы запустить поиск и чат.'

  function submit(e: FormEvent) {
    e.preventDefault()
    const patch: { openrouter_api_key?: string; model?: string } = {}
    if (key.trim()) patch.openrouter_api_key = key.trim()
    if (model.trim() !== settings.model) patch.model = model.trim()
    if (changed && model.trim()) save.mutate(patch)
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className={styles.field}>
        <label htmlFor="api-key">Ключ OpenRouter</label>
        <p id="key-status">{keyStatus}</p>
        <input id="api-key" type="password" autoComplete="new-password" value={key}
          aria-describedby="key-status key-help" placeholder={settings.has_api_key ? 'Новый ключ для замены' : 'sk-or-v1-…'}
          disabled={save.isPending} onChange={(e) => { setKey(e.target.value); save.reset() }} />
        <p id="key-help">Пустое поле сохраняет текущий ключ.</p>
        {settings.key_source === 'settings' && (
          <button className={styles.secondary} type="button" disabled={save.isPending}
            onClick={() => save.mutate({ openrouter_api_key: '' })}>Удалить сохранённый ключ</button>
        )}
      </div>
      <div className={styles.field}>
        <label htmlFor="model">Модель</label>
        {models.isError || (models.isSuccess && catalog.length === 0) ? (
          <input id="model" value={model} required aria-describedby="model-help" disabled={save.isPending}
            onChange={(e) => { setModel(e.target.value); save.reset() }} />
        ) : (
          <>
            <input type="search" aria-label="Поиск модели" placeholder="Поиск по названию или ID"
              value={search} disabled={save.isPending || models.isPending}
              onChange={(e) => setSearch(e.target.value)} />
            <select id="model" value={model} required aria-describedby="model-help"
              disabled={save.isPending || models.isPending}
              onChange={(e) => { setModel(e.target.value); save.reset() }}>
              {!model && <option value="" disabled>Выберите модель</option>}
              {model && !filtered.some((entry) => entry.id === model) && (
                <option value={model}>{selected?.name ?? model} (текущая)</option>
              )}
              {filtered.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {entry.id}</option>)}
            </select>
            {models.isPending && <p role="status">Загрузка моделей…</p>}
            {models.isSuccess && filtered.length === 0 && <p role="status">Модели не найдены. Измените запрос.</p>}
          </>
        )}
        <p id="model-help">Модели OpenRouter с текстовым входом и выходом. Для работы агента нужна поддержка инструментов и структурированных ответов.</p>
        {models.isError && <p className={styles.error} role="alert">{models.error.message}</p>}
        {models.isSuccess && catalog.length === 0 && <p role="status">В каталоге нет текстовых моделей. Укажите ID вручную.</p>}
        <button className={styles.secondary} type="button" disabled={models.isFetching || save.isPending}
          onClick={() => void models.refetch()}>{models.isFetching ? 'Загрузка…' : 'Обновить список моделей'}</button>
      </div>
      <div className={styles.actions}>
        <button className={styles.save} type="submit" disabled={save.isPending || !changed || !model.trim()}>
          {save.isPending ? 'Сохранение…' : 'Сохранить'}
        </button>
        {save.isSuccess && <p role="status">Настройки сохранены</p>}
      </div>
      {save.isError && <p className={styles.error} role="alert">{save.error.message}</p>}
    </form>
  )
}
