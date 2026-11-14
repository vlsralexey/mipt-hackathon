import type { RunState, RunStep } from '../../api/types'
import { Icon, type IconName } from '../../components/Icon'
import { stepStatusLabel } from '../../labels'
import { groupSteps, type SourceRow } from '../steps'
import styles from './cards.module.css'

const marks: Record<RunStep['status'], { icon: IconName; tone: string }> = {
  ok: { icon: 'check', tone: styles.ok },
  empty: { icon: 'dash', tone: styles.empty },
  skipped: { icon: 'dash', tone: styles.empty },
  queued: { icon: 'dash', tone: styles.empty },
  error: { icon: 'x', tone: styles.err },
  unavailable: { icon: 'x', tone: styles.err },
  needs_login: { icon: 'alert', tone: styles.wait },
  running: { icon: 'spin', tone: styles.run },
}

/** Правая колонка строки: сколько подошло, пояснение источника или статус словами. */
function result(row: SourceRow): string {
  if (row.status === 'ok' && row.relevant !== null) return `${row.relevant} из ${row.found}`
  if (row.status === 'ok') return `найдено ${row.found}`
  return row.note ?? stepStatusLabel[row.status]
}

/** Ход поиска: одна строка-итог от бэкенда, источники — по клику. */
export function RunCard({ data }: { data: RunState }) {
  const rows = groupSteps(data.steps)
  return (
    <details className={styles.trace}>
      <summary>
        {data.state === 'running' && <Icon name="spin" className={`${styles.mark} ${styles.run}`} />}
        {data.summary}
        <Icon name="chev" className={styles.chev} />
      </summary>
      <div className={styles.steps}>
        {rows.map((row) => {
          const mark = marks[row.status]
          return (
            <div key={row.source_id} className={styles.step}>
              <Icon name={mark.icon} className={`${styles.mark} ${mark.tone}`} />
              <span>{row.name}</span>
              <span className={styles.r}>{result(row)}</span>
            </div>
          )
        })}
      </div>
    </details>
  )
}
