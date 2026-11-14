import { unitForm } from './plural'
import type { Money } from './api/types'

/** Как показываем отсутствующее значение: без длинных тире. */
export const NONE = 'нет'

const rub = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** "761250.00" → "761 250,00 ₽". Деньги не считаем, только показываем строку. */
export function formatMoney(value: Money | null): string {
  if (value === null) return NONE
  const n = Number(value)
  if (!Number.isFinite(n)) return value
  return `${rub.format(n).replace(/ /g, ' ')} ₽`
}

/** 43008 → "42 КБ", 1363148 → "1,3 МБ". */
export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}\u00a0КБ`
  const mb = bytes / (1024 * 1024)
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(mb)}\u00a0МБ`
}

/** "2500" → "2 500", "1.22" → "1,22". Для количеств и штук, не для денег. */
export function formatNumber(value: string): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return value
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 6 }).format(n).replace(/\u00a0/g, '\u202f')
}

/**
 * ("2500", "пачка") → "2 500 пачек", ("50", "шт") → "50 шт".
 * Знакомую единицу склоняем по числу, сокращение ставим как есть. Незнакомое
 * полное название не склоняем и отделяем точкой: "2 · условная единица".
 */
export function formatQuantity(quantity: string, unit: string): string {
  const number = formatNumber(quantity)
  const declined = unitForm(Number(quantity), unit)
  if (declined) return `${number}\u00a0${declined}`
  if (isAbbreviation(unit)) return `${number}\u00a0${unit}`
  return `${number}\u00a0·\u00a0${unit}`
}

function isAbbreviation(unit: string) {
  const text = unit.trim()
  return text.length <= 4 || text.includes('.') || /[\d²³/]/.test(text)
}

/** "761250.00" → "761 250,00" без знака валюты (для крупного итога). */
export function formatAmount(value: Money): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return value
  return rub.format(n).replace(/\u00a0/g, '\u202f')
}

/** Доля строкой → проценты: "0.0468" → "4,68 %". */
export function formatPercent(fraction: string): string {
  const n = Number(fraction)
  if (!Number.isFinite(n)) return fraction
  return `${rub.format(n * 100)}\u00a0%`
}

/** "2026-08-12" → "12.08.2026"; без даты — прочерк. */
export function formatIsoDate(iso: string | null): string {
  if (!iso) return NONE
  const [y, m, d] = iso.split('-')
  return d && m && y ? `${d}.${m}.${y}` : iso
}

/** "2026-11-13T10:20:00+03:00" → "13 ноября 2026". */
export function formatLongDate(iso: string): string {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso))
}

const short = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 })

/** Доля строкой → проценты до десятых: "0.1188" → "11,9 %", "0.33" → "33 %". */
export function formatShare(fraction: string): string {
  const n = Number(fraction)
  if (!Number.isFinite(n)) return fraction
  return `${short.format(n * 100)} %`
}

const dayMonth = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' })

/** "2026-10-19" или "2026-11-13T10:20:00+03:00" → "19 октября 2026", без «г.»; без даты — null. */
export function formatDay(iso: string | null): string | null {
  if (!iso) return null
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  const date = parts ? new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])) : new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${dayMonth.format(date)} ${date.getFullYear()}`
}

/**
 * Тексты бэкенда вместо тире содержат « : »; показываем обычное двоеточие без пробела перед ним.
 * Длинные тире, если всё же придут, тоже заменяем: в интерфейсе их нет.
 */
export function tidyText(text: string): string {
  return text.replace(/\s+[:—–]\s+/g, ': ').replace(/[—–]/g, '-')
}

/** Прямые кавычки в «ёлочки»; вложенные тоже ёлочками, недостающие закрывающие дописываются. */
export function quotesRu(text: string): string {
  let depth = 0
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '«') depth++
    else if (ch === '»') depth = Math.max(0, depth - 1)
    if (ch !== '"') {
      out += ch
      continue
    }
    const prev = i === 0 ? ' ' : text[i - 1]
    const opening = depth === 0 || /[\s(«"]/.test(prev)
    if (opening) {
      depth++
      out += '«'
    } else {
      depth--
      out += '»'
    }
  }
  return out + '»'.repeat(Math.max(0, depth))
}

const OPF_LONG: [RegExp, string][] = [
  [/^общество с ограниченной ответственностью\s*/i, 'ООО '],
  [/^публичное акционерное общество\s*/i, 'ПАО '],
  [/^закрытое акционерное общество\s*/i, 'ЗАО '],
  [/^открытое акционерное общество\s*/i, 'ОАО '],
  [/^акционерное общество\s*/i, 'АО '],
  [/^индивидуальный предприниматель\s*/i, 'ИП '],
]
const OPF = /^(?:ООО|ОАО|ЗАО|ПАО|АО|НАО|ИП|ГУП|МУП|ФГУП|ГБУ|ГКУ|МБУ|МКУ|ФГБУ|АНО|НКО|ТСЖ|ПК|СПК)\b/i
const CYR_WORD = /^[А-ЯЁа-яё][А-ЯЁа-яё-]*$/

const titleWord = (w: string) => w.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('-')
const initial = (w: string) => `${w.charAt(0).toUpperCase()}.`

/**
 * Поставщик из реестра в читаемом виде: «ГАБИБОВ МАЛИК АРТУРОВИЧ» → «Габибов М. А.»,
 * «ООО "ТД "ТЕМА"» → «ООО «ТД «Тема»»». Регистр названия организации меняется,
 * только если оно целиком в верхнем регистре; короткие слова (ТД, ТЦ) остаются аббревиатурами.
 */
export function formatSupplier(raw: string): string {
  let text = tidyText(raw).replace(/\s+/g, ' ').trim()
  for (const [long, short] of OPF_LONG) text = text.replace(long, short)
  // ФИО: три слова кириллицей без кавычек, последнее отчество, возможно после «ИП»
  const ip = /^ИП\s+/i.test(text)
  const words = text.replace(/^ИП\s+/i, '').split(' ')
  if (!/["«»]/.test(text) && words.length === 3 && words.every((w) => CYR_WORD.test(w)) && /(?:вич|вна|чна|ич)$/i.test(words[2]) && (ip || !OPF.test(text))) {
    const [last, first, middle] = words
    return `${ip ? 'ИП ' : ''}${titleWord(last)} ${initial(first)} ${initial(middle)}`
  }
  text = quotesRu(text)
  // форма собственности или похожая аббревиатура в начале (ГБУЗ, МАОУ) остаётся как есть
  const opf = OPF.exec(text)?.[0] ?? /^[А-ЯЁ]{2,5}(?= [^«"])/.exec(text)?.[0] ?? ''
  const name = text.slice(opf.length)
  if (/[А-ЯЁA-Z]/.test(name) && name === name.toUpperCase()) {
    const cased = name.replace(/[А-ЯЁA-Z][А-ЯЁA-Z-]*/g, (w) => (w.length >= 4 ? titleWord(w) : w))
    return `${opf.toUpperCase()}${cased}`
  }
  return text
}

/** Punycode (RFC 3492) для подписи домена: «xn--p1ai» → «рф». */
function punyDecode(label: string): string {
  const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700
  const input = label.slice(4)
  const split = input.lastIndexOf('-')
  const output = split > 0 ? [...input.slice(0, split)] : []
  let i = 0, n = 128, bias = 72
  const adapt = (delta: number, points: number, first: boolean) => {
    delta = first ? Math.floor(delta / damp) : delta >> 1
    delta += Math.floor(delta / points)
    let k = 0
    for (; delta > ((base - tMin) * tMax) >> 1; k += base) delta = Math.floor(delta / (base - tMin))
    return k + Math.floor(((base - tMin + 1) * delta) / (delta + skew))
  }
  for (let pos = split > 0 ? split + 1 : 0; pos < input.length; ) {
    const old = i
    for (let w = 1, k = base; ; k += base) {
      if (pos >= input.length) return label
      const c = input.charCodeAt(pos++)
      const digit = c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : base
      if (digit >= base) return label
      i += digit * w
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias
      if (digit < t) break
      w *= base - t
    }
    bias = adapt(i - old, output.length + 1, old === 0)
    n += Math.floor(i / (output.length + 1))
    i %= output.length + 1
    output.splice(i++, 0, String.fromCodePoint(n))
  }
  return output.join('')
}

/** Домен ссылки без «www.», кириллические домены по-русски; null для не-URL. */
export function hostOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    if (!host) return null
    return host
      .split('.')
      .map((part) => (part.startsWith('xn--') ? punyDecode(part) : part))
      .join('.')
  } catch {
    return null
  }
}
