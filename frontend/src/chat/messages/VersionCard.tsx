import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import type { Change, VersionCard as VersionCardData } from '../../api/types'
import { formatMoney, NONE } from '../../format'
import { positionStatusLabel } from '../../labels'
import { useChat } from '../context'
import { procurementKey } from '../useProcurementEvents'
import styles from './cards.module.css'

/** «было → стало»; одинаковые и пустые «было» показываются одним значением. */
function shown<T>(change: Change<T>, format: (v: T | null) => string): string {
  const { before, after } = change
  if (before === null || before === after) return format(after)
  return `${format(before)} → ${format(after)}`
}
const empty = <T,>(change: Change<T>) => change.before === null && change.after === null
const plain = (v: unknown) => (v === null ? NONE : String(v))
const statusText = (v: keyof typeof positionStatusLabel | null) => (v === null ? NONE : positionStatusLabel[v])

/** Новая версия отчёта. Разницу считает бэкенд, фронтенд её только показывает. */
export function VersionCard({ data }: { data: VersionCardData }) {
  const { procurementId, openVersion } = useChat()
  const queryClient = useQueryClient()
  const cancel = useMutation({
    mutationFn: () => api.cancelEdits(procurementId, data.edit_ids),
    onSettled: () => queryClient.invalidateQueries({ queryKey: procurementKey(procurementId) }),
  })
  const { diff } = data

  return (
    <div className={styles.version}>
      <div className={styles.versionHead}>
        <div className={styles.versionTitle}>
          <b>Версия {data.version}</b>
          {diff.from_version !== null && <span className={styles.versionCause}>{data.cause}</span>}
        </div>
        <button type="button" className={`${styles.btn} ${styles.ghost}`} onClick={() => openVersion(data.version)}>
          Открыть
        </button>
        {data.cancellable && (
          <button
            type="button"
            className={`${styles.btn} ${styles.ghost}`}
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            Отменить
          </button>
        )}
      </div>

      <ul className={styles.lines}>
        {!empty(diff.total) && (
          <li>
            <span className={styles.label}>НМЦК</span>
            <span>{shown(diff.total, formatMoney)}</span>
          </li>
        )}
        {!empty(diff.total_justified) && (
          <li>
            <span className={styles.label}>НМЦК по обоснованным позициям</span>
            <span>{shown(diff.total_justified, formatMoney)}</span>
          </li>
        )}
        {diff.positions.map((p) => (
          <li key={p.index}>
            <span className={styles.label}>
              Позиция {p.index}. {p.name}
            </span>
            <span>
              {[
                shown(p.status, statusText),
                !empty(p.unit_price) && `${shown(p.unit_price, formatMoney)} за единицу`,
                !empty(p.n) && `цен: ${shown(p.n, plain)}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </li>
        ))}
        {diff.offers_moved.map((o) => (
          <li key={o.offer_id}>
            <span className={styles.moved}>
              {o.to === 'excluded' ? 'Исключено' : 'Возвращено'}: {o.label} {o.caption}
            </span>
            <span className={styles.reason}>{o.reason}</span>
          </li>
        ))}
        {diff.rules_changed.map((r) => (
          <li key={r.key}>
            <span className={styles.label}>{r.title}</span>
            <span>
              {r.before} → {r.after}
            </span>
          </li>
        ))}
      </ul>

      {cancel.isError && (
        <p className={styles.error} role="alert">
          {cancel.error.message}
        </p>
      )}
    </div>
  )
}
