import { useLayoutEffect, useRef, useState } from 'react'
import type { OfferEntry, PositionReport } from '../api/types'
import { formatMoney } from '../format'
import { layoutRuler, DOT } from './ruler-layout'
import styles from './report.module.css'

/** Ширина до первого измерения (и в тестах, где вёрстки нет). */
const FALLBACK_WIDTH = 560
const MEAN_LABEL_H = 20
const ROW = 16
const LABEL_ROW = 22

type Priced = OfferEntry & { normalized_price: string }
const priced = (entries: OfferEntry[]) => entries.filter((e): e is Priced => e.normalized_price !== null)

function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(FALLBACK_WIDTH)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      if (el.clientWidth > 0) setWidth(el.clientWidth)
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return { ref, width }
}

/** Цены на одной оси: точки без наложений, среднее и допустимый коридор; выбросы — пустые кружки. */
export function Ruler({ position }: { position: PositionReport }) {
  const { ref, width } = useWidth()
  const { stats } = position
  const included = priced(position.included)
  const outliers = priced(position.excluded.filter((o) => o.exclusion === 'anomalous_price'))
  if (!stats || (included.length === 0 && outliers.length === 0)) return null

  const lower = stats.lower_bound === null ? null : Number(stats.lower_bound)
  const upper = stats.upper_bound === null ? null : Number(stats.upper_bound)
  const layout = layoutRuler({
    points: included.map((e) => Number(e.normalized_price)),
    outliers: outliers.map((e) => Number(e.normalized_price)),
    mean: Number(stats.mean),
    lower,
    upper,
    width,
    labels: {
      mean: `среднее ${formatMoney(stats.mean)}`,
      meanShort: formatMoney(stats.mean),
      lower: stats.lower_bound === null ? null : formatMoney(stats.lower_bound),
      upper: stats.upper_bound === null ? null : formatMoney(stats.upper_bound),
    },
  })

  const axisY = MEAN_LABEL_H + 12 + (layout.rows - 1) * ROW + DOT / 2 + 4
  const height = axisY + 18 + layout.labelRows * LABEL_ROW
  const label = [
    `Цены: ${[...included, ...outliers].map((e) => formatMoney(e.normalized_price)).join(', ')}.`,
    `Среднее ${formatMoney(stats.mean)}.`,
    lower !== null && upper !== null
      ? `Допустимый коридор от ${formatMoney(stats.lower_bound)} до ${formatMoney(stats.upper_bound)}.`
      : '',
    outliers.length > 0 ? `Выбросы: ${outliers.map((e) => formatMoney(e.normalized_price)).join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <figure className={styles.rulerWrap}>
      <div ref={ref} className={styles.ruler} style={{ height }} role="img" aria-label={label}>
        {layout.band && (
          <div
            className={styles.band}
            style={{ left: layout.band.from, width: Math.max(2, layout.band.to - layout.band.from), top: axisY - 12 }}
          />
        )}
        <div className={styles.axis} style={{ top: axisY }} />
        <div className={styles.mean} style={{ left: layout.mean, top: MEAN_LABEL_H + 4, height: axisY + 14 - MEAN_LABEL_H - 4 }} />
        {layout.dots.map((d) => {
          const entry = d.outlier ? outliers[d.index] : included[d.index]
          return (
            <span
              key={`${d.outlier ? 'x' : 'p'}${d.index}`}
              className={d.outlier ? styles.ptOut : styles.pt}
              style={{ left: d.x, top: axisY - d.row * ROW }}
              title={`${entry.label}: ${formatMoney(entry.normalized_price)}${d.outlier ? ', выброс' : ''}`}
            />
          )
        })}
        <span className={styles.lblMean} style={{ left: layout.meanLabel.left, width: layout.meanLabel.width }}>
          {layout.meanLabel.text}
        </span>
        {layout.boundLabels.map((l, i) => (
          <span
            key={i}
            className={styles.lbl}
            style={{ left: l.left, width: l.width, top: axisY + 16 + l.row * LABEL_ROW, textAlign: i === 0 ? 'left' : 'right' }}
          >
            {l.text}
          </span>
        ))}
      </div>
      <figcaption className={styles.legend}>
        <span>
          <i className={styles.legDot} aria-hidden="true" />в расчёте: {included.length}
        </span>
        {outliers.length > 0 && (
          <span>
            <i className={styles.legOut} aria-hidden="true" />
            выбросы: {outliers.length}
          </span>
        )}
        {layout.band && (
          <span>
            <i className={styles.legBand} aria-hidden="true" />
            допустимый коридор
          </span>
        )}
      </figcaption>
    </figure>
  )
}
