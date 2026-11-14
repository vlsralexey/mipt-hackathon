import { describe, expect, it } from 'vitest'
import { layoutRuler } from './ruler'

describe('layoutRuler', () => {
  it('все значения попадают на ось, порядок сохраняется', () => {
    const l = layoutRuler({ points: [290, 305, 329], outliers: [412], mean: 310.98, lower: 277.56, upper: 355.66 })
    for (const v of [...l.points, ...l.outliers, l.mean, l.band!.from, l.band!.to]) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(100)
    }
    expect(l.points[0]).toBeLessThan(l.points[1])
    expect(l.points[1]).toBeLessThan(l.points[2])
    expect(l.outliers[0]).toBeGreaterThan(l.band!.to)
    expect(l.band!.from).toBeLessThan(l.band!.to)
  })

  it('без границ коридора полосы нет', () => {
    const l = layoutRuler({ points: [100, 120], outliers: [], mean: 110, lower: null, upper: null })
    expect(l.band).toBeNull()
  })

  it('одна цена стоит по центру, а не делит на ноль', () => {
    const l = layoutRuler({ points: [500], outliers: [], mean: 500, lower: null, upper: null })
    expect(l.points[0]).toBeCloseTo(50, 5)
    expect(Number.isFinite(l.mean)).toBe(true)
  })

  it('масштаб линейный: середина между точками остаётся серединой', () => {
    const l = layoutRuler({ points: [100, 200, 300], outliers: [], mean: 200, lower: null, upper: null })
    expect(l.points[1]).toBeCloseTo((l.points[0] + l.points[2]) / 2, 5)
  })
})
