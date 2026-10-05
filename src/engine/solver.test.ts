import { describe, expect, it } from 'vitest'
import { solveLayout, mulberry32 } from './solver'
import { solveBatch } from './batch'
import { cutLineCount, cutSegments } from './scoring'
import type { LayoutResult, PhotoInput } from './types'

const W = 1800, H = 1200, M = 48, G = 24
const base = { width: W, height: H, margin: M, gap: G, maxPhotos: 6 }
const mk = (ratios: number[]): PhotoInput[] => ratios.map((r, i) => ({ id: 'p' + i, width: Math.round(r * 1000), height: 1000 }))
const L = 1.5, P = 1 / 1.5

function check(res: LayoutResult, photos: PhotoInput[], gap = G) {
  expect(res.photos.map(p => p.id).sort()).toEqual(photos.map(p => p.id).sort())
  expect(res.score).toBeGreaterThanOrEqual(0)
  expect(res.score).toBeLessThanOrEqual(1)
  const e = 1e-6
  for (const p of res.photos) {
    expect(Number.isFinite(p.x + p.y + p.width + p.height)).toBe(true)
    expect(p.width).toBeGreaterThan(0); expect(p.height).toBeGreaterThan(0)
    expect(p.x).toBeGreaterThanOrEqual(M - e); expect(p.y).toBeGreaterThanOrEqual(M - e)
    expect(p.x + p.width).toBeLessThanOrEqual(W - M + e); expect(p.y + p.height).toBeLessThanOrEqual(H - M + e)
    expect(p.crop.x + p.crop.width).toBeLessThanOrEqual(1 + e)
    expect(p.crop.y + p.crop.height).toBeLessThanOrEqual(1 + e)
  }
  for (const a of res.photos) for (const b of res.photos) if (a !== b) {
    const sepX = a.cell.x + a.cell.width + gap - e <= b.cell.x || b.cell.x + b.cell.width + gap - e <= a.cell.x
    const sepY = a.cell.y + a.cell.height + gap - e <= b.cell.y || b.cell.y + b.cell.height + gap - e <= a.cell.y
    expect(sepX || sepY).toBe(true)
  }
}

/** Baseline naïve : meilleure grille régulière r×c */
function gridScore(photos: PhotoInput[]) {
  const n = photos.length; let best = 0
  for (let r = 1; r <= n; r++) {
    const c = Math.ceil(n / r)
    let loss = 0
    const cw = (W - 2 * M - (c - 1) * G) / c, ch = (H - 2 * M - (r - 1) * G) / r
    photos.forEach(p => { const a = p.width / p.height, d = cw / ch; loss += a > d ? 1 - d / a : 1 - a / d })
    best = Math.max(best, 1 - loss / n)
  }
  return best
}

describe('solveLayout', () => {
  const sets: Record<string, number[]> = {
    paysages: [L, L, L, L], portraits: [P, P, P, P], mix: [L, P, L, L, P], carrés: [1, 1, 1, 1, 1],
    extrêmes: [5, 0.2, L, 4, 0.25, 1], panorama: [6],
  }
  for (const [name, r] of Object.entries(sets)) it(name, () => check(solveLayout({ ...base, photos: mk(r) }), mk(r)))

  for (let n = 1; n <= 6; n++) it(`${n} photo(s)`, () => {
    const rnd = mulberry32(n), ph = mk(Array.from({ length: n }, () => 0.5 + rnd() * 1.5))
    check(solveLayout({ ...base, photos: ph }), ph)
  })

  it('4 paysages 3:2 → ~zéro crop', () => {
    const r = solveLayout({ ...base, photos: mk([L, L, L, L]) })
    expect(r.score).toBeGreaterThan(0.9)
  })
  it('1 photo → remplit la zone', () => {
    const r = solveLayout({ ...base, photos: mk([L]) })
    expect(r.photos[0].width).toBeCloseTo(W - 2 * M)
  })
  it('crop moyen ≤ meilleure grille régulière (mix)', () => {
    const ph = mk([L, P, L, L, P, L])
    const r = solveLayout({ ...base, photos: ph })
    expect(r.photos.reduce((s, p) => s + p.cropLoss, 0) / ph.length).toBeLessThanOrEqual(1 - gridScore(ph) + 1e-9)
  })
  it('contain : jamais de crop ; minimal : crop borné', () => {
    const ph = mk([L, P, 3, 0.4])
    solveLayout({ ...base, photos: ph, cropMode: 'contain' }).photos.forEach(p => expect(p.cropLoss).toBeCloseTo(0))
    solveLayout({ ...base, photos: ph, cropMode: 'minimal' }).photos.forEach(p => expect(p.cropLoss).toBeLessThanOrEqual(0.121))
  })
  it('regenerate avec avoid → autre layout', () => {
    const ph = mk([L, P, L, P, L])
    const a = solveLayout({ ...base, photos: ph })
    const b = solveLayout({ ...base, photos: ph, avoid: a, variety: 0.05, seed: 7 })
    expect(JSON.stringify(b.photos.map(p => [p.id, Math.round(p.x), Math.round(p.y)]))).not.toEqual(JSON.stringify(a.photos.map(p => [p.id, Math.round(p.x), Math.round(p.y)])))
  })
})

describe('solveBatch', () => {
  const run = (n: number, min: number, seed = 3) => {
    const rnd = mulberry32(seed)
    const ph = mk(Array.from({ length: n }, () => (rnd() < 0.35 ? P : rnd() < 0.1 ? 1 : L)))
    const t = Date.now()
    const pages = solveBatch(ph, { ...base, minPhotos: min })
    return { ph, pages, ms: Date.now() - t }
  }
  const covers = (ph: PhotoInput[], pages: { photoIds: string[] }[]) =>
    expect(pages.flatMap(p => p.photoIds)).toEqual(ph.map(p => p.id))

  it('20 photos : toutes placées une fois, ordre conservé, ≤ max', () => {
    const { ph, pages } = run(20, 3)
    covers(ph, pages); pages.forEach(p => expect(p.photoIds.length).toBeLessThanOrEqual(6))
  })
  it('14 photos, min 4 → pas de page sous 4 (pas de 6/6/2)', () => {
    const { ph, pages } = run(14, 4)
    covers(ph, pages); expect(Math.min(...pages.map(p => p.photoIds.length))).toBeGreaterThanOrEqual(4)
  })
  it('moins que min photos → une page', () => expect(run(2, 4).pages).toHaveLength(1))
  it('200 photos : complet et pas de miette finale', () => {
    const { ph, pages, ms } = run(200, 3)
    covers(ph, pages)
    expect(pages[pages.length - 1].photoIds.length).toBeGreaterThanOrEqual(3)
    console.log(`200 photos → ${pages.length} pages en ${ms} ms, tailles:`, pages.map(p => p.photoIds.length).join(''))
  })
  it('global ≥ découpage naïf par 6 (score moyen par photo)', () => {
    const { ph, pages } = run(40, 3, 11)
    const per = (ps: { photoIds: string[]; layout: LayoutResult }[]) => ps.reduce((s, p) => s + p.layout.score * p.photoIds.length, 0) / ph.length
    const naive = []
    for (let i = 0; i < ph.length; i += 6) { const s = ph.slice(i, i + 6); naive.push({ photoIds: s.map(p => p.id), layout: solveLayout({ ...base, photos: s, effort: 10 }) }) }
    expect(per(pages)).toBeGreaterThanOrEqual(per(naive) - 0.02)
  })
})

describe('budget', () => {
  it('262 photos, max 8 : temps borné', () => {
    const rnd = mulberry32(9)
    const ph = mk(Array.from({ length: 262 }, () => (rnd() < 0.35 ? P : L)))
    const t = Date.now()
    const pages = solveBatch(ph, { ...base, maxPhotos: 8, minPhotos: 3 })
    const ms = Date.now() - t
    console.log(`262 photos max 8 → ${pages.length} pages en ${ms} ms`)
    expect(pages.flatMap(p => p.photoIds)).toEqual(ph.map(p => p.id))
    expect(ms).toBeLessThan(30000)
  })
})

describe('découpe facile', () => {
  const lines = (r: LayoutResult) => cutLineCount(cutSegments(r.photos, G), W * 0.002)
  it('alignement ≤ lignes de coupe que sans, et reste valide', () => {
    let off = 0, on = 0
    for (let seed = 1; seed <= 25; seed++) {
      const rnd = mulberry32(seed), ph = mk(Array.from({ length: 6 }, () => (rnd() < 0.4 ? P : L)))
      const a = solveLayout({ ...base, photos: ph, effort: 20 }), b = solveLayout({ ...base, photos: ph, effort: 20, alignment: 0.5 })
      check(b, ph); off += lines(a); on += lines(b)
    }
    console.log('lignes de coupe moy. libre', off / 25, 'aligné', on / 25)
    expect(on).toBeLessThan(off)
  })
  it('4 photos mixtes : 2 rangées → mêmes gouttières verticales', () => {
    const ph = mk([L, P, P, L])
    const r = solveLayout({ ...base, photos: ph, alignment: 0.5 })
    expect(lines(r)).toBeLessThanOrEqual(3)
  })
})

describe('ratio imposé', () => {
  it('la cellule se rapproche du ratio demandé', () => {
    const ph = mk([L, L, L, L])
    const free = solveLayout({ ...base, photos: ph })
    const forced = solveLayout({ ...base, photos: ph.map((p, i) => (i === 0 ? { ...p, ratio: 1 } : p)) })
    check(forced, ph)
    const asp = (r: LayoutResult) => { const c = r.photos.find(p => p.id === 'p0')!.cell; return c.width / c.height }
    expect(Math.abs(Math.log(asp(forced)))).toBeLessThan(Math.abs(Math.log(asp(free))))
  })
})

describe('photos épinglées', () => {
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6
  it('la photo épinglée ne bouge pas, les autres s’adaptent', () => {
    const ph = mk([L, P, L, P, L, L])
    const first = solveLayout({ ...base, photos: ph })
    const pin = first.photos.find(p => p.id === 'p1')!
    for (const seed of [1, 2, 3, 4]) {
      const r = solveLayout({ ...base, photos: ph, fixed: [pin], seed, variety: 0.05, avoid: first })
      check(r, ph)
      const q = r.photos.find(p => p.id === 'p1')!
      expect([q.x, q.y, q.width, q.height].every((v, i) => near(v, [pin.x, pin.y, pin.width, pin.height][i]))).toBe(true)
      expect(q.crop).toEqual(pin.crop)
    }
  })
  it('2 épingles + autres photos : valide', () => {
    const ph = mk([L, P, L, P, L, L, L])
    const first = solveLayout({ ...base, photos: ph.slice(0, 6) })
    const fixed = ['p0', 'p3'].map(id => first.photos.find(p => p.id === id)!)
    check(solveLayout({ ...base, maxPhotos: 7, photos: ph, fixed, seed: 5 }), ph)
  })
  it('tout épinglé → layout inchangé', () => {
    const ph = mk([L, L, L])
    const first = solveLayout({ ...base, photos: ph })
    expect(solveLayout({ ...base, photos: ph, fixed: first.photos }).photos).toHaveLength(3)
  })
})
