/**
 * Линейка цен: положение точек в процентах ширины. Это геометрия для рисунка,
 * деньги здесь не считаются; сами значения приходят от бэкенда (docs/api.md §5.4).
 */
export interface RulerInput {
  /** Цены предложений, вошедших в расчёт. */
  points: number[]
  /** Цены предложений, исключённых как выбросы. */
  outliers: number[]
  mean: number
  lower: number | null
  upper: number | null
}

export interface RulerLayout {
  /** Положение значения: 0 — левый край оси, 100 — правый. */
  x: (value: number) => number
  points: number[]
  outliers: number[]
  mean: number
  band: { from: number; to: number } | null
}

const PADDING = 0.05

export function layoutRuler(input: RulerInput): RulerLayout {
  const values = [...input.points, ...input.outliers, input.mean]
  if (input.lower !== null) values.push(input.lower)
  if (input.upper !== null) values.push(input.upper)
  let min = Math.min(...values)
  let max = Math.max(...values)
  if (min === max) {
    // одна цена: даём оси ширину, чтобы точка оказалась по центру
    const gap = Math.abs(min) * 0.1 || 1
    min -= gap
    max += gap
  }
  const pad = (max - min) * PADDING
  const lo = min - pad
  const span = max - pad - lo + pad * 2
  const x = (value: number) => ((value - lo) / span) * 100
  return {
    x,
    points: input.points.map(x),
    outliers: input.outliers.map(x),
    mean: x(input.mean),
    band: input.lower !== null && input.upper !== null ? { from: x(input.lower), to: x(input.upper) } : null,
  }
}
