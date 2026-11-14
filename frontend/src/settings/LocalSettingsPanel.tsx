import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import styles from './SettingsPanels.module.css'

export function LocalSettingsPanel({ procurementId, active }: { procurementId: string; active: boolean }) {
  const client = useQueryClient()
  const settings = useQuery({ queryKey: ['local-settings', procurementId], queryFn: () => api.getLocalSettings(procurementId), enabled: active, refetchInterval: active ? 10000 : false })
  const change = useMutation({
    mutationFn: (editId: string | null) => editId ? api.cancelEdits(procurementId, [editId]) : api.rebaseSettings(procurementId),
    onSuccess: async () => { await Promise.all([client.invalidateQueries({ queryKey: ['local-settings', procurementId] }), client.invalidateQueries({ queryKey: ['procurement', procurementId] }), client.invalidateQueries({ queryKey: ['reports', procurementId] })]) },
  })
  return <div className={styles.section}>
    <h2>Настройки этой закупки</h2>
    <p>Правила расчёта и ИПЦ зафиксированы для этой закупки. Каждый новый поиск использует текущие общие источники с учётом локальных изменений. Чтобы изменить настройку только здесь, напишите агенту в чате закупки.</p>
    {settings.isPending && <p role="status">Загрузка настроек…</p>}
    {settings.isError && <div role="alert"><p>{settings.error.message}</p><button type="button" onClick={() => void settings.refetch()}>Повторить</button></div>}
    {(settings.data?.base_outdated.length ?? 0) > 0 && <div className={styles.warning}><h3>Общие настройки изменились</h3>{settings.data?.base_outdated.map((v) => <p key={v.key}>{v.title}: база закупки {v.base}, сейчас {v.current}</p>)}<button type="button" disabled={change.isPending} onClick={() => change.mutate(null)}>Пересчитать по общим</button><p>Позиции и правки сохранятся; новые правила создадут новую версию отчёта.</p></div>}
    {(['rules', 'sources'] as const).map((group) => <section key={group}><h3>{group === 'rules' ? 'Правила расчёта' : 'Источники'}</h3><dl className={styles.values}>{settings.data?.items.filter((item) => item.group === group).map((item) => <div key={item.key}><dt>{item.title}</dt><dd>{item.display}{item.changed && <><small>Общее значение: {item.global_display}</small>{item.edit_id && <button type="button" disabled={change.isPending} onClick={() => change.mutate(item.edit_id)}>Сбросить изменение</button>}</>}</dd></div>)}</dl></section>)}
    {change.isSuccess && <p role="status">Запрос принят. Результат появится в чате закупки.</p>}
    {change.isError && <p className={styles.error} role="alert">{change.error.message}</p>}
  </div>
}
