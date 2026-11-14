import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { api } from '../api/client'
import type { LocalSetting } from '../api/types'
import { Problem, Row, RowsSkeleton } from './SettingsParts'
import { formatValue, ruleRows, splitSourceName, type RuleValue } from './rules'
import styles from './SettingsPanels.module.css'

type Change = (editId: string | null) => void

/** Правила этой закупки: те же строки, что в общих настройках, плюс отличия от общих. */
export function LocalSettingsPanel({ procurementId, active }: { procurementId: string; active: boolean }) {
  const client = useQueryClient()
  const settings = useQuery({ queryKey: ['local-settings', procurementId], queryFn: () => api.getLocalSettings(procurementId), enabled: active, refetchInterval: active ? 10000 : false })
  const change = useMutation({
    mutationFn: (editId: string | null) => editId ? api.cancelEdits(procurementId, [editId]) : api.rebaseSettings(procurementId),
    onSuccess: async () => { await Promise.all([client.invalidateQueries({ queryKey: ['local-settings', procurementId] }), client.invalidateQueries({ queryKey: ['procurement', procurementId] }), client.invalidateQueries({ queryKey: ['reports', procurementId] })]) },
  })
  const items = settings.data?.items ?? []
  const outdated = settings.data?.base_outdated ?? []
  return (
    <div className={styles.local}>
      <p className={styles.lead}>Зафиксированы для этой закупки. Изменить только здесь можно через чат закупки.</p>
      {settings.isPending ? <RowsSkeleton rows={5} label="Загрузка настроек" />
        : settings.isError ? <Problem message={settings.error.message} retrying={settings.isFetching} onRetry={() => void settings.refetch()} />
          : (
            <>
              {outdated.length > 0 && (
                <div className={styles.outdated}>
                  <h3>Общие правила изменились</h3>
                  <ul>{outdated.map((v) => <li key={v.key}>{v.title}: <b>{formatValue(v.base)}</b> <span className={styles.arrow}>→</span> <b>{formatValue(v.current)}</b></li>)}</ul>
                  <div className={styles.outdatedActions}>
                    <button type="button" className={styles.primary} disabled={change.isPending} onClick={() => change.mutate(null)}>Пересчитать по общим</button>
                    <span>Позиции и правки сохранятся, появится новая версия отчёта.</span>
                  </div>
                </div>
              )}
              <section className={styles.section} aria-labelledby="local-rules-heading">
                <h2 id="local-rules-heading">Правила расчёта</h2>
                <LocalRules items={items.filter((item) => item.group === 'rules')} pending={change.isPending} onChange={change.mutate} />
              </section>
              <section className={styles.section} aria-labelledby="local-sources-heading">
                <h2 id="local-sources-heading">Источники</h2>
                <LocalSources items={items.filter((item) => item.group === 'sources')} pending={change.isPending} onChange={change.mutate} />
              </section>
            </>
          )}
      {change.isSuccess && <p className={styles.note} role="status">Запрос принят. Результат появится в чате закупки.</p>}
      {change.isError && <p className={styles.error} role="alert">{change.error.message}</p>}
    </div>
  )
}

const ruleKey = (item: LocalSetting) => item.key.replace(/^rules\./, '')

function LocalRules({ items, pending, onChange }: { items: LocalSetting[]; pending: boolean; onChange: Change }) {
  const byKey = new Map(items.map((item) => [ruleKey(item), item]))
  const local: RuleValue[] = items.map((item) => ({ key: ruleKey(item), title: item.title, display: item.display }))
  const global = new Map(ruleRows(items.map((item) => ({ key: ruleKey(item), title: item.title, display: item.global_display }))).map((row) => [row.id, row]))
  return (
    <div className={styles.rows}>
      {ruleRows(local).map((row) => {
        const changed = row.keys.map((key) => byKey.get(key)).filter((item): item is LocalSetting => Boolean(item?.changed))
        return (
          <Row key={row.id} label={row.label} muted={row.technical}>
            {row.content}
            {changed.length > 0 && <Difference changed={changed} common={global.get(row.id)?.content} pending={pending} onChange={onChange} />}
          </Row>
        )
      })}
    </div>
  )
}

function LocalSources({ items, pending, onChange }: { items: LocalSetting[]; pending: boolean; onChange: Change }) {
  // Ключи вида sources.<id>.enabled и sources.<id>.sites: собираем по источнику
  const ids = [...new Set(items.map((item) => item.key.split('.')[1]))]
  return (
    <div className={styles.rows}>
      {ids.map((id) => {
        const enabled = items.find((item) => item.key === `sources.${id}.enabled`)
        const sites = items.find((item) => item.key === `sources.${id}.sites`)
        const title = (enabled ?? sites)!.title
        const [name, about] = splitSourceName(title.slice(0, title.lastIndexOf(': ') > 0 ? title.lastIndexOf(': ') : undefined))
        const describe = (display: string | undefined, on: string | undefined) => <>
          {display && display !== 'Список пуст' ? display : about ?? 'Сайты из поиска'}
          {on !== undefined && <span className={on === 'Да' ? styles.state : styles.stateOff}> · {on === 'Да' ? 'включён' : 'отключён'}</span>}
        </>
        const changed = [enabled, sites].filter((item): item is LocalSetting => Boolean(item?.changed))
        return (
          <Row key={id} label={name}>
            {describe(sites?.display, enabled?.display)}
            {changed.length > 0 && <Difference changed={changed} common={describe(sites?.global_display, enabled?.global_display)} pending={pending} onChange={onChange} />}
          </Row>
        )
      })}
    </div>
  )
}

/** Отличие от общих настроек: общее значение и сброс каждой локальной правки. */
function Difference({ changed, common, pending, onChange }: { changed: LocalSetting[]; common: ReactNode; pending: boolean; onChange: Change }) {
  return (
    <div className={styles.difference}>
      <span className={styles.badge}>Изменено здесь</span>
      <span className={styles.common}>Общее: {common}</span>
      {changed.filter((item) => item.edit_id).map((item) => (
        <button key={item.key} type="button" className={styles.textButton} disabled={pending} onClick={() => onChange(item.edit_id)}>
          {changed.length > 1 ? `Сбросить: ${item.title}` : 'Сбросить изменение'}
        </button>
      ))}
    </div>
  )
}
