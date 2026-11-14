import type { ReactNode } from 'react'
import { plural } from '../plural'

/** Значение правила: из общих настроек (`GET /api/config`) или из настроек закупки. */
export interface RuleValue {
  key: string
  title: string
  display: string
  description?: string
  value?: unknown
}

export interface RuleRow {
  id: string
  label: string
  /** Ключи правил, из которых собрана строка. */
  keys: string[]
  content: ReactNode
  /** Технические параметры: показываются приглушённо, со списком «все». */
  technical?: boolean
}

/** Формулировка методики: текст для отчёта, а не правило расчёта. */
const HIDDEN = new Set(['methodology_note'])
const TECHNICAL = ['max_pages_per_source', 'page_text_limit', 'spread_hint_min_gap', 'marketplace_hosts']

/** «1.5» → «1,5», «15000» → «15 000». Прочие значения (проценты, списки) не трогаем. */
export function formatValue(display: string): string {
  const text = display.trim()
  if (!/^-?\d+([.,]\d+)?$/.test(text)) return display
  return Number(text.replace(',', '.')).toLocaleString('ru-RU', { maximumFractionDigits: 6 })
}

function isOn(rule: RuleValue): boolean {
  if (typeof rule.value === 'boolean') return rule.value
  return rule.display.trim().toLocaleLowerCase() === 'да'
}

function count(rule: RuleValue): number {
  const n = typeof rule.value === 'number' ? rule.value : Number(rule.display.replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) ? Math.abs(Math.trunc(n)) : 0
}

type Pick = (key: string) => RuleValue

interface Group {
  id: string
  label: string
  keys: string[]
  phrase: (v: (key: string) => ReactNode, rule: Pick) => ReactNode
}

// После «не меньше», «от», «старше» нужен родительный падеж: 1 цены, 2 цен, 5 цен.
const prices = (n: number) => plural(n, 'цены', 'цен', 'цен')

const GROUPS: Group[] = [
  {
    id: 'sample', label: 'Выборка', keys: ['min_prices', 'cv_threshold'],
    phrase: (v, r) => <>Не меньше {v('min_prices')} {prices(count(r('min_prices')))}, разброс не выше {v('cv_threshold')}</>,
  },
  {
    id: 'outliers', label: 'Выбросы', keys: ['iqr_min_n', 'iqr_k', 'median_max_deviation'],
    phrase: (v, r) => <>От {v('iqr_min_n')} {prices(count(r('iqr_min_n')))}: IQR × {v('iqr_k')}. Меньше: отклонение от медианы до {v('median_max_deviation')}</>,
  },
  { id: 'vat', label: 'НДС', keys: ['vat_rate'], phrase: (v) => v('vat_rate') },
  {
    id: 'indexation', label: 'Индексация', keys: ['indexation_enabled', 'index_after_months'],
    phrase: (v, r) => isOn(r('indexation_enabled'))
      ? <>По ИПЦ для цен старше {v('index_after_months')} {plural(count(r('index_after_months')), 'месяца', 'месяцев', 'месяцев')}</>
      : 'Выключена',
  },
  {
    id: 'eis', label: 'Глубина ЕИС', keys: ['eis_years'],
    phrase: (v, r) => <>{v('eis_years')} {plural(count(r('eis_years')), 'год', 'года', 'лет')}</>,
  },
  {
    id: 'shops', label: 'Магазины', keys: ['level2_trigger_min_prices', 'level2_on_heterogeneous'],
    phrase: (v, r) => <>Если цен меньше {v('level2_trigger_min_prices')}{isOn(r('level2_on_heterogeneous')) ? ' или они неоднородны' : ''}</>,
  },
]

function value(rule: RuleValue): ReactNode {
  return <b title={rule.description ? `${rule.title}. ${rule.description}` : rule.title}>{formatValue(rule.display)}</b>
}

/**
 * Собирает правила в короткие фразы по группам, как в макете настроек.
 * Неизвестные ключи (новые правила бэкенда) не теряются: каждое идёт своей строкой.
 */
export function ruleRows(rules: RuleValue[]): RuleRow[] {
  const byKey = new Map(rules.map((rule) => [rule.key, rule]))
  const used = new Set<string>(HIDDEN)
  const rows: RuleRow[] = []
  const pick: Pick = (key) => byKey.get(key)!
  const v = (key: string) => value(pick(key))
  for (const group of GROUPS) {
    if (!group.keys.every((key) => byKey.has(key))) continue
    group.keys.forEach((key) => used.add(key))
    rows.push({ id: group.id, label: group.label, keys: group.keys, content: group.phrase(v, pick) })
  }
  for (const rule of rules) {
    if (used.has(rule.key) || TECHNICAL.includes(rule.key)) continue
    used.add(rule.key)
    rows.push({ id: rule.key, label: rule.title, keys: [rule.key], content: value(rule) })
  }
  const technical = TECHNICAL.filter((key) => byKey.has(key))
  if (technical.length > 0) {
    const pages = byKey.get('max_pages_per_source')
    const limit = byKey.get('page_text_limit')
    const parts = [
      pages && `${formatValue(pages.display)} ${plural(count(pages), 'страница', 'страницы', 'страниц')} на источник`,
      limit && `${formatValue(limit.display)} ${plural(count(limit), 'символ', 'символа', 'символов')} со страницы`,
    ].filter(Boolean)
    rows.push({ id: 'technical', label: 'Технические', keys: technical, technical: true, content: parts.join(', ') })
  }
  return rows
}

/** Технические параметры списком «название: значение» для раскрытия «все». */
export function technicalRules(rules: RuleValue[]): RuleValue[] {
  return TECHNICAL.map((key) => rules.find((rule) => rule.key === key)).filter((rule): rule is RuleValue => Boolean(rule))
}

/** «ЕИС — реестр контрактов» → ['ЕИС', 'Реестр контрактов']: короткое имя и пояснение. */
export function splitSourceName(name: string): [string, string | null] {
  const match = /\s[—–-]\s/.exec(name)
  if (!match) return [name, null]
  const rest = name.slice(match.index + match[0].length).trim()
  return [name.slice(0, match.index).trim(), rest ? rest[0].toLocaleUpperCase() + rest.slice(1) : null]
}
