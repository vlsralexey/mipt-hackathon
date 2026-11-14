import type { Report, SkippedPage } from '../api/types'
import { tidyText } from '../format'
import { plural } from '../plural'

/**
 * Предупреждения отчёта коротко и по группам. Бэкенд присылает по строке на каждую позицию и
 * каждый источник (docs/api.md §5.4, report.warnings); здесь однотипные строки объединяются
 * по узнаваемым шаблонам, а всё нераспознанное выводится как есть. Порядок детерминирован.
 */

export interface WarningPage {
  url: string
  reason: string
}

export interface WarningSource {
  name: string
  /** Страницы, которые не открылись; пусто, если источник сообщил об ошибке целиком. */
  pages: WarningPage[]
  /** Ошибки источника без привязки к странице. */
  errors: string[]
}

export interface WarningLine {
  text: string
  /** Раскрываемый список: недоступные источники и страницы. */
  sources?: WarningSource[]
}

type ReportPart = Pick<Report, 'warnings' | 'positions' | 'sources' | 'rules'>

/** Причины, по которым страница не открылась (а не была отброшена по смыслу). */
const FAILED = /недоступ|ограничил доступ|не удалось (обработать|открыть|загрузить)|ошибк|капч|captcha|вход|авториз/i

const UNDERSTATED = /^(.+?) у \d+ из \d+ предложени[а-я]*[,:]? цена может быть занижена\.?$/i
const FOUND = /^найдено (\d+) цен[а-я]*, обоснование недостаточно\.?$/i
const SOME_PRICES = /^для \d+ цен (.+)$/i
const SOURCE = /^Источник «(.+?)», позиция (\d+): (.+)$/s
const EXTRAS = /^Требования ТЗ при поставке \((.+)\) в найденных ценах не отражены\.?$/i

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const sentence = (s: string) => (/[.!?…]$/.test(s) ? s : `${s}.`)

/** «А», «А и Б», «А, Б и В». */
export function joinRu(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} и ${items.at(-1)}`
}

const positionsRef = (indexes: number[]) => `поз. ${joinRu([...new Set(indexes)].sort((a, b) => a - b).map(String))}`

/**
 * Группа источника для строки, в нижнем регистре и без своего «и»:
 * «ЕИС: реестр контрактов» → «ЕИС», «Производители и дистрибьюторы» → «сайты производителей».
 */
export function sourceGroup(name: string): string {
  const head = name.split(':')[0].trim()
  if (/^ЕИС/i.test(head)) return 'ЕИС'
  if (/производител|дистрибьютор/i.test(head)) return 'сайты производителей'
  if (/маркетплейс/i.test(head)) return 'маркетплейсы'
  if (/магазин/i.test(head)) return 'магазины'
  const first = head.split(/\s+и\s+/)[0]
  // аббревиатуру оставляем как есть
  return /^[A-ZА-ЯЁ]{2,}\b/.test(first) ? first : first.charAt(0).toLowerCase() + first.slice(1)
}

/** «занос в помещение 1 этаж» → «занос»: подробности есть в ТЗ. */
const extraItem = (item: string) => item.trim().split(/\s+(?:в|во|на|до|по)\s+/)[0]

/** Отделяет «Позиция N «название»: » от текста. Сначала по точным названиям позиций из отчёта. */
function splitPosition(text: string, report: ReportPart): { index: number; rest: string } | null {
  for (const p of report.positions) {
    const prefix = tidyText(`Позиция ${p.position.index} «${p.position.name}»: `)
    if (text.startsWith(prefix)) return { index: p.position.index, rest: text.slice(prefix.length) }
  }
  const m = /^Позиция (\d+)(?: «.*?»)?: (.+)$/s.exec(text)
  return m ? { index: Number(m[1]), rest: m[2] } : null
}

/** Группы с сохранением порядка первого появления. */
class Groups {
  private map = new Map<string, number[]>()
  add(key: string, index: number) {
    const list = this.map.get(key) ?? []
    list.push(index)
    this.map.set(key, list)
  }
  entries() {
    return [...this.map.entries()]
  }
  get size() {
    return this.map.size
  }
}

export function groupWarnings(report: ReportPart): WarningLine[] {
  const understated = new Groups()
  const byPosition = new Groups()
  const status: WarningLine[] = []
  const global: string[] = []
  const sourceProblems = new Map<string, { errors: Set<string>; positions: number[] }>()
  const minPrices = typeof report.rules.min_prices === 'number' ? report.rules.min_prices : null
  // У позиции без цен в расчёте оговорки о ценах (занижение, неустойки) ни на что не влияют.
  const unpriced = new Set(
    report.positions.filter((p) => !p.included.some((e) => e.normalized_price !== null)).map((p) => p.position.index),
  )
  let extrasDelivery = false

  for (const raw of report.warnings) {
    const text = tidyText(raw.trim())

    const source = SOURCE.exec(text)
    if (source) {
      const [, name, index, errors] = source
      const entry = sourceProblems.get(name) ?? { errors: new Set<string>(), positions: [] }
      for (const e of errors.split(/;\s*/)) if (e) entry.errors.add(e.replace(/\.$/, ''))
      entry.positions.push(Number(index))
      sourceProblems.set(name, entry)
      continue
    }

    const pos = splitPosition(text, report)
    if (pos) {
      const { index, rest } = pos
      const under = UNDERSTATED.exec(rest)
      const found = FOUND.exec(rest)
      const some = SOME_PRICES.exec(rest)
      if ((under || /неусто/i.test(rest)) && unpriced.has(index)) continue
      if (under) understated.add(under[1], index)
      else if (found) {
        const n = Number(found[1])
        status.push({
          text:
            n === 0
              ? `Позиция ${index}: не найдено ни одной цены.`
              : `Позиция ${index}: найдено ${n} ${plural(n, 'цена', 'цены', 'цен')}` +
                (minPrices !== null ? `, для обоснования нужно не меньше ${minPrices}.` : ', для обоснования мало.'),
        })
      } else if (/^выборка неоднородна/i.test(rest)) status.push({ text: sentence(`Позиция ${index}: ${rest}`) })
      else if (some) byPosition.add(`для части цен ${some[1]}`, index)
      else byPosition.add(rest.replace(/\.$/, ''), index)
      continue
    }

    const extras = EXTRAS.exec(text)
    let line = sentence(text)
    if (extras) {
      const items = extras[1].split(/,\s*/).filter(Boolean).map(extraItem)
      if (items.some((i) => /доставк/i.test(i))) extrasDelivery = true
      line = `${capitalize(joinRu(items))} из ТЗ в ценах не учтены.`
    }
    if (!global.includes(line)) global.push(line)
  }

  const lines: WarningLine[] = []
  // «доставка не подтверждена» уже сказана строкой о требованиях ТЗ к доставке
  const underParts = understated.entries().filter(([what]) => !(extrasDelivery && /^доставк/i.test(what)))
  if (underParts.length > 0) {
    const parts = underParts.map(([what, indexes]) => `${what} (${positionsRef(indexes)})`)
    lines.push({ text: `Цена может быть занижена: ${parts.join(', ')}.` })
  }
  for (const [what, indexes] of byPosition.entries()) {
    lines.push({ text: `${capitalize(what)} (${positionsRef(indexes)}).` })
  }
  for (const text of global) lines.push({ text })
  lines.push(...status)

  const sources = sourcesLine(report, sourceProblems)
  if (sources) lines.push(sources)
  return lines
}

/** Недоступные страницы и источники одной строкой со списком «какие». */
function sourcesLine(
  report: ReportPart,
  problems: Map<string, { errors: Set<string>; positions: number[] }>,
): WarningLine | null {
  const names = new Map(report.sources.map((s) => [s.source_id, s.name]))
  const seen = new Set<string>()
  const pagesBySource = new Map<string, WarningPage[]>()
  const failed: SkippedPage[] = report.positions.flatMap((p) => p.skipped_pages).filter((p) => FAILED.test(p.reason))
  for (const page of failed) {
    if (seen.has(page.url)) continue
    seen.add(page.url)
    const name = tidyText(names.get(page.source_id) ?? page.source_id)
    const list = pagesBySource.get(name) ?? []
    list.push({ url: page.url, reason: tidyText(page.reason) })
    pagesBySource.set(name, list)
  }
  if (seen.size === 0 && problems.size === 0) return null

  // Источники в порядке: сначала со страницами, затем только с ошибками
  const order = [...new Set([...pagesBySource.keys(), ...problems.keys()])]
  const sources: WarningSource[] = order.map((raw) => {
    const pages = pagesBySource.get(raw) ?? []
    const errors = [...(problems.get(raw)?.errors ?? [])].filter((e) => !pages.some((p) => p.reason === e))
    return { name: raw, pages, errors: pages.length > 0 ? [] : errors }
  })
  const list = joinRu([...new Set(sources.map((s) => sourceGroup(s.name)))])
  const n = seen.size
  const text =
    n > 0
      ? `${n} ${plural(n, 'страница не открылась', 'страницы не открылись', 'страниц не открылись')}: ${list}.`
      : `${capitalize(plural(sources.length, 'источник ответил', 'источники ответили', 'источники ответили'))} с ошибкой: ${list}.`
  return { text, sources }
}
