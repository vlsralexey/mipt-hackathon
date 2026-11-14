import { useState, type MouseEvent } from 'react'
import type { CharComparison, OfferEntry, PositionReport, UserMark } from '../api/types'
import { Icon } from '../components/Icon'
import { formatDay, formatMoney, formatNumber, formatSupplier, hostOf, tidyText } from '../format'
import { plural } from '../plural'
import { exclusionText } from './position-text'
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

/** Подпись строки: без повтора названия источника, если оно уже в начале подписи. */
function captionTitle(entry: OfferEntry): string {
  const caption = tidyText(entry.caption)
  const prefix = `${tidyText(entry.offer.source_name)}: `
  return caption.startsWith(prefix) ? caption.slice(prefix.length) : caption
}

const CONTRACT = /^(.+?),\s*контракт\s*№\s*(.+)$/

/** «ЕИС · контракт № 2610…» (номер не переносится) или «домен · название» в одну строку. */
function SourceText({ entry, title }: { entry: OfferEntry; title: string }) {
  const contract = CONTRACT.exec(title)
  if (contract) {
    return (
      <span>
        {contract[1]} · <span className={styles.nowrap}>контракт №{'\u00a0'}{contract[2]}</span>
      </span>
    )
  }
  const host = isHttpUrl(entry.offer.url) ? hostOf(entry.offer.url) : null
  if (!host) return <span className={styles.srcClamp}>{title}</span>
  return (
    <span className={styles.srcLine}>
      <span className={styles.srcHost}>{host}</span>
      {/* пробел для скринридера; на экране отступ задаёт .srcName */}
      {title && title !== host && <> <span className={styles.srcName}>· {title}</span></>}
    </span>
  )
}

function Source({ entry, title }: { entry: OfferEntry; title: string }) {
  const full = tidyText(entry.caption)
  return isHttpUrl(entry.offer.url) ? (
    <a href={entry.offer.url} target="_blank" rel="noopener noreferrer" className={styles.srcLink} title={full}>
      <SourceText entry={entry} title={title} />
    </a>
  ) : (
    <span className={styles.srcLink} title={full}>
      <SourceText entry={entry} title={title} />
    </span>
  )
}

function Meta({ entry }: { entry: OfferEntry }) {
  const supplier = entry.offer.supplier ? formatSupplier(entry.offer.supplier) : null
  const marks = entry.user_marks.map((m) => markLabel[m])
  return (
    <span className={styles.offerMeta}>
      {supplier && `${supplier} · `}
      {/* дата не разрывается между строками */}
      <span className={styles.nowrap}>{formatDay(entry.offer.price_date) ?? 'дата не указана'}</span>
      {marks.length > 0 && <span className={styles.mark}> · {marks.join(', ')}</span>}
    </span>
  )
}

const CHECK = <path d="M5 12.5l4.5 4.5L19 7.5" />
const QUESTION = (
  <>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 8.5v4M12 15.5v.5" />
  </>
)
const CROSS = <path d="M7 7l10 10M17 7 7 17" />

function MatchIcon({ ok }: { ok: boolean | null }) {
  const label = ok === true ? 'совпадает' : ok === false ? 'не совпадает' : 'нет данных'
  return (
    <svg
      className={`${styles.chkIco} ${ok === true ? styles.ok : ok === false ? styles.err : styles.wait}`}
      viewBox="0 0 24 24"
      role="img"
      aria-label={label}
    >
      {ok === true ? CHECK : ok === false ? CROSS : QUESTION}
    </svg>
  )
}

function MatchRow({ c }: { c: CharComparison }) {
  return (
    <li className={styles.chk}>
      <MatchIcon ok={c.ok} />
      <span>{c.name}</span>
      <span className={c.ok === false ? styles.err : c.ok === null ? styles.wait : styles.muted}>
        {c.offered ?? 'нет данных'}
        {c.ok === false && <span className={styles.req}>по ТЗ: {c.required}</span>}
      </span>
    </li>
  )
}

function Match({ comparison }: { comparison: CharComparison[] }) {
  const [more, setMore] = useState(false)
  const essential = comparison.filter((c) => c.essential)
  const other = comparison.filter((c) => !c.essential)
  if (comparison.length === 0) return null
  return (
    <div className={styles.cardCol}>
      <h5>Совпадение с ТЗ</h5>
      <ul className={styles.chkList} aria-label="Сравнение с ТЗ">
        {essential.map((c) => (
          <MatchRow key={c.name} c={c} />
        ))}
        {more && other.map((c) => <MatchRow key={c.name} c={c} />)}
      </ul>
      {other.length > 0 && (
        <button type="button" className={styles.linkBtn} aria-expanded={more} onClick={() => setMore(!more)}>
          {more ? 'Скрыть несущественные' : `ещё ${other.length} ${plural(other.length, 'несущественная', 'несущественные', 'несущественных')}`}
        </button>
      )}
    </div>
  )
}

/** Как получена цена и чем предложение совпало с ТЗ: чтобы каждую цену можно было проверить. */
function Details({ entry }: { entry: OfferEntry }) {
  const { steps, total } = priceSteps(entry)
  return (
    <div className={styles.card}>
      <div className={styles.cardCol}>
        <h5>Как получена цена</h5>
        <dl className={styles.how}>
          {steps.map((s, i) => (
            // первый шаг (цена на странице) и шаги, меняющие цену, обычным цветом; остальные приглушены
            <div key={s.label} className={i === 0 || s.changes ? undefined : styles.howQuiet}>
              <dt>{s.label}</dt>
              <dd>{s.text}</dd>
            </div>
          ))}
        </dl>
        {total && <p className={styles.howTotal}>= {total} за единицу</p>}
        {entry.original && (
          <ul className={styles.fixes} aria-label="Исправлено вами">
            {Object.entries(entry.original).map(([field, was]) => (
              <li key={field}>
                Исправлено вами: {field}, было «{was}»
              </li>
            ))}
          </ul>
        )}
      </div>
      <Match comparison={entry.comparison} />
    </div>
  )
}

function OfferRow({ entry, excluded, reason }: { entry: OfferEntry; excluded: boolean; reason?: string }) {
  const [open, setOpen] = useState(false)
  const title = captionTitle(entry)
  const price = excluded ? (entry.normalized_price ?? entry.base_price ?? entry.offer.price) : entry.normalized_price
  const perPage = excluded && entry.normalized_price === null && entry.base_price === null
  // Вся строка раскрывает подробности; ссылка на источник и кнопка работают как обычно.
  const onRow = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('a, button')) return
    if (window.getSelection?.()?.toString()) return
    setOpen(!open)
  }
  return (
    <li className={`${styles.orow} ${open ? styles.orowOpen : ''}`} onClick={onRow}>
      <span className={styles.olabel}>{entry.label}</span>
      <span className={styles.osrc}>
        <Source entry={entry} title={title} />
        {reason && <span className={styles.reason}>{reason}</span>}
        <Meta entry={entry} />
      </span>
      <span className={styles.oprice}>
        <span className={excluded ? styles.struck : undefined}>{formatMoney(price)}</span>
        {perPage && (
          <span className={styles.perPage}>
            за {formatNumber(entry.offer.amount)} {entry.offer.amount_unit}
          </span>
        )}
      </span>
      <button
        type="button"
        className={styles.chev}
        aria-expanded={open}
        aria-label={`Как получена цена, строка ${entry.label}`}
        onClick={() => setOpen(!open)}
      >
        <Icon name="chev" />
      </button>
      {open && <Details entry={entry} />}
    </li>
  )
}

export function IncludedTable({ position }: { position: PositionReport }) {
  if (position.included.length === 0) {
    return <p className={styles.empty}>В расчёт не вошло ни одного предложения.</p>
  }
  return (
    <ul className={styles.olist} aria-label="В расчёте">
      {position.included.map((e) => (
        <OfferRow key={e.offer.id} entry={e} excluded={false} />
      ))}
    </ul>
  )
}

export function ExcludedTable({ position }: { position: PositionReport }) {
  if (position.excluded.length === 0) {
    return <p className={styles.empty}>Исключённых предложений нет.</p>
  }
  return (
    <ul className={styles.olist} aria-label="Исключены">
      {position.excluded.map((e) => (
        <OfferRow key={e.offer.id} entry={e} excluded reason={exclusionText(e, position.stats)} />
      ))}
    </ul>
  )
}
