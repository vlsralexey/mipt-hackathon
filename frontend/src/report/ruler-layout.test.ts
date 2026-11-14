import { describe, expect, it } from 'vitest'
import { DOT, DOT_GAP, layoutRuler, overlaps, type RulerInput, type RulerLayout } from './ruler-layout'

const money = (v: number | null) => (v === null ? null : `${v.toFixed(2).replace('.', ',')} ₽`)

function layout(over: Partial<RulerInput> & Pick<RulerInput, 'points'>): RulerLayout {
  const input = { outliers: [], lower: null, upper: null, width: 560, ...over }
  const mean = over.mean ?? input.points.reduce((s, v) => s + v, 0) / input.points.length
  return layoutRuler({
    ...input,
    mean,
    labels: { mean: `среднее ${money(mean)}`, meanShort: money(mean)!, lower: money(input.lower), upper: money(input.upper) },
  })
}

/** Ни одна пара точек не накладывается: в одном ряду между центрами не меньше диаметра с зазором. */
function expectNoDotOverlap(l: RulerLayout) {
  for (const a of l.dots) {
    for (const b of l.dots) {
      if (a === b || a.row !== b.row) continue
      expect(Math.abs(a.x - b.x)).toBeGreaterThanOrEqual(DOT + DOT_GAP - 1e-9)
    }
  }
}

/** Подписи не пересекаются и не выходят за края линейки. */
function expectLabelsFit(l: RulerLayout) {
  const labels = l.boundLabels
  for (const a of labels) {
    expect(a.left).toBeGreaterThanOrEqual(0)
    expect(a.left + a.width).toBeLessThanOrEqual(l.width + 1e-9)
    for (const b of labels) if (a !== b) expect(overlaps(a, b)).toBe(false)
  }
  expect(l.meanLabel.left).toBeGreaterThanOrEqual(0)
  expect(l.meanLabel.left + l.meanLabel.width).toBeLessThanOrEqual(l.width + 1e-9)
}

describe('layoutRuler', () => {
  it('все значения на оси, порядок и масштаб сохраняются', () => {
    const l = layout({ points: [290, 305, 329], outliers: [412], mean: 310.98, lower: 277.56, upper: 355.66 })
    const xs = l.dots.filter((d) => !d.outlier).map((d) => d.x)
    expect(xs[0]).toBeLessThan(xs[1])
    expect(xs[1]).toBeLessThan(xs[2])
    for (const d of l.dots) {
      expect(d.x).toBeGreaterThanOrEqual(DOT / 2)
      expect(d.x).toBeLessThanOrEqual(l.width - DOT / 2)
    }
    expect(l.dots.find((d) => d.outlier)!.x).toBeGreaterThan(l.band!.to)
    expect(l.band!.from).toBeLessThan(l.band!.to)
    const mid = layout({ points: [100, 200, 300] })
    expect(mid.x(200)).toBeCloseTo((mid.x(100) + mid.x(300)) / 2, 5)
  })

  it('без границ коридора нет полосы и подписей границ', () => {
    const l = layout({ points: [100, 120] })
    expect(l.band).toBeNull()
    expect(l.boundLabels).toEqual([])
    expect(l.labelRows).toBe(0)
  })

  it('близкие точки поднимаются на следующий ряд', () => {
    // позиция 2 из закупки бумаги: 867,55 и 876,00 почти в одной точке на фоне широкого коридора
    const l = layout({ points: [876, 760, 867.55], mean: 834.52, lower: 433.78, upper: 1301.33 })
    expect(l.rows).toBe(2)
    expectNoDotOverlap(l)
    expectLabelsFit(l)
  })

  it('одна цена: по центру, без деления на ноль', () => {
    const l = layout({ points: [500] })
    expect(l.dots[0].x).toBeCloseTo(l.width / 2, 5)
    expect(l.rows).toBe(1)
    expect(Number.isFinite(l.mean)).toBe(true)
    expectLabelsFit(l)
  })

  it('все цены равны: точки стопкой, коридор нулевой ширины подписан один раз', () => {
    const l = layout({ points: [300, 300, 300, 300], mean: 300, lower: 300, upper: 300 })
    expect(l.rows).toBe(4)
    expectNoDotOverlap(l)
    expect(l.boundLabels).toHaveLength(1)
    expectLabelsFit(l)
  })

  it('граница у края: подписи прижаты к краям и не вылезают', () => {
    const l = layout({ points: [100, 101, 150], mean: 117, lower: 100, upper: 150, width: 300 })
    expectLabelsFit(l)
    // левая подпись от левого края коридора, правая к правому краю
    expect(l.boundLabels[0].left).toBeCloseTo(l.band!.from, 5)
    expect(l.boundLabels[1].left + l.boundLabels[1].width).toBeCloseTo(l.band!.to, 5)
    // коридор во всю ширину узкой линейки: подписи остаются внутри
    const edge = layout({ points: [100, 150], mean: 125, lower: 90, upper: 160, width: 170 })
    expectLabelsFit(edge)
  })

  it('узкий коридор: подписи выходят наружу или переносятся, но не пересекаются', () => {
    const narrow = layout({ points: [100, 300, 302, 500], mean: 300, lower: 299, upper: 303 })
    expectLabelsFit(narrow)
    // ширина линейки меньше двух подписей: правая уходит во второй ряд
    const tiny = layout({ points: [100, 101, 102], mean: 101, lower: 100, upper: 102, width: 130 })
    expectLabelsFit(tiny)
    expect(tiny.labelRows).toBe(2)
  })

  it('выброс рядом с границей не накладывается на точку в коридоре', () => {
    const l = layout({ points: [200, 205, 406], outliers: [408.3], mean: 270, lower: 210.53, upper: 406.65 })
    expectNoDotOverlap(l)
    const outlier = l.dots.find((d) => d.outlier)!
    const neighbour = l.dots.find((d) => d.value === 406)!
    expect(outlier.row).not.toBe(neighbour.row)
    expectLabelsFit(l)
  })

  it('подпись среднего у края прижимается внутрь', () => {
    const l = layout({ points: [100, 1000], mean: 100, width: 320 })
    expect(l.meanLabel.left).toBe(0)
    expectLabelsFit(l)
  })

  it('много разных данных: никаких наложений ни при какой ширине', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let i = 0; i < 200; i++) {
      const n = 1 + Math.floor(rnd() * 12)
      const points = Array.from({ length: n }, () => Math.round(100 + rnd() * 50) * (rnd() > 0.8 ? 3 : 1))
      const mean = points.reduce((s, v) => s + v, 0) / n
      const spread = rnd() * mean
      const width = 160 + Math.floor(rnd() * 500)
      const l = layout({ points, outliers: rnd() > 0.5 ? [mean + spread * 1.2] : [], mean, lower: mean - spread, upper: mean + spread, width })
      expectNoDotOverlap(l)
      expectLabelsFit(l)
    }
  })
})
