import type { ReactNode } from 'react'
import { Icon } from '../components/Icon'
import styles from './SettingsPanels.module.css'

/** Строка настроек «подпись | значение». */
export function Row({ label, labelId, muted = false, top = false, children }: { label: ReactNode; labelId?: string; muted?: boolean; top?: boolean; children: ReactNode }) {
  return (
    <div className={`${styles.row} ${top ? styles.rowTop : ''}`}>
      <div id={labelId} className={muted ? `${styles.label} ${styles.labelMuted}` : styles.label}>{label}</div>
      <div className={muted ? `${styles.value} ${styles.valueMuted}` : styles.value}>{children}</div>
    </div>
  )
}

/** Загрузка секции: серые полосы на месте строк. */
export function RowsSkeleton({ rows, label }: { rows: number; label: string }) {
  return (
    <div className={styles.skeleton} role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={styles.row} aria-hidden="true">
          <span className={styles.bar} style={{ width: '55%' }} />
          <span className={styles.bar} style={{ width: `${80 - (i % 3) * 15}%` }} />
        </div>
      ))}
    </div>
  )
}

/** Ошибка загрузки секции с повтором. */
export function Problem({ message, onRetry, retrying = false }: { message: string; onRetry: () => void; retrying?: boolean }) {
  return (
    <div className={styles.problem} role="alert">
      <Icon name="alert" />
      <p>{message}</p>
      <button type="button" className={styles.textButton} disabled={retrying} onClick={onRetry}>{retrying ? 'Загрузка…' : 'Повторить'}</button>
    </div>
  )
}
