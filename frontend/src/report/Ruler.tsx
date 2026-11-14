import type { PositionReport } from '../api/types'
import { formatMoney } from '../format'
import { layoutRuler } from './ruler'
import styles from './report.module.css'

const numbers = (values: (string | null)[]) => values.filter((v): v is string => v !== null).map(Number)

/** Цены на одной оси: точки, среднее и допустимый коридор. Выбросы — пустые красные точки. */
export function Ruler({ position }: { position: PositionReport }) {
  const { stats } = position
  if (!stats) return null

  const points = numbers(position.included.map((o) => o.normalized_price))
  const outliers = numbers(
    position.excluded.filter((o) => o.exclusion === 'anomalous_price').map((o) => o.normalized_price),
  )
  if (points.length === 0 && outliers.length === 0) return null

  const mean = Number(stats.mean)
  const lower = stats.lower_bound === null ? null : Number(stats.lower_bound)
  const upper = stats.upper_bound === null ? null : Number(stats.upper_bound)
  const layout = layoutRuler({ points, outliers, mean, lower, upper })
  const at = (percent: number) => `${percent.toFixed(3)}%`
  const all = [...points, ...outliers]
  const label = [
    `Цены: ${all.map((v) => formatMoney(String(v))).join(', ')}.`,
    `Среднее ${formatMoney(stats.mean)}.`,
    lower !== null && upper !== null
      ? `Допустимый коридор от ${formatMoney(stats.lower_bound)} до ${formatMoney(stats.upper_bound)}.`
      : '',
  ].join(' ')

  return (
    <div className={styles.ruler} role="img" aria-label={label}>
      <div className={styles.axis} />
      {layout.band && (
        <div
          className={styles.band}
          style={{ left: at(layout.band.from), width: at(layout.band.to - layout.band.from) }}
        />
      )}
      <div className={styles.mean} style={{ left: at(layout.mean) }} />
      {points.map((v, i) => (
        <span key={`p${i}`} className={styles.pt} style={{ left: at(layout.points[i]) }} title={formatMoney(String(v))} />
      ))}
      {outliers.map((v, i) => (
        <span
          key={`x${i}`}
          className={`${styles.pt} ${styles.ex}`}
          style={{ left: at(layout.outliers[i]) }}
          title={`${formatMoney(String(v))}, исключена как выброс`}
        />
      ))}
      {layout.band && (
        <>
          <span className={`${styles.lbl} ${styles.lblStart}`} style={{ left: at(layout.band.from) }}>
            {formatMoney(stats.lower_bound)}
          </span>
          <span className={`${styles.lbl} ${styles.lblEnd}`} style={{ left: at(layout.band.to) }}>
            {formatMoney(stats.upper_bound)}
          </span>
        </>
      )}
      <span className={`${styles.lbl} ${styles.lblMean}`} style={{ left: at(layout.mean) }}>
        среднее {formatMoney(stats.mean)}
      </span>
    </div>
  )
}
