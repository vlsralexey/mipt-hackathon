import { useRef, useState } from 'react'
import type { PositionReport, Report } from '../api/types'
import { Icon } from '../components/Icon'
import { formatAmount, formatDay, formatMoney, formatQuantity } from '../format'
import { plural } from '../plural'
import { ExcludedTable, IncludedTable } from './OfferTables'
import { EditsList, Methodology, More, QuestionsList, SourcesList, SubjectList } from './MoreSections'
import { calcSteps, noCalcText, positionLabels, priceNote, weakReason, type PositionLabel } from './position-text'
import { Ruler } from './Ruler'
import { groupWarnings, joinRu, type WarningLine, type WarningPage } from './warnings'
import styles from './report.module.css'

interface ReportViewProps {
  report: Report
  /** Правки можно отменять только в последней версии: отмена создаёт новую. */
  isLatest: boolean
}

const isWeak = (p: PositionReport) => p.status !== 'ok' || p.excluded_by_user

/** «без позиции 3: нет цен», «без позиций 2 и 3: нет цен», «без позиций 2 (мало цен) и 3 (нет цен)». */
function withoutText(weak: PositionReport[]): string {
  const reasons = weak.map((p) => weakReason(p) ?? '')
  if (weak.length === 1) return `без позиции ${weak[0].position.index}: ${reasons[0]}`
  if (reasons.every((r) => r === reasons[0])) {
    return `без позиций ${joinRu(weak.map((p) => String(p.position.index)))}: ${reasons[0]}`
  }
  return `без позиций ${joinRu(weak.map((p, i) => `${p.position.index} (${reasons[i]})`))}`
}

const CHECK = <path d="M5 12.5l4.5 4.5L19 7.5" />
const ALERT = (
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v5M12 16.5v.5" />
  </>
)

function StatusIcon({ weak }: { weak: boolean }) {
  return (
    <svg className={`${styles.statusIco} ${weak ? styles.wait : styles.ok}`} viewBox="0 0 24 24" role="img" aria-label={weak ? 'не обоснована' : 'обоснована'}>
      {weak ? ALERT : CHECK}
    </svg>
  )
}

/** Итог и таблица позиций (docs/api.md §5.4: деньги не считаем, только показываем). */
function Total({ report, labels, onOpen }: { report: Report; labels: Map<number, PositionLabel>; onOpen: (index: number) => void }) {
  const weak = report.positions.filter(isWeak)
  const value = report.total ?? report.total_justified
  return (
    <section className={styles.total} aria-label="Итог">
      <p className={styles.totalLabel}>{value !== null ? 'НМЦК закупки' : 'НМЦК не определена'}</p>
      <div className={styles.totalLine}>
        {value !== null && (
          <span className={styles.totalValue}>
            {formatAmount(value)}
            <span className={styles.cur}>₽</span>
          </span>
        )}
        {weak.length > 0 && (
          <span className={styles.badge}>{value !== null ? withoutText(weak) : 'ни одна позиция не обоснована'}</span>
        )}
      </div>

      <div className={styles.ptable} role="table" aria-label="Позиции">
        <div className={`${styles.prow} ${styles.phead}`} role="row">
          <span role="columnheader" aria-label="Номер" />
          <span role="columnheader">Позиция</span>
          <span role="columnheader" className={styles.pprice}>Цена за ед.</span>
          <span role="columnheader" className={styles.psum}>Сумма</span>
          <span role="columnheader" aria-label="Статус" />
        </div>
        {report.positions.map((p) => {
          const weakP = isWeak(p)
          const price = p.unit_price ?? p.reference_price
          const note = priceNote(p)
          return (
            <div key={p.position.index} className={styles.prow} role="row">
              <span role="cell" className={styles.pnum}>
                {p.position.index}
              </span>
              <span role="cell" className={styles.pname}>
                <button type="button" className={`${styles.linkBtn} ${styles.pnameBtn}`} title={p.position.name} aria-label={p.position.name} onClick={() => onOpen(p.position.index)}>
                  {labels.get(p.position.index)?.row ?? p.position.name}
                </button>
                <span className={styles.pqty}>
                  {formatQuantity(p.position.quantity, p.position.unit)}
                </span>
              </span>
              <span role="cell" className={styles.pprice}>
                {price !== null && <span className={weakP ? styles.muted : undefined}>{formatMoney(price)}</span>}
                {note && <span className={styles.pnote}>{note}</span>}
              </span>
              <span role="cell" className={styles.psum}>
                {!weakP && p.total !== null ? <b>{formatMoney(p.total)}</b> : <span className={styles.muted}>не входит</span>}
              </span>
              <span role="cell" className={styles.pst}>
                <StatusIcon weak={weakP} />
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function WarningItem({ line }: { line: WarningLine }) {
  const [open, setOpen] = useState(false)
  if (!line.sources) return <li>{line.text}</li>
  return (
    <li>
      {line.text}{' '}
      <button type="button" className={styles.warnToggle} aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Скрыть' : 'Какие'}
      </button>
      {open && (
        <div className={styles.warnPages}>
          {line.sources.map((s) => (
            <div key={s.name}>
              <b>{s.name}</b>
              <ul>
                {byReason(s.pages).map(([reason, pages]) => (
                  <li key={reason}>
                    <span>{reason}</span>
                    <span className={styles.warnLinks}>
                      {pages.map((p) => (
                        <a key={p.url} href={p.url} target="_blank" rel="noopener noreferrer">
                          {shortUrl(p.url)}
                        </a>
                      ))}
                    </span>
                  </li>
                ))}
                {s.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </li>
  )
}

/** Страницы источника по причинам: причина один раз, под ней ссылки. */
function byReason(pages: WarningPage[]): [string, WarningPage[]][] {
  const map = new Map<string, WarningPage[]>()
  for (const p of pages) map.set(p.reason, [...(map.get(p.reason) ?? []), p])
  return [...map.entries()]
}

/** «https://zakupki.gov.ru/epz/contract/...?reestrNumber=123» → «zakupki.gov.ru/…123». */
function shortUrl(url: string): string {
  try {
    const u = new URL(url)
    const tail = (u.search.match(/=([^=&]+)$/)?.[1] ?? u.pathname.split('/').filter(Boolean).at(-1) ?? '').slice(-24)
    return tail ? `${u.hostname}/…${tail}` : u.hostname
  } catch {
    return url
  }
}

function Warnings({ report }: { report: Report }) {
  const lines = groupWarnings(report)
  if (lines.length === 0) return null
  return (
    <section className={styles.warning} role="note" aria-label="Проверьте перед согласованием">
      <h3 className={styles.warnHead}>
        <Icon name="alert" />
        Проверьте перед согласованием
      </h3>
      <ul>
        {lines.map((l) => (
          <WarningItem key={l.text} line={l} />
        ))}
      </ul>
    </section>
  )
}

function Steps({ position: p, rules }: { position: PositionReport; rules: Report['rules'] }) {
  const steps = calcSteps(p, rules)
  if (steps.length === 0) return <p className={styles.noCalc}>{noCalcText(p)}</p>
  return (
    <dl className={styles.steps} aria-label="Расчёт">
      {steps.map((s) => (
        <div key={s.label} className={styles.step}>
          <dt>{s.label}</dt>
          <dd>
            {s.formula}
            {s.result && (
              <>
                {' = '}
                <b>{s.result}</b>
              </>
            )}
            {s.note && <span className={styles.stepNote}>, {s.note}</span>}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function PositionDetail({ position: p, rules }: { position: PositionReport; rules: Report['rules'] }) {
  const weak = isWeak(p)
  return (
    <>
      <div className={styles.posHead}>
        <h3>{p.position.name}</h3>
        <span className={weak ? styles.posSumWeak : styles.posSum}>
          {!weak && p.total !== null ? formatMoney(p.total) : (weakReason(p) ?? '')}
        </span>
      </div>
      <Ruler position={p} />
      <Steps position={p} rules={rules} />
      {p.excluded_by_user && <p className={styles.posNote}>Исключена из итога по вашей просьбе</p>}
      {/* Допущения (assumptions) в позиции не выводим: ответы по умолчанию видны в «Уточнениях». */}
      {p.spread_hints.length > 0 && (
        <ul className={styles.notes}>
          {p.spread_hints.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <div className={styles.offers}>
        <h4>
          В расчёте <span className={styles.cnt}>{p.included.length}</span>
        </h4>
        <IncludedTable position={p} />
      </div>
      <div className={styles.offers}>
        <h4>
          Исключены <span className={styles.cnt}>{p.excluded.length}</span>
        </h4>
        <ExcludedTable position={p} />
      </div>
    </>
  )
}

const failedPages = (report: Report) => {
  const lines = groupWarnings(report).filter((l) => l.sources)
  return lines.reduce((n, l) => n + (l.sources ?? []).reduce((m, s) => m + s.pages.length, 0), 0)
}

export function ReportView({ report, isLatest }: ReportViewProps) {
  const [selected, setSelected] = useState(report.positions[0]?.position.index ?? 0)
  const detail = useRef<HTMLElement>(null)
  const position = report.positions.find((p) => p.position.index === selected) ?? report.positions[0]
  const labels = positionLabels(report.positions.map((p) => p.position))
  const activeEdits = report.edits.filter((e) => e.edit.status === 'active').length
  const sourceCount = new Set(report.sources.map((s) => s.source_id)).size
  const failed = failedPages(report)

  function open(index: number) {
    setSelected(index)
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    requestAnimationFrame(() => detail.current?.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'start' }))
  }

  return (
    <article className={styles.report} aria-label="Отчёт">
      <header className={styles.header}>
        <h2 className={styles.title}>{report.title}</h2>
        <p className={styles.meta}>
          Версия {report.version} · {formatDay(report.created_at)} · метод сопоставимых рыночных цен
        </p>
      </header>

      <Total report={report} labels={labels} onOpen={open} />
      <Warnings report={report} />

      {position && (
        <section ref={detail} className={styles.detail} aria-label={`Позиция ${position.position.index}`}>
          {report.positions.length > 1 && (
            <div className={styles.segs} role="group" aria-label="Позиция">
              {report.positions.map((p) => (
                <button
                  key={p.position.index}
                  type="button"
                  className={styles.seg}
                  aria-pressed={p.position.index === position.position.index}
                  title={p.position.name}
                  aria-label={`${p.position.index}. ${p.position.name.trim() || `Позиция ${p.position.index}`}${isWeak(p) ? ', не обоснована' : ''}`}
                  onClick={() => setSelected(p.position.index)}
                >
                  <span className={styles.segNum} aria-hidden="true">
                    {p.position.index}
                  </span>
                  <span className={styles.segText}>{labels.get(p.position.index)?.tab}</span>
                  {isWeak(p) && <span className={styles.segDot} aria-label="не обоснована" role="img" />}
                </button>
              ))}
            </div>
          )}
          <PositionDetail key={position.position.index} position={position} rules={report.rules} />
        </section>
      )}

      <div className={styles.moreGroup}>
        <More
          title="Где искали"
          count={`${sourceCount} ${plural(sourceCount, 'источник', 'источника', 'источников')}${failed > 0 ? `, ${failed} ${plural(failed, 'страница не открылась', 'страницы не открылись', 'страниц не открылись')}` : ''}`}
        >
          <SourcesList sources={report.sources} />
        </More>
        {report.questions.length > 0 && (
          <More title="Уточнения" count={String(report.questions.length)}>
            <QuestionsList questions={report.questions} />
          </More>
        )}
        {report.edits.length > 0 && (
          <More title="Правки" count={`${activeEdits} из ${report.edits.length}`}>
            <EditsList edits={report.edits} procurementId={report.procurement_id} canCancel={isLatest} />
          </More>
        )}
        <More title="Предмет закупки" count={`${report.positions.length} ${plural(report.positions.length, 'позиция', 'позиции', 'позиций')}`}>
          <SubjectList report={report} />
        </More>
        <More title="Методика">
          <Methodology report={report} />
        </More>
      </div>
    </article>
  )
}
