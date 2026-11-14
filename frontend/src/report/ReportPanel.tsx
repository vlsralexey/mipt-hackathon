import type { ProcurementStatus } from '../api/types'
import type { useReport } from './useReport'
import { ReportView } from './ReportView'
import styles from './report.module.css'

interface ReportPanelProps {
  query: ReturnType<typeof useReport>
  hasReport: boolean
  status: ProcurementStatus
  viewing: number | null
  onViewingChange: (version: number | null) => void
}

/** Содержимое вкладки «Отчёт»: отчёт, либо понятное пустое состояние. */
export function ReportPanel({ query, hasReport, status, viewing, onViewingChange }: ReportPanelProps) {
  const { report, latest } = query

  if (!hasReport) {
    return (
      <div className={styles.state}>
        <h2>Отчёта пока нет</h2>
        <p>
          {status === 'running'
            ? 'Агент ищет предложения. Отчёт появится, как только будет готова первая версия.'
            : status === 'failed'
              ? 'Прогон не завершился, отчёта нет. Причина указана в чате.'
              : 'Отчёт появится после первого прогона.'}
        </p>
      </div>
    )
  }
  if (report.isPending) return <p className={styles.state}>Загрузка отчёта…</p>
  if (report.isError && !report.data) {
    return (
      <div className={styles.state} role="alert">
        <h2>Не удалось загрузить отчёт</h2>
        <p>{report.error.message}</p>
        <button type="button" className={styles.btn} onClick={() => void report.refetch()}>
          Повторить
        </button>
      </div>
    )
  }
  if (!report.data) return null

  const isLatest = viewing === null
  return (
    <>
      {!isLatest && latest !== null && report.data.version !== latest && (
        <div className={styles.pinned}>
          <span>
            Вы смотрите версию {report.data.version}, последняя: {latest}.
          </span>
          <button type="button" className={styles.btn} onClick={() => onViewingChange(null)}>
            Открыть последнюю
          </button>
        </div>
      )}
      {/* key: при смене версии свёрнутые разделы и выбранная позиция сбрасываются */}
      <ReportView key={report.data.version} report={report.data} isLatest={isLatest} />
    </>
  )
}
