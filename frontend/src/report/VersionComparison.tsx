import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import type { VersionInfo } from '../api/types'
import { Icon } from '../components/Icon'
import { DiffSummary } from './DiffSummary'
import styles from './report.module.css'

/** Сравнение двух версий над отчётом; открывается из меню версии. */
export function VersionComparison({
  procurementId,
  versions,
  onClose,
}: {
  procurementId: string
  versions: VersionInfo[]
  onClose: () => void
}) {
  const [from, setFrom] = useState<number | null>(null)
  const [to, setTo] = useState<number | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const a = from ?? versions.at(-2)?.version ?? versions[0]?.version ?? 1
  const b = to ?? versions.at(-1)?.version ?? 1
  const diff = useQuery({
    queryKey: ['version-diff', procurementId, a, b],
    queryFn: () => api.getVersionDiff(procurementId, a, b),
    enabled: versions.length > 1,
  })
  useEffect(() => heading.current?.focus(), [])
  if (versions.length < 2) return null
  return (
    <section className={styles.comparison} aria-labelledby="compare-title">
      <div className={styles.compareHead}>
        <h2 id="compare-title" ref={heading} tabIndex={-1}>
          Сравнение версий
        </h2>
        <button type="button" className={styles.chev} aria-label="Закрыть сравнение" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className={styles.compareControls}>
        <label>
          Было
          <select value={a} onChange={(e) => setFrom(Number(e.target.value))}>
            {versions.map((v) => (
              <option key={v.version} value={v.version}>
                Версия {v.version}
              </option>
            ))}
          </select>
        </label>
        <label>
          Стало
          <select value={b} onChange={(e) => setTo(Number(e.target.value))}>
            {versions.map((v) => (
              <option key={v.version} value={v.version}>
                Версия {v.version}
              </option>
            ))}
          </select>
        </label>
      </div>
      {diff.isPending && <p role="status">Загрузка различий…</p>}
      {diff.isError && (
        <div role="alert">
          <p>{diff.error.message}</p>
          <button type="button" className={styles.btn} onClick={() => void diff.refetch()}>
            Повторить
          </button>
        </div>
      )}
      {diff.data && <DiffSummary diff={diff.data} />}
    </section>
  )
}
