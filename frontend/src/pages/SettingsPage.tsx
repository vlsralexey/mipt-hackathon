import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react'
import { api } from '../api/client'
import type { Settings } from '../api/types'
import { Icon, type IconName } from '../components/Icon'
import { RulesSection, SourcesSection } from '../settings/ConfigSections'
import { GlobalSettingsPanel } from '../settings/GlobalSettingsPanel'
import { ModelPicker } from '../settings/ModelPicker'
import { Problem, Row, RowsSkeleton } from '../settings/SettingsParts'
import panels from '../settings/SettingsPanels.module.css'
import { useGoBack } from '../useGoBack'
import styles from './SettingsPage.module.css'

/**
 * Настройки: слева ключ, модель, правила и источники, справа агент, который меняет правила.
 * Сохранённый ключ никогда не загружается в форму.
 */
export function SettingsPage() {
  const goBack = useGoBack()

  // Esc закрывает страницу, если его не обработали раньше (например, список или поле)
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
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
        <div className={styles.layout}>
          <h1>Настройки</h1>
          <div className={styles.columns}>
            <div className={styles.main}>
              <ModelSection />
              <RulesSection />
              <SourcesSection />
            </div>
            <GlobalSettingsPanel className={styles.agent} />
          </div>
        </div>
      </div>
    </div>
  )
}

function ModelSection() {
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.getSettings })
  return (
    <section className={panels.section} aria-labelledby="model-heading">
      <h2 id="model-heading">Модель</h2>
      {settings.isPending ? <RowsSkeleton rows={2} label="Загрузка настроек" />
        : settings.isError ? <Problem message={settings.error.message} retrying={settings.isFetching} onRetry={() => void settings.refetch()} />
          : <div className={panels.rows}><KeyRow settings={settings.data} /><ModelRow settings={settings.data} /></div>}
    </section>
  )
}

function KeyRow({ settings }: { settings: Settings }) {
  const client = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [key, setKey] = useState('')
  const check = useMutation({ mutationFn: api.checkSettings })
  const save = useMutation({
    mutationFn: (value: string) => api.putSettings({ openrouter_api_key: value }),
    onSuccess: (updated) => {
      client.setQueryData(['settings'], updated)
      setKey('')
      setEditing(false)
      check.reset()
    },
  })
  const showField = editing || !settings.has_api_key
  const source = settings.key_source === 'env' ? 'из окружения сервера' : settings.key_source === 'settings' ? 'сохранён в настройках' : null

  let status: { icon: IconName | null; text: string; tone?: 'bad' }
  if (!settings.has_api_key) status = { icon: 'alert', text: 'Не задан', tone: 'bad' }
  else if (check.isPending) status = { icon: 'spin', text: 'Проверяем…' }
  else if (check.isError) status = { icon: 'alert', text: check.error.message, tone: 'bad' }
  else if (check.data?.ok) status = { icon: 'check', text: 'Работает' }
  else if (check.data) status = { icon: 'alert', text: check.data.detail ?? 'Ключ не работает', tone: 'bad' }
  else status = { icon: null, text: 'Не проверен' }

  function submit(e: FormEvent) {
    e.preventDefault()
    if (key.trim()) save.mutate(key.trim())
  }

  function cancel() {
    setEditing(false)
    setKey('')
    save.reset()
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape' && settings.has_api_key) {
      e.preventDefault() // закрываем только поле, а не страницу
      cancel()
    }
  }

  return (
    <Row label="Ключ OpenRouter" labelId="key-label">
      <div className={styles.stack}>
        <p className={`${styles.status} ${status.tone === 'bad' ? styles.statusBad : ''}`} role="status" id="key-status">
          {status.icon && <Icon name={status.icon} className={status.icon === 'spin' ? styles.spin : undefined} />}
          <span>{status.text}{source && <span className={styles.muted}> · {source}</span>}</span>
        </p>
        {showField ? (
          <form className={styles.keyForm} onSubmit={submit}>
            <input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              aria-labelledby="key-label"
              aria-describedby="key-status"
              placeholder={settings.has_api_key ? 'Новый ключ' : 'sk-or-v1-…'}
              value={key}
              disabled={save.isPending}
              autoFocus={editing}
              onChange={(e) => { setKey(e.target.value); save.reset() }}
              onKeyDown={onKeyDown}
            />
            <div className={styles.buttons}>
              <button type="submit" className={panels.primary} disabled={save.isPending || !key.trim()}>{save.isPending ? 'Сохраняем…' : 'Сохранить'}</button>
              {settings.has_api_key && <button type="button" className={panels.textButton} disabled={save.isPending} onClick={cancel}>Отмена</button>}
            </div>
          </form>
        ) : (
          <div className={styles.buttons}>
            <button type="button" className={panels.secondary} disabled={check.isPending || save.isPending} onClick={() => check.mutate()}>Проверить</button>
            <button type="button" className={`${panels.textButton} ${styles.flush}`} disabled={save.isPending} onClick={() => { setEditing(true); check.reset() }}>Заменить ключ</button>
          </div>
        )}
        {!showField && settings.key_source === 'settings' && (
          <button type="button" className={`${panels.textButton} ${panels.danger} ${styles.flush} ${styles.remove}`} disabled={save.isPending} onClick={() => save.mutate('')}>Удалить сохранённый ключ</button>
        )}
        {save.isError && <p className={panels.error} role="alert">{save.error.message}</p>}
      </div>
    </Row>
  )
}

function ModelRow({ settings }: { settings: Settings }) {
  const client = useQueryClient()
  const models = useQuery({ queryKey: ['openrouter-models'], queryFn: api.listModels, staleTime: 5 * 60 * 1000, retry: false })
  const [manual, setManual] = useState(settings.model)
  const save = useMutation({
    mutationFn: (model: string) => api.putSettings({ model }),
    onSuccess: (updated) => {
      client.setQueryData(['settings'], updated)
      setManual(updated.model)
    },
  })
  const { isSuccess: saved, reset } = save
  // «Сохранено» висит недолго: это подтверждение, а не состояние
  useEffect(() => {
    if (!saved) return
    const timer = setTimeout(reset, 3000)
    return () => clearTimeout(timer)
  }, [saved, reset])

  const catalog = models.data ?? []
  const noCatalog = models.isError || (models.isSuccess && catalog.length === 0)
  const value = save.isPending ? save.variables : settings.model

  function submitManual(e: FormEvent) {
    e.preventDefault()
    const id = manual.trim()
    if (id && id !== settings.model) save.mutate(id)
  }

  return (
    <Row label="Модель агента" labelId="model-label" top>
      <div className={styles.stack}>
        {noCatalog ? (
          <form className={styles.keyForm} onSubmit={submitManual}>
            <input
              aria-labelledby="model-label"
              aria-describedby="model-help"
              placeholder="ID модели, например deepseek/deepseek-v4.1-flash"
              spellCheck={false}
              value={manual}
              disabled={save.isPending}
              onChange={(e) => { setManual(e.target.value); save.reset() }}
            />
            <div className={styles.buttons}>
              <button type="submit" className={panels.primary} disabled={save.isPending || !manual.trim() || manual.trim() === settings.model}>Сохранить</button>
            </div>
          </form>
        ) : (
          <ModelPicker
            labelledBy="model-label"
            value={value}
            models={catalog}
            loading={models.isPending}
            refreshing={models.isFetching}
            disabled={models.isPending || save.isPending}
            onRefresh={() => void models.refetch()}
            onSelect={(id) => save.mutate(id)}
          />
        )}
        {noCatalog && (
          <p className={styles.help} id="model-help">
            <span role={models.isError ? 'alert' : 'status'}>{models.isError ? models.error.message : 'В каталоге нет текстовых моделей. Укажите ID вручную.'}</span>{' '}
            <button type="button" className={panels.textButton} disabled={models.isFetching} onClick={() => void models.refetch()}>{models.isFetching ? 'Загрузка…' : 'Обновить список моделей'}</button>
          </p>
        )}
        <p className={`${styles.status} ${save.isError ? styles.statusBad : ''}`} role="status">
          {save.isPending && 'Сохраняем…'}
          {save.isSuccess && <><Icon name="check" />Сохранено</>}
          {save.isError && <><Icon name="alert" />{save.error.message}</>}
        </p>
      </div>
    </Row>
  )
}
