import type { VersionDiff } from '../api/types'
import { formatMoney } from '../format'
import styles from './report.module.css'

export function DiffSummary({ diff, showVersion = true }: { diff: VersionDiff; showVersion?: boolean }) {
  return <div className={styles.diffSummary}>
    {showVersion && <p>Версия {diff.from_version ?? 'без отчёта'} → {diff.to_version}</p>}
    {diff.total.before !== diff.total.after && <p>НМЦК: {formatMoney(diff.total.before)} → {formatMoney(diff.total.after)}</p>}
    {diff.total_justified.before !== diff.total_justified.after && <p>Обоснованная часть: {formatMoney(diff.total_justified.before)} → {formatMoney(diff.total_justified.after)}</p>}
    {diff.positions.map((p) => <p key={p.index}>Позиция {p.index}. {p.name}: {formatMoney(p.unit_price.before)} → {formatMoney(p.unit_price.after)} за единицу; цен {p.n.before ?? 0} → {p.n.after ?? 0}</p>)}
    {diff.offers_moved.map((o) => <p key={`${o.position_index}-${o.offer_id}`}>{o.label}. {o.to === 'excluded' ? 'Исключено' : 'Включено'}: {o.caption}. {o.reason}</p>)}
    {diff.rules_changed.map((r) => <p key={r.key}>{r.title}: {r.before} → {r.after}</p>)}
    {diff.edits_cancelled.length > 0 && <p>Отменено правок: {diff.edits_cancelled.length}</p>}
    {diff.positions.length === 0 && diff.offers_moved.length === 0 && diff.rules_changed.length === 0 && diff.total.before === diff.total.after && diff.total_justified.before === diff.total_justified.after && <p>Итоговые числа не изменились.</p>}
  </div>
}
