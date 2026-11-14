import { useState } from 'react'
import type { PositionReport, Report } from '../api/types'
import { Icon } from '../components/Icon'
import { formatAmount, formatLongDate, formatMoney, formatPercent, formatQuantity } from '../format'
import { plural } from '../plural'
import { ExcludedTable, IncludedTable } from './OfferTables'
import { EditsList, Methodology, More, QuestionsList, SourcesList, SubjectList } from './MoreSections'
import { Ruler } from './Ruler'
import styles from './report.module.css'

interface ReportViewProps {
  report: Report
  /** Правки можно отменять только в последней версии: отмена создаёт новую. */
  isLatest: boolean
}

/** Заголовок итога и пояснение, почему итог именно такой (docs/api.md §5.4: деньги не считаем). */
function Total({ report }: { report: Report }) {
  const weak = report.positions.filter((p) => p.status !== 'ok')
  let label = 'НМЦК'
  let value: string | null = report.total
  if (value === null) {
    label = report.total_justified !== null ? 'НМЦК по обоснованным позициям' : 'НМЦК не определена'
    value = report.total_justified
  }

  let note: string | null = null
  if (weak.length === 1) {
    const [p] = weak
    const price = p.reference_price !== null ? `её цена ${formatMoney(p.reference_price)} приведена справочно и в итог не входит` : 'цены для неё пока нет'
    note = `Позиция ${p.position.index} пока не обоснована: ${price}.`
  } else if (weak.length > 1) {
    note = `Позиции ${weak.map((p) => p.position.index).join(', ')} пока не обоснованы: их цены приведены справочно и в итог не входят.`
  }

  return (
    <div className={styles.total}>
      <div className={styles.totalLabel}>{label}</div>
      {value !== null && (
        <div className={styles.totalValue}>
          {formatAmount(value)}
          <span className={styles.cur}>₽</span>
        </div>
      )}
      {note && <p className={styles.totalNote}>{note}</p>}
    </div>
  )
}

function Warnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null
  return (
    <div className={styles.warning} role="note">
      <Icon name="alert" />
      {warnings.length === 1 ? (
        <p>{warnings[0]}</p>
      ) : (
        <ul>
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function statsLine(p: PositionReport): string | null {
  const { stats } = p
  if (!stats) return null
  // Правило выбросов длинное и одинаковое у всех позиций: оно в разделе «Методика».
  const parts = [`${stats.n} ${plural(stats.n, 'цена', 'цены', 'цен')}`]
  if (p.excluded.length > 0) parts.push(`исключено ${p.excluded.length}`)
  parts.push(`разброс ${formatPercent(stats.cv)}`)
  return parts.join(' · ')
}

function PositionCalc({ position: p }: { position: PositionReport }) {
  const ok = p.status === 'ok'
  const price = p.unit_price ?? p.reference_price
  const qty = formatQuantity(p.position.quantity, p.position.unit)
  const stats = statsLine(p)
  return (
    <div className={`${styles.pos} ${ok ? '' : styles.weak}`}>
      <div className={styles.posHead}>
        <span>
          <span className={styles.posName}>
            {p.position.index}. {p.position.name}
          </span>
          <span className={styles.posQty}>{price !== null ? `${formatMoney(price)} × ${qty}` : qty}</span>
        </span>
        <span className={styles.posSum}>
          {ok && formatMoney(p.total)}
          <small>{ok ? 'обоснована' : price !== null ? 'справочно' : 'нет цен'}</small>
        </span>
      </div>
      <Ruler position={p} />
      {stats && <p className={styles.posStats}>{stats}</p>}
      {p.excluded_by_user && <p className={styles.posStats}>Исключена из итога по вашей просьбе</p>}
      {/* Допущения (assumptions) в позиции не выводим: ответы по умолчанию видны в «Уточнениях». */}
      {p.spread_hints.length > 0 && (
        <ul className={styles.notes}>
          {p.spread_hints.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function ReportView({ report, isLatest }: ReportViewProps) {
  const [selected, setSelected] = useState(report.positions[0]?.position.index ?? 0)
  const position = report.positions.find((p) => p.position.index === selected) ?? report.positions[0]
  const activeEdits = report.edits.filter((e) => e.edit.status === 'active').length

  return (
    <article className={styles.report} aria-label="Отчёт">
      <h2 className={styles.title}>{report.title}</h2>
      <p className={styles.meta}>
        Метод сопоставимых рыночных цен · версия {report.version}, {formatLongDate(report.created_at)}
        {/* у первого прогона причина «Первый прогон» ничего не добавляет */}
        {report.version > 1 && ` · ${report.cause}`}
      </p>

      <Total report={report} />
      <Warnings warnings={report.warnings} />

      <section className={styles.section}>
        <h2>Расчёт по позициям</h2>
        {report.positions.map((p) => (
          <PositionCalc key={p.position.index} position={p} />
        ))}
      </section>

      {position && (
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2>Включённые предложения</h2>
            {report.positions.length > 1 && (
              <div className={styles.filter} role="group" aria-label="Позиция">
                {report.positions.map((p) => (
                  <button
                    key={p.position.index}
                    type="button"
                    className={styles.chip}
                    aria-pressed={p.position.index === position.position.index}
                    onClick={() => setSelected(p.position.index)}
                  >
                    Позиция {p.position.index}
                  </button>
                ))}
              </div>
            )}
          </div>
          <IncludedTable position={position} />
        </section>
      )}

      <div className={styles.moreGroup}>
        {position && (
          <More
            title={`Исключённые предложения, позиция ${position.position.index}`}
            count={String(position.excluded.length)}
          >
            <ExcludedTable position={position} />
          </More>
        )}
        {report.edits.length > 0 && (
          <More title="Правки пользователя" count={`${activeEdits} из ${report.edits.length}`}>
            <EditsList edits={report.edits} procurementId={report.procurement_id} canCancel={isLatest} />
          </More>
        )}
        {report.questions.length > 0 && (
          <More title="Уточнения" count={String(report.questions.length)}>
            <QuestionsList questions={report.questions} />
          </More>
        )}
        <More title="Где искали" count={`${new Set(report.sources.map((s) => s.source_id)).size} ${plural(new Set(report.sources.map((s) => s.source_id)).size, 'источник', 'источника', 'источников')}`}>
          <SourcesList sources={report.sources} />
        </More>
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
