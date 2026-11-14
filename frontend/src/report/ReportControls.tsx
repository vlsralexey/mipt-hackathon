import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import type { Report, VersionInfo } from '../api/types'
import { Icon } from '../components/Icon'
import { formatDay } from '../format'
import styles from './report.module.css'

interface ReportControlsProps {
  procurementId: string
  versions: VersionInfo[]
  report: Report
  latest: number | null
  /** `null`: следить за последней версией. */
  onViewingChange: (version: number | null) => void
  /** Открыть сравнение версий над отчётом. */
  onCompare: () => void
}

/** Шапка панели отчёта: меню версии (выбор и сравнение) и выгрузка DOCX. */
export function ReportControls({ procurementId, versions, report, latest, onViewingChange, onCompare }: ReportControlsProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        toggle.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function choose(version: number) {
    onViewingChange(version === latest ? null : version)
    setOpen(false)
    toggle.current?.focus()
  }

  return (
    <div className={styles.controls}>
      <div className={styles.versionMenu} ref={root}>
        <button
          ref={toggle}
          type="button"
          className={styles.versionBtn}
          aria-expanded={open}
          aria-controls="version-menu"
          aria-label={`Версия отчёта: ${report.version}`}
          onClick={() => setOpen(!open)}
        >
          Версия {report.version}
          <Icon name="chev" />
        </button>
        {open && (
          <div id="version-menu" className={styles.versionPop}>
            <ul aria-label="Версии отчёта">
              {[...versions].reverse().map((v) => (
                <li key={v.version}>
                  <button
                    type="button"
                    className={styles.versionItem}
                    aria-current={v.version === report.version ? 'true' : undefined}
                    aria-label={`Версия ${v.version}, ${formatDay(v.created_at)}`}
                    onClick={() => choose(v.version)}
                  >
                    <span>Версия {v.version}</span>
                    <span className={styles.muted}>{formatDay(v.created_at)}</span>
                    {v.version === report.version && <Icon name="check" className={styles.versionCheck} />}
                  </button>
                </li>
              ))}
            </ul>
            {versions.length > 1 && (
              <button
                type="button"
                className={styles.versionCompare}
                onClick={() => {
                  setOpen(false)
                  onCompare()
                }}
              >
                Сравнить версии
              </button>
            )}
          </div>
        )}
      </div>
      <a className={styles.docx} href={api.exportDocxUrl(procurementId, report.version)} download aria-label="Скачать DOCX" title="Скачать DOCX">
        <Icon name="down" />
        <span className={styles.docxText}>DOCX</span>
      </a>
    </div>
  )
}
