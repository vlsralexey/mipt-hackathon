import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { api } from '../api/client'
import type { AppliedEdit, Characteristic, Position, Question, Report, SourceRun } from '../api/types'
import { groupSteps } from '../chat/steps'
import { procurementKey } from '../chat/useProcurementEvents'
import { Icon, type IconName } from '../components/Icon'
import { formatIsoDate, tidyText } from '../format'
import { stepStatusLabel } from '../labels'
import styles from './report.module.css'

/** Свёрнутый второстепенный раздел со счётчиком. */
export function More({ title, count, children }: { title: string; count?: string; children: ReactNode }) {
  return (
    <details className={styles.more}>
      <summary>
        {title}
        {count && <span className={styles.cnt}>{count}</span>}
        <Icon name="chev" className={styles.moreChev} />
      </summary>
      <div className={styles.body}>{children}</div>
    </details>
  )
}

const marks: Record<string, { icon: IconName; tone: string }> = {
  ok: { icon: 'check', tone: styles.ok },
  empty: { icon: 'dash', tone: styles.dim },
  skipped: { icon: 'dash', tone: styles.dim },
  error: { icon: 'x', tone: styles.err },
  unavailable: { icon: 'x', tone: styles.err },
  needs_login: { icon: 'alert', tone: styles.wait },
}

export function SourcesList({ sources }: { sources: SourceRun[] }) {
  const rows = groupSteps(
    sources.map((s) => ({
      source_id: s.source_id,
      name: s.name,
      level: s.level,
      position_index: s.position_index,
      status: s.status,
      found: s.found,
      relevant: null,
      note: s.error,
    })),
  )
  return (
    <ul className={styles.sources}>
      {rows.map((r) => {
        const mark = marks[r.status] ?? marks.empty
        return (
          <li key={r.source_id}>
            <Icon name={mark.icon} className={`${styles.ico} ${mark.tone}`} />
            <span>
              {tidyText(r.name)} <span className={styles.lvl}>уровень {r.level}</span>
            </span>
            <span className={styles.res}>
              {r.status === 'ok' ? `найдено ${r.found}` : (r.note ? tidyText(r.note) : stepStatusLabel[r.status])}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/** Уточнения: на что ответил пользователь, а что принято по умолчанию (принцип «без блокировок»). */
export function QuestionsList({ questions }: { questions: Question[] }) {
  return (
    <ul className={styles.edits}>
      {questions.map((q) => (
        <li key={q.id}>
          <b>{q.text}</b>
          <br />
          {q.answer !== null ? q.answer : <>{q.default_answer} <span className={styles.muted}>(принято по умолчанию)</span></>}
        </li>
      ))}
    </ul>
  )
}

const editStatus = { active: 'действует', cancelled: 'отменена', superseded: 'вытеснена более поздней' } as const

export function EditsList({ edits, procurementId, canCancel }: { edits: AppliedEdit[]; procurementId: string; canCancel: boolean }) {
  const queryClient = useQueryClient()
  const cancel = useMutation({
    mutationFn: (editId: string) => api.cancelEdits(procurementId, [editId]),
    // новую версию принесёт SSE; повторный запрос подстраховывает от потери события
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: procurementKey(procurementId) })
      void queryClient.invalidateQueries({ queryKey: ['reports', procurementId] })
    },
  })
  return (
    <>
      <ul className={styles.edits}>
        {edits.map(({ edit, applied, effect }) => (
          <li key={edit.id} className={`${styles.edit} ${edit.status !== 'active' ? styles.editCancelled : ''}`}>
            <span className={styles.editSummary}>
              {edit.summary}
              {edit.reason && <span className={styles.muted}> · {edit.reason}</span>}
            </span>
            {canCancel && edit.status === 'active' ? (
              <button type="button" className={styles.btn} disabled={cancel.isPending} onClick={() => cancel.mutate(edit.id)}>
                Отменить
              </button>
            ) : (
              <span className={styles.lvl}>{editStatus[edit.status]}</span>
            )}
            <span className={`${styles.editEffect} ${applied ? '' : styles.editEffectWarn}`}>{effect}</span>
          </li>
        ))}
      </ul>
      {cancel.isError && (
        <p className={styles.error} role="alert">
          {cancel.error.message}
        </p>
      )}
    </>
  )
}

const characteristic = (c: Characteristic) => `${c.name} ${c.value}${c.unit ? ` ${c.unit}` : ''}`

function Subject({ position: p }: { position: Position }) {
  const essential = p.characteristics.filter((c) => c.essential)
  const other = p.characteristics.filter((c) => !c.essential)
  return (
    <p>
      <b>
        {p.index}. {p.name}
      </b>
      {p.okpd2 && `, ОКПД2 ${p.okpd2}`}.
      {essential.length > 0 && <> Существенные: {essential.map(characteristic).join(', ')}.</>}
      {other.length > 0 && <> Остальные: {other.map(characteristic).join(', ')}.</>}
    </p>
  )
}

export function SubjectList({ report }: { report: Report }) {
  return (
    <div className={styles.muted}>
      {report.positions.map((p) => (
        <Subject key={p.position.index} position={p.position} />
      ))}
      {report.delivery_terms && (
        <p>
          <b>Условия поставки.</b> {report.delivery_terms}
          {report.delivery_extras.length > 0 && <>. Дополнительно: {report.delivery_extras.join(', ')}.</>}
        </p>
      )}
    </div>
  )
}

export function Methodology({ report }: { report: Report }) {
  // правило выбросов обычно одно на все позиции: тогда пишем его один раз
  const rules = report.positions.flatMap((p) => (p.stats ? [{ index: p.position.index, rule: p.stats.outlier_rule }] : []))
  const same = rules.length > 0 && rules.every((r) => r.rule === rules[0].rule)
  return (
    <div className={styles.muted}>
      <p>{tidyText(report.methodology)}</p>
      {same && <p>Выбросы: {tidyText(rules[0].rule)}.</p>}
      {!same &&
        rules.map((r) => (
          <p key={r.index}>
            Выбросы, позиция {r.index}: {tidyText(r.rule)}.
          </p>
        ))}
      <p>Цены приведены на {formatIsoDate(report.calc_date)}.</p>
    </div>
  )
}
