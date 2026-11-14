import type { OfferEntry, PositionReport, Report, Stats } from '../api/types'
import { formatAmount, formatMoney, formatNumber, formatQuantity, formatShare, tidyText } from '../format'
import { exclusionLabel } from '../labels'
import { plural } from '../plural'
import { joinRu } from './warnings'

/**
 * Тексты детализации позиции: шаги расчёта, причины исключения, состояние позиции.
 * Все числа берутся из API как есть (docs/api.md §5.4); фронтенд их только форматирует.
 */

export interface CalcStep {
  label: string
  /** Формула с подставленными числами, до знака «=». */
  formula: string
  /** Результат после «=», выделяется. */
  result?: string
  /** Пояснение после результата. */
  note?: string
}

/** Больше стольких слагаемых формулу среднего сокращаем до «(сумма N цен) / N». */
export const MAX_TERMS = 8

/** Правило выбросов человеческим языком. */
export function humanRule(rule: string): string {
  const text = tidyText(rule)
  if (/^IQR/i.test(text) || /межквартил/i.test(text)) return 'IQR'
  const median = /медиан[а-я]* (?:более|больше)(?: чем на)? ([\d.,]+)\s?%/i.exec(text)
  if (median) return `отклонение от медианы больше ${formatNumber(median[1].replace(',', '.'))} %`
  return text.charAt(0).toLowerCase() + text.slice(1)
}

/** Цены в расчёте по возрастанию. */
const priced = (entries: OfferEntry[]) =>
  entries.flatMap((e) => (e.normalized_price === null ? [] : [e.normalized_price])).sort((a, b) => Number(a) - Number(b))

function meanStep(p: PositionReport, stats: Stats): CalcStep {
  const prices = priced(p.included)
  const n = stats.n
  const formula =
    prices.length === n && n <= MAX_TERMS
      ? n === 1
        ? `${formatAmount(prices[0])} / 1`
        : `(${prices.map(formatAmount).join(' + ')}) / ${n}`
      : `(сумма ${n} ${plural(n, 'цены', 'цен', 'цен')}) / ${n}`
  return { label: 'Средняя цена', formula, result: formatMoney(stats.mean) }
}

function spreadStep(p: PositionReport, stats: Stats, rules: Report['rules']): CalcStep {
  const threshold = typeof rules.cv_threshold === 'string' || typeof rules.cv_threshold === 'number' ? String(rules.cv_threshold) : null
  const heterogeneous = p.status === 'heterogeneous'
  const note =
    threshold === null
      ? heterogeneous
        ? 'цены неоднородны'
        : undefined
      : heterogeneous
        ? `больше ${formatShare(threshold)}: цены неоднородны`
        : `не больше ${formatShare(threshold)}: цены однородны`
  return {
    label: 'Разброс',
    formula: `${formatAmount(stats.std)} / ${formatAmount(stats.mean)}`,
    result: formatShare(stats.cv),
    note,
  }
}

function corridor(stats: Stats): string | null {
  if (stats.lower_bound === null || stats.upper_bound === null) return null
  return `от ${formatAmount(stats.lower_bound)} до ${formatMoney(stats.upper_bound)}`
}

function outliersStep(p: PositionReport, stats: Stats): CalcStep {
  const outliers = priced(p.excluded.filter((e) => e.exclusion === 'anomalous_price'))
  const range = corridor(stats)
  if (outliers.length === 0) {
    return { label: 'Выбросы', formula: range ? `нет, все цены в коридоре ${range}` : 'нет' }
  }
  const list = joinRu(outliers.map(formatMoney))
  const where = range ? ' вне коридора' : ''
  const rule = humanRule(stats.outlier_rule)
  return { label: 'Выбросы', formula: `${list}${where}, ${rule === 'IQR' ? 'правило IQR' : rule}` }
}

function totalStep(p: PositionReport, rules: Report['rules']): CalcStep {
  const qty = formatQuantity(p.position.quantity, p.position.unit)
  if (p.status === 'ok' && p.unit_price !== null && p.total !== null) {
    return {
      label: 'НМЦК позиции',
      formula: `${formatMoney(p.unit_price)} × ${qty}`,
      result: formatMoney(p.total),
      note: p.excluded_by_user ? 'в итог не входит: исключена по вашей просьбе' : undefined,
    }
  }
  const reference = p.reference_price !== null ? `, цена ${formatMoney(p.reference_price)} справочно` : ''
  if (p.status === 'heterogeneous') {
    return { label: 'НМЦК позиции', formula: `не определена: цены неоднородны${reference}` }
  }
  const n = p.stats?.n ?? 0
  const min = typeof rules.min_prices === 'number' ? `, нужно не меньше ${rules.min_prices}` : ''
  return {
    label: 'НМЦК позиции',
    formula: `не определена: ${n} ${plural(n, 'цена', 'цены', 'цен')}${min}${reference}`,
  }
}

/** Шаги расчёта позиции; пусто, если считать нечего (тогда см. noCalcText). */
export function calcSteps(p: PositionReport, rules: Report['rules']): CalcStep[] {
  const { stats } = p
  if (!stats) return []
  return [meanStep(p, stats), spreadStep(p, stats, rules), outliersStep(p, stats), totalStep(p, rules)]
}

/** Почему у позиции нет расчёта: одной строкой с разбором исключённых. */
export function noCalcText(p: PositionReport): string {
  if (p.excluded.length === 0) return 'Подходящих цен не нашлось, поэтому расчёта нет.'
  const counts = new Map<string, number>()
  for (const e of p.excluded) {
    const key = e.exclusion ? exclusionLabel[e.exclusion] : 'другое'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const parts = [...counts.entries()].map(([k, n]) => `${k}: ${n}`)
  const total = p.excluded.length
  return `Цен для расчёта нет: ${total} ${plural(total, 'найденное предложение исключено', 'найденных предложения исключены', 'найденных предложений исключены')} (${parts.join(', ')}).`
}

/** Кратко, почему позиция не вошла в итог; null для обоснованной. */
export function weakReason(p: PositionReport): string | null {
  if (p.excluded_by_user) return 'исключена вами'
  if (p.status === 'ok') return null
  if (p.status === 'heterogeneous') return 'цены неоднородны'
  if (p.reference_price === null && (p.stats?.n ?? 0) === 0) return 'нет цен'
  return 'мало цен'
}

/** Подпись под справочной ценой в таблице позиций. */
export function priceNote(p: PositionReport): string | null {
  if (p.status === 'ok') return null
  if (p.reference_price === null) return 'нет цен'
  return p.status === 'heterogeneous' ? 'неоднородны, справочно' : 'справочно'
}

/** Причина исключения человеческим языком. */
export function exclusionText(e: OfferEntry, stats: Stats | null): string {
  const price = e.normalized_price === null ? null : Number(e.normalized_price)
  switch (e.exclusion) {
    case 'anomalous_price': {
      if (stats && price !== null) {
        if (stats.lower_bound !== null && price < Number(stats.lower_bound)) {
          return `Выброс: ниже коридора ${formatMoney(stats.lower_bound)}`
        }
        if (stats.upper_bound !== null && price > Number(stats.upper_bound)) {
          return `Выброс: выше коридора ${formatMoney(stats.upper_bound)}`
        }
      }
      const rule = /^(?:Аномальная цена|Выброс):\s*(.+)$/i.exec(tidyText(e.reason))
      return rule ? `Выброс: ${humanRule(rule[1])}` : 'Выброс'
    }
    case 'incomparable': {
      const bad = e.comparison.filter((c) => c.ok === false)
      const names = (bad.some((c) => c.essential) ? bad.filter((c) => c.essential) : bad).map((c) => c.name)
      if (names.length > 0) return `Не совпадает с ТЗ: ${names.join(', ')}`
      return tidyText(e.reason) || 'Не совпадает с ТЗ'
    }
    case 'unit_mismatch': {
      const m = /^Нельзя перевести (.+) в (.+)$/i.exec(tidyText(e.reason))
      return m ? `Другая единица: «${m[1]}» не переводится в «${m[2]}»` : tidyText(e.reason) || 'Другая единица'
    }
    case null:
      return tidyText(e.reason)
    default: {
      const reason = tidyText(e.reason)
      if (reason) return reason
      const label = exclusionLabel[e.exclusion]
      return label.charAt(0).toUpperCase() + label.slice(1)
    }
  }
}

/** Самая длинная подпись позиции в переключателе, символов. */
export const SHORT_LABEL = 24

/**
 * Короткая подпись позиции: первые слова названия до `max` символов с многоточием.
 * Без названия остаётся «Позиция N».
 */
export function shortPositionLabel(name: string, index: number, max = SHORT_LABEL): string {
  const text = name.replace(/\s+/g, ' ').trim()
  if (!text) return `Позиция ${index}`
  if (text.length <= max) return text
  let label = ''
  for (const word of text.split(' ')) {
    const next = label ? `${label} ${word}` : word
    if (next.length > max - 1) break
    label = next
  }
  // Первое слово длиннее предела: режем по символам.
  if (!label) label = text.slice(0, max - 1)
  return `${label.replace(/[\s,.;:(«"-]+$/u, '')}…`
}

/** Подпись строки таблицы позиций целиком, если название не длиннее, символов. */
export const ROW_LABEL = 28

const STOP = new Set(['для', 'в', 'во', 'на', 'из', 'с', 'со', 'по', 'и', 'или', 'к', 'от', 'до', 'без', 'под', 'при', 'а'])
const UNIT = /^(?:г\/м²|г\/м2|г\/кв\.?м\.?|г|кг|мм|см|м|мл|л\.?|шт\.?|листов|лист\.?|%)[,.;:]?$/i

interface Token {
  text: string
  key: string
}

/** Слова названия; число с единицей («80 г/м²») и «№ 5» склеиваются в одно слово. */
function tokens(name: string): Token[] {
  const words = name.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  const out: Token[] = []
  for (let i = 0; i < words.length; i++) {
    let text = words[i]
    const bare = text.replace(/[,;:]+$/u, '')
    if ((/^\d+(?:[.,]\d+)?$/.test(bare) || bare === '№') && i + 1 < words.length && (bare === '№' || UNIT.test(words[i + 1]))) {
      text = `${bare} ${words[++i]}`
    }
    text = text.replace(/[,;:.]+$/u, '')
    if (text) out.push({ text, key: text.toLowerCase().replace(/ё/g, 'е') })
  }
  return out
}

/** Формат, марка, размер: слово с цифрой, латиницей, аббревиатура или имя собственное не в начале. */
function isMarker(t: Token, first: boolean): boolean {
  if (t.text.startsWith('(')) return false
  return /\d/.test(t.text) || /[a-z]/i.test(t.text) || /^[А-ЯЁ]{2,}$/.test(t.text) || (!first && /^[А-ЯЁ]/.test(t.text))
}

const capitalizeFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export interface PositionLabel {
  /** Вкладка переключателя: только то, чем позиция отличается от остальных. */
  tab: string
  /** Строка таблицы позиций: главное слово и различающие. */
  row: string
}

/**
 * Короткие подписи позиций. Слова, общие для всех названий, во вкладке опускаются; остаются
 * первое своё описательное слово («Писчая») и формат, марка, размер («А4 SvetoCopy»).
 * Если так подписи не получаются или совпадают, остаются первые слова названия.
 */
export function positionLabels(positions: { index: number; name: string }[]): Map<number, PositionLabel> {
  const all = positions.map((p) => tokens(p.name))
  const counts = new Map<string, number>()
  for (const list of all) for (const key of new Set(list.map((t) => t.key))) counts.set(key, (counts.get(key) ?? 0) + 1)
  const common = (t: Token) => positions.length > 1 && counts.get(t.key) === positions.length
  const own = (t: Token) => counts.get(t.key) === 1 && positions.length > 1

  const result = positions.map((p, i) => {
    const list = all[i]
    // первое своё описательное слово
    const wordAt = list.findIndex((t, j) => !STOP.has(t.key) && !t.text.startsWith('(') && !isMarker(t, j === 0) && own(t))
    const markers = new Set(list.flatMap((t, j) => (isMarker(t, j === 0) ? [j] : [])))

    const tabParts = list.filter((t, j) => j === wordAt || (markers.has(j) && !common(t))).map((t) => t.text)
    const tab = tabParts.length > 0 ? shortPositionLabel(capitalizeFirst(tabParts.join(' ')), p.index) : ''

    const name = p.name.replace(/\s+/g, ' ').trim()
    let row = name
    if (name.length > ROW_LABEL) {
      const parts = list.filter((_, j) => j === 0 || j === wordAt || markers.has(j)).map((t) => t.text)
      row = parts.length >= 2 ? shortPositionLabel(parts.join(' '), p.index, ROW_LABEL + 4) : shortPositionLabel(name, p.index, ROW_LABEL + 4)
    }
    return { index: p.index, tab, row: row || `Позиция ${p.index}` }
  })

  const tabs = result.map((r) => r.tab)
  const distinct = tabs.every((t) => t !== '') && new Set(tabs.map((t) => t.toLowerCase())).size === tabs.length
  return new Map(
    result.map((r) => [r.index, { tab: distinct ? r.tab : shortPositionLabel(positions.find((p) => p.index === r.index)?.name ?? '', r.index), row: r.row }]),
  )
}

/** Подписи вкладок переключателя позиций. */
export function shortPositionLabels(positions: { index: number; name: string }[]): Map<number, string> {
  return new Map([...positionLabels(positions)].map(([index, label]) => [index, label.tab]))
}
