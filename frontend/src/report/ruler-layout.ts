/**
 * Линейка цен: раскладка в пикселях без наложений. Это геометрия для рисунка,
 * деньги здесь не считаются; сами значения приходят от бэкенда (docs/api.md §5.4).
 *
 * Точки, которые оказались ближе диаметра (с зазором), поднимаются на следующий ряд
 * (beeswarm). Подпись среднего стоит над точками, подписи границ коридора под осью;
 * подписи проверяются на пересечения и при необходимости сдвигаются или переносятся.
 */

export interface RulerInput {
  /** Цены предложений, вошедших в расчёт. */
  points: number[]
  /** Цены предложений, исключённых как выбросы. */
  outliers: number[]
  mean: number
  lower: number | null
  upper: number | null
  /** Ширина линейки в пикселях. */
  width: number
  /** meanShort — подпись среднего для узкой линейки, если полная не помещается. */
  labels: { mean: string; meanShort?: string; lower: string | null; upper: string | null }
  /** Ширина текста в пикселях; по умолчанию оценка по числу символов. */
  textWidth?: (text: string, bold: boolean) => number
}

export interface Dot {
  value: number
  x: number
  /** 0 — на оси, 1 — ряд выше и т. д. */
  row: number
  outlier: boolean
  /** Порядковый номер во входном массиве (points или outliers). */
  index: number
}

export interface LabelBox {
  text: string
  left: number
  width: number
  /** Ряд подписей под осью: 0 — первый. */
  row: number
}

export interface RulerLayout {
  width: number
  x: (value: number) => number
  dots: Dot[]
  /** Число рядов точек (не меньше 1). */
  rows: number
  mean: number
  band: { from: number; to: number } | null
  meanLabel: LabelBox
  boundLabels: LabelBox[]
  /** Число рядов подписей под осью (0, 1 или 2). */
  labelRows: number
}

/** Внешний диаметр точки с белым ободком. */
export const DOT = 16
/** Минимальный зазор между точками одного ряда. */
export const DOT_GAP = 2
/** Отступ от краёв, чтобы крайние точки не обрезались. */
export const EDGE = DOT / 2 + 2
/** Минимальный зазор между подписями. */
export const LABEL_GAP = 10

/** Оценка ширины подписи 14 px: цифры и буквы шрифта Golos около 0,6 em. */
export function estimateTextWidth(text: string, bold = false): number {
  return Math.ceil(text.length * (bold ? 8.9 : 8.5))
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi))

export function layoutRuler(input: RulerInput): RulerLayout {
  const width = Math.max(input.width, 120)
  const measure = input.textWidth ?? estimateTextWidth

  const values = [...input.points, ...input.outliers, input.mean]
  if (input.lower !== null) values.push(input.lower)
  if (input.upper !== null) values.push(input.upper)
  let min = Math.min(...values)
  let max = Math.max(...values)
  if (min === max) {
    // одна цена или все равны: даём оси ширину, чтобы точка оказалась по центру
    const gap = Math.abs(min) * 0.1 || 1
    min -= gap
    max += gap
  }
  const inner = width - EDGE * 2
  const x = (value: number) => EDGE + ((value - min) / (max - min)) * inner

  // Beeswarm: слева направо, каждая точка — в самый нижний ряд, где ей хватает места.
  const all: Dot[] = [
    ...input.points.map((value, index) => ({ value, x: x(value), row: 0, outlier: false, index })),
    ...input.outliers.map((value, index) => ({ value, x: x(value), row: 0, outlier: true, index })),
  ].sort((a, b) => a.x - b.x || Number(a.outlier) - Number(b.outlier))
  const lastInRow: number[] = []
  for (const dot of all) {
    let row = 0
    while (lastInRow[row] !== undefined && dot.x - lastInRow[row] < DOT + DOT_GAP) row += 1
    dot.row = row
    lastInRow[row] = dot.x
  }
  const rows = Math.max(1, lastInRow.length)

  const band = input.lower !== null && input.upper !== null ? { from: x(input.lower), to: x(input.upper) } : null
  const meanX = x(input.mean)

  let meanText = input.labels.mean
  if (measure(meanText, true) > width && input.labels.meanShort) meanText = input.labels.meanShort
  const meanWidth = measure(meanText, true)
  const meanLabel: LabelBox = {
    text: meanText,
    width: meanWidth,
    left: clamp(meanX - meanWidth / 2, 0, width - meanWidth),
    row: 0,
  }

  const boundLabels = band ? layoutBounds(band, input.labels, width, measure) : []
  const labelRows = boundLabels.length === 0 ? 0 : Math.max(...boundLabels.map((l) => l.row)) + 1
  return { width, x, dots: all, rows, mean: meanX, band, meanLabel, boundLabels, labelRows }
}

/** Пересекаются ли две подписи одного ряда с учётом зазора. */
export function overlaps(a: LabelBox, b: LabelBox, gap = LABEL_GAP): boolean {
  return a.row === b.row && a.left < b.left + b.width + gap && b.left < a.left + a.width + gap
}

/**
 * Подписи границ коридора. По порядку пробуем: внутри коридора (левая от левого края,
 * правая к правому), снаружи, по центру границ; каждая подпись прижата к краям линейки.
 * Если ни один вариант не помещается в один ряд, правая подпись уходит во второй ряд.
 */
function layoutBounds(
  band: { from: number; to: number },
  labels: RulerInput['labels'],
  width: number,
  measure: (text: string, bold: boolean) => number,
): LabelBox[] {
  const { lower, upper } = labels
  if (lower === null || upper === null) return []
  const wl = measure(lower, false)
  const wu = measure(upper, false)
  const place = (text: string, w: number, left: number, row = 0): LabelBox => ({
    text,
    width: w,
    left: clamp(left, 0, width - w),
    row,
  })

  if (lower === upper) return [place(lower, wl, band.from - wl / 2)]

  const candidates: [number, number][] = [
    [band.from, band.to - wu],
    [band.from - wl, band.to],
    [band.from - wl / 2, band.to - wu / 2],
  ]
  for (const [l, u] of candidates) {
    const a = place(lower, wl, l)
    const b = place(upper, wu, u)
    if (a.left + wl + LABEL_GAP <= b.left) return [a, b]
  }
  return [place(lower, wl, band.from), place(upper, wu, band.to - wu, 1)]
}
