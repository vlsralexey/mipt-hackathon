import type { OfferEntry, PositionReport, UserMark } from '../api/types'
import { Icon } from '../components/Icon'
import { formatIsoDate, formatMoney } from '../format'
import { priceSteps } from './priceSteps'
import { isHttpUrl } from './safe-url'
import styles from './report.module.css'

const markLabel: Record<UserMark, string> = {
  corrected: 'исправлено вами',
  added: 'добавлено вами',
  excluded: 'исключено вами',
  excluded_by_price: 'исключено вами по цене',
  included: 'возвращено вами',
}

function Source({ entry }: { entry: OfferEntry }) {
  const { caption, offer } = entry
  return isHttpUrl(offer.url) ? (
    <a href={offer.url} target="_blank" rel="noopener noreferrer">
      {caption}
    </a>
  ) : (
    <span>{caption}</span>
  )
}

function Marks({ entry }: { entry: OfferEntry }) {
  if (entry.user_marks.length === 0) return null
  return <span className={styles.mark}> · {entry.user_marks.map((m) => markLabel[m]).join(', ')}</span>
}

/** Как получена цена и чем предложение совпало с ТЗ — чтобы каждую цену можно было проверить. */
function How({ entry }: { entry: OfferEntry }) {
  const steps = priceSteps(entry)
  const { original, comparison } = entry
  return (
    <details className={styles.how}>
      <summary>
        Как получена цена
        <Icon name="chev" className={styles.howChev} />
      </summary>
      <ol>
        {steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      {original && (
        <ul aria-label="Исправлено вами">
          {Object.entries(original).map(([field, was]) => (
            <li key={field}>
              Исправлено вами: {field}, было «{was}»
            </li>
          ))}
        </ul>
      )}
      {comparison.length > 0 && (
        <ul aria-label="Сравнение с ТЗ">
          {comparison.map((c) => (
            <li key={c.name} className={c.ok === false ? styles.cmpBad : c.ok ? styles.cmpOk : undefined}>
              {c.ok === true ? '✓' : c.ok === false ? '✗' : '?'} {c.name}: по ТЗ {c.required},{' '}
              {c.offered ?? 'в предложении нет данных'}
              {c.essential ? '' : ' (не существенная)'}
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}

export function IncludedTable({ position }: { position: PositionReport }) {
  if (position.included.length === 0) {
    return <p className={styles.empty}>В расчёт по этой позиции не вошло ни одного предложения.</p>
  }
  return (
    <table className={styles.tbl}>
      <thead>
        <tr>
          <th>Источник</th>
          <th>Дата цены</th>
          <th className={styles.r}>Цена за единицу</th>
        </tr>
      </thead>
      <tbody>
        {position.included.map((e) => (
          <tr key={e.offer.id}>
            <td>
              <Source entry={e} />
              <Marks entry={e} />
              <How entry={e} />
            </td>
            <td>{formatIsoDate(e.offer.price_date)}</td>
            <td className={styles.r}>{formatMoney(e.normalized_price)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function ExcludedTable({ position }: { position: PositionReport }) {
  if (position.excluded.length === 0) {
    return <p className={styles.empty}>Исключённых предложений по этой позиции нет.</p>
  }
  return (
    <table className={styles.tbl}>
      <thead>
        <tr>
          <th>Источник и причина</th>
          <th className={styles.r}>Цена за единицу</th>
        </tr>
      </thead>
      <tbody>
        {position.excluded.map((e) => (
          <tr key={e.offer.id} className={styles.excluded}>
            <td>
              <Source entry={e} />
              <Marks entry={e} />
              <span className={styles.reason}>{e.reason}</span>
              <How entry={e} />
            </td>
            <td className={`${styles.r} ${styles.price}`}>
              {formatMoney(e.normalized_price ?? e.base_price ?? e.offer.price)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
