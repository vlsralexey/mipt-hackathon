import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api/client'
import type { VersionInfo } from '../api/types'
import { DiffSummary } from './DiffSummary'
import styles from './report.module.css'

export function VersionComparison({ procurementId, versions }: { procurementId: string; versions: VersionInfo[] }) {
  const [from, setFrom] = useState<number | null>(null)
  const [to, setTo] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  const a = from ?? versions.at(-2)?.version ?? versions[0]?.version ?? 1
  const b = to ?? versions.at(-1)?.version ?? 1
  const diff = useQuery({ queryKey: ['version-diff', procurementId, a, b], queryFn: () => api.getVersionDiff(procurementId, a, b), enabled: open && versions.length > 1 })
  if (versions.length < 2) return null
  return <details className={styles.comparison} onToggle={(e) => setOpen(e.currentTarget.open)}><summary>Сравнить версии</summary>{open && <><div className={styles.compareControls}>
    <label>Было <select value={a} onChange={(e) => setFrom(Number(e.target.value))}>{versions.map((v) => <option key={v.version} value={v.version}>Версия {v.version}</option>)}</select></label>
    <label>Стало <select value={b} onChange={(e) => setTo(Number(e.target.value))}>{versions.map((v) => <option key={v.version} value={v.version}>Версия {v.version}</option>)}</select></label>
  </div>{diff.isPending && <p role="status">Загрузка различий…</p>}{diff.isError && <div role="alert"><p>{diff.error.message}</p><button type="button" onClick={() => void diff.refetch()}>Повторить</button></div>}{diff.data && <DiffSummary diff={diff.data} />}</>}</details>
}
