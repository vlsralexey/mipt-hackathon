import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api/client'
import type { Config } from '../api/types'
import { Problem, Row, RowsSkeleton } from './SettingsParts'
import { formatValue, ruleRows, splitSourceName, technicalRules, type RuleValue } from './rules'
import styles from './SettingsPanels.module.css'

const useConfig = () => useQuery({ queryKey: ['config'], queryFn: api.getConfig })

/** Общие правила расчёта короткими фразами. Меняются только через агента настроек. */
export function RulesSection() {
  const config = useConfig()
  return (
    <section className={styles.section} aria-labelledby="rules-heading">
      <h2 id="rules-heading">Правила расчёта</h2>
      <p className={styles.lead}>Для новых закупок. Меняются через агента.</p>
      {config.isPending ? <RowsSkeleton rows={5} label="Загрузка правил" />
        : config.isError ? <Problem message={config.error.message} retrying={config.isFetching} onRetry={() => void config.refetch()} />
          : <RuleList rules={config.data.rules} />}
    </section>
  )
}

export function RuleList({ rules }: { rules: RuleValue[] }) {
  const [all, setAll] = useState(false)
  return (
    <div className={styles.rows}>
      {ruleRows(rules).map((row) => row.technical ? (
        <Row key={row.id} label={row.label} muted>
          {row.content}{row.content ? ' ' : ''}
          <button type="button" className={styles.inlineLink} aria-expanded={all} aria-controls="technical-rules" onClick={() => setAll(!all)}>{all ? 'свернуть' : 'все'}</button>
          {all && (
            <dl id="technical-rules" className={styles.technical}>
              {technicalRules(rules).map((rule) => (
                <div key={rule.key}><dt title={rule.description}>{rule.title}</dt><dd>{formatValue(rule.display)}</dd></div>
              ))}
            </dl>
          )}
        </Row>
      ) : <Row key={row.id} label={row.label}>{row.content}</Row>)}
    </div>
  )
}

/** Источники поиска: имя, уровень каскада, сайты и состояние. */
export function SourcesSection() {
  const config = useConfig()
  return (
    <section className={styles.section} aria-labelledby="sources-heading">
      <h2 id="sources-heading">Источники</h2>
      {config.isPending ? <RowsSkeleton rows={3} label="Загрузка источников" />
        : config.isError ? <Problem message={config.error.message} retrying={config.isFetching} onRetry={() => void config.refetch()} />
          : <div className={styles.rows}>{config.data.sources.map((source) => <SourceRow key={source.id} source={source} />)}</div>}
    </section>
  )
}

function SourceRow({ source }: { source: Config['sources'][number] }) {
  const [name, about] = splitSourceName(source.name)
  const notes = [source.vat_note, source.delivery_note].filter(Boolean).join('\n')
  return (
    <Row label={<>{name}<span className={styles.level} title={source.level === 1 ? 'Уровень 1: ищем всегда' : 'Уровень 2: когда цен мало или они неоднородны'}><span className={styles.srOnly}>уровень </span>{source.level}</span></>}>
      <span title={notes || undefined}>{source.sites.length > 0 ? source.sites.join(', ') : about ?? 'Сайты из поиска'}</span>
      <span className={source.enabled ? styles.state : styles.stateOff}> · {source.enabled ? 'включён' : 'отключён'}</span>
    </Row>
  )
}
