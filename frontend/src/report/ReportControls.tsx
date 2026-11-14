import { api } from '../api/client'
import type { Report, VersionInfo } from '../api/types'
import { Icon } from '../components/Icon'
import styles from './report.module.css'

interface ReportControlsProps {
  procurementId: string
  versions: VersionInfo[]
  report: Report
  latest: number | null
  /** `null` — следить за последней версией. */
  onViewingChange: (version: number | null) => void
}

/** Шапка панели отчёта: выбор версии и выгрузка DOCX. */
export function ReportControls({ procurementId, versions, report, latest, onViewingChange }: ReportControlsProps) {
  return (
    <div className={styles.controls}>
      <select
        className={styles.versionSelect}
        aria-label="Версия отчёта"
        value={report.version}
        onChange={(e) => {
          const version = Number(e.target.value)
          onViewingChange(version === latest ? null : version)
        }}
      >
        {[...versions].reverse().map((v) => (
          <option key={v.version} value={v.version}>
            Версия {v.version}
          </option>
        ))}
      </select>
      <a className={styles.docx} href={api.exportDocxUrl(procurementId, report.version)} download>
        <Icon name="down" />
        DOCX
      </a>
    </div>
  )
}
