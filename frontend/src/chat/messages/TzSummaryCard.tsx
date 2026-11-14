import type { TzSummary } from '../../api/types'
import { formatQuantity } from '../../format'
import styles from './cards.module.css'

export function TzSummaryCard({ data }: { data: TzSummary }) {
  return (
    <ul className={styles.positions} aria-label="Позиции ТЗ">
      {data.positions.map((p) => (
        <li key={p.index}>
          <span className={styles.i}>{p.index}</span>
          <span>{p.name}</span>
          <span className={`${styles.q} ${styles.nowrap}`}>{formatQuantity(p.quantity, p.unit)}</span>
        </li>
      ))}
    </ul>
  )
}
