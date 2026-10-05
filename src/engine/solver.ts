import type { CropMode, LayoutResult, PhotoInput, PlacedPhoto, Rect, SolveOptions } from './types'
import { scoreLayout } from './scoring'

const ratioOf = (p: PhotoInput) => p.ratio ?? p.width / p.height
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

export function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Zone source (normalisée) qui remplit un rectangle d'aspect destAr, façon object-fit: cover. */
export function coverCrop(ar: number, destAr: number, focus = { x: 0.5, y: 0.5 }, zoom = 1): Rect {
  let w = 1, h = 1
  if (ar > destAr) w = destAr / ar; else h = ar / destAr
  w /= zoom; h /= zoom
  return { x: clamp(focus.x - w / 2, 0, 1 - w), y: clamp(focus.y - h / 2, 0, 1 - h), width: w, height: h }
}

const MAX_CROP_AREA = 0.12 // mode "minimal" : au-delà, on réduit la photo plutôt que de rogner

function fit(p: PhotoInput, cell: Rect, mode: CropMode): PlacedPhoto {
  const ar = p.width / p.height
  let cr = cell.width / cell.height
  let vis = cell
  if (mode === 'contain') {
    vis = shrink(cell, ar)
  } else if (mode === 'minimal') {
    const loss = ar > cr ? 1 - cr / ar : 1 - ar / cr
    if (loss > MAX_CROP_AREA) vis = shrink(cell, ar > cr ? ar * (1 - MAX_CROP_AREA) : ar / (1 - MAX_CROP_AREA))
  }
  cr = vis.width / vis.height
  const crop = coverCrop(ar, cr, p.focus)
  return { id: p.id, ...vis, crop, cell, cropLoss: 1 - crop.width * crop.height, ratio: p.ratio }
}

export { fit as fitPhoto }

/** Plus grand rect d'aspect `ar` centré dans `cell` */
function shrink(cell: Rect, ar: number): Rect {
  const w = Math.min(cell.width, cell.height * ar), h = w / ar
  return { x: cell.x + (cell.width - w) / 2, y: cell.y + (cell.height - h) / 2, width: w, height: h }
}

// ---- Partition récursive (guillotine) : feuille = photo, nœud = coupe 'v' (côte à côte) ou 'h' (empilé)
interface Shape { dir: 'h' | 'v'; a: Shape | null; b: Shape | null; n: number }
const shapeCache = new Map<number, (Shape | null)[]>()

function shapes(n: number): (Shape | null)[] {
  if (n === 1) return [null]
  let out = shapeCache.get(n)
  if (out) return out
  out = []
  for (let k = 1; k < n; k++)
    for (const a of shapes(k)) for (const b of shapes(n - k)) for (const dir of ['h', 'v'] as const) {
      if (a && a.dir === dir) continue // (x|y)|z ≡ x|(y|z) : on ne garde que l'imbrication à droite
      out.push({ dir, a, b, n })
    }
  shapeCache.set(n, out)
  return out
}

const size = (s: Shape | null) => (s ? s.n : 1)

/** Aspect "naturel" (zéro crop, gaps ignorés) du sous-arbre */
function aspectOf(s: Shape | null, A: number[], off: number): number {
  if (!s) return A[off]
  const a = aspectOf(s.a, A, off), b = aspectOf(s.b, A, off + size(s.a))
  return s.dir === 'v' ? a + b : 1 / (1 / a + 1 / b)
}

interface Item { shape: Shape | null; off: number }

/** Aplatit les coupes de même direction imbriquées à droite : h(a,h(b,c)) → [a,b,c] */
function items(s: Shape, off: number): Item[] {
  const out: Item[] = []
  let r: Shape | null = s, o = off
  while (r && r.dir === s.dir) { out.push({ shape: r.a, off: o }); o += size(r.a); r = r.b }
  out.push({ shape: r, off: o })
  return out
}
const extents = (its: Item[], dir: 'h' | 'v', A: number[]) => its.map(i => { const a = aspectOf(i.shape, A, i.off); return dir === 'v' ? a : 1 / a })

/**
 * Répartit le rect entre les enfants proportionnellement à leurs aspects naturels → crop minimal.
 * `force` impose les parts (fractions) : sert à aligner exactement les gouttières de rangées voisines.
 */
function place(s: Shape | null, P: PhotoInput[], A: number[], off: number, r: Rect, gap: number, mode: CropMode, align: boolean, out: PlacedPhoto[], force?: number[]) {
  if (!s) { out.push(fit(P[off], r, mode)); return }
  const its = items(s, off), m = its.length, dir = s.dir
  const ext = extents(its, dir, A), tot = ext.reduce((x, y) => x + y, 0)
  const shares = force ?? ext.map(e => e / tot)
  // rangées toutes coupées dans l'autre sens avec le même nb de colonnes → mêmes lignes de coupe pour toutes
  let common: number[] | undefined
  if (align && its.every(i => i.shape && i.shape.dir !== dir)) {
    const subs = its.map(i => items(i.shape!, i.off))
    if (subs.every(l => l.length === subs[0].length)) {
      common = new Array(subs[0].length).fill(0)
      subs.forEach((l, i) => {
        const e = extents(l, its[i].shape!.dir, A), t = e.reduce((x, y) => x + y, 0)
        e.forEach((v, j) => (common![j] += (shares[i] * v) / t))
      })
    }
  }
  const L = (dir === 'v' ? r.width : r.height) - gap * (m - 1)
  let pos = dir === 'v' ? r.x : r.y
  its.forEach((it, i) => {
    const len = L * shares[i]
    const rect = dir === 'v' ? { x: pos, y: r.y, width: len, height: r.height } : { x: r.x, y: pos, width: r.width, height: len }
    place(it.shape, P, A, it.off, rect, gap, mode, align, out, common)
    pos += len + gap
  })
}

function permutations(n: number, limit: number, asp: number[], rnd: () => number): number[][] {
  let total = 1
  for (let i = 2; i <= n; i++) total *= i
  const idx = Array.from({ length: n }, (_, i) => i)
  if (total <= limit) {
    const res: number[][] = []
    const rec = (a: number[], rest: number[]) => {
      if (!rest.length) return void res.push(a)
      rest.forEach((v, i) => rec([...a, v], [...rest.slice(0, i), ...rest.slice(i + 1)]))
    }
    rec([], idx)
    return res
  }
  const asc = [...idx].sort((i, j) => asp[i] - asp[j])
  const res = [idx, asc, [...asc].reverse()]
  const seen = new Set(res.map(String))
  while (res.length < limit) {
    const p = [...idx]
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]] }
    if (!seen.has(String(p))) { seen.add(String(p)); res.push(p) }
  }
  return res
}

const signature = (l: LayoutResult) => l.photos.map(p => `${p.id}@${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.width)},${Math.round(p.height)}`).join('|')

/**
 * Layout d'UNE page : teste (permutations × arbres de partition), score chacun, garde le meilleur.
 * ponytail: split proportionnel aux aspects (pas d'optimisation continue du ratio) ; permutations échantillonnées au-delà de `effort`.
 */
export function solveLayout(o: SolveOptions): LayoutResult {
  if (o.fixed?.length) return solvePinned(o)
  const photos = o.photos.slice(0, o.maxPhotos)
  const n = photos.length
  if (!n) return { score: 0, photos: [] }
  const mode = o.cropMode ?? 'cover'
  const alignW = o.alignment ?? 0
  const inner: Rect = o.region ?? { x: o.margin, y: o.margin, width: o.width - 2 * o.margin, height: o.height - 2 * o.margin }
  const rnd = mulberry32(o.seed ?? 1)
  const budget = o.budget ?? 20000
  let trees = shapes(n)
  if (trees.length > budget) { // n grand (7-8+) : trop d'arbres → échantillon aléatoire
    const pick = new Set<number>()
    while (pick.size < budget) pick.add(Math.floor(rnd() * trees.length))
    trees = [...pick].map(i => trees[i])
  }
  const perms = permutations(n, Math.max(1, Math.min(o.effort ?? 120, Math.floor(budget / trees.length))), photos.map(ratioOf), rnd)
  const K = o.variety ? 12 : 1
  const top: LayoutResult[] = []
  const avoid = o.avoid ? signature(o.avoid) : null
  for (const perm of perms) {
    const P = perm.map(i => photos[i]), A = P.map(ratioOf)
    for (const shape of trees) {
      const out: PlacedPhoto[] = []
      place(shape, P, A, 0, inner, o.gap, mode, alignW > 0, out)
      const res = scoreLayout(out, inner, o.maxPhotos, o.gap, alignW)
      if (top.length === K && res.score <= top[K - 1].score) continue
      if (avoid && signature(res) === avoid) continue
      top.push(res); top.sort((a, b) => b.score - a.score)
      if (top.length > K) top.pop()
    }
  }
  if (!top.length) return avoidFallback(o)
  const ok = top.filter(t => t.score >= top[0].score - (o.variety ?? 0))
  return ok[Math.floor(rnd() * ok.length)]
}

function avoidFallback(o: SolveOptions) { return solveLayout({ ...o, avoid: undefined }) } // n=1 : une seule disposition possible

// ---- Épingles : l'espace libre autour des photos fixes est découpé en rectangles, remplis chacun par le solver

const hit = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/** Découpe R autour de P (avec `gap`) : bandes pleine largeur d'abord ('h') ou pleine hauteur d'abord ('v') */
function splitAround(R: Rect, P: Rect, gap: number, dir: 'h' | 'v'): Rect[] {
  const E = 1, R2 = R.x + R.width, RB = R.y + R.height, P2 = P.x + P.width, PB = P.y + P.height
  const out: Rect[] = []
  if (dir === 'h') {
    const topH = P.y - gap - R.y, botY = PB + gap, botH = RB - botY, lw = P.x - gap - R.x, rx = P2 + gap, rw = R2 - rx
    const y0 = topH > E ? P.y : R.y, y1 = botH > E ? PB : RB
    if (topH > E) out.push({ x: R.x, y: R.y, width: R.width, height: topH })
    if (botH > E) out.push({ x: R.x, y: botY, width: R.width, height: botH })
    if (lw > E) out.push({ x: R.x, y: y0, width: lw, height: y1 - y0 })
    if (rw > E) out.push({ x: rx, y: y0, width: rw, height: y1 - y0 })
  } else {
    const lw = P.x - gap - R.x, rx = P2 + gap, rw = R2 - rx, topH = P.y - gap - R.y, botY = PB + gap, botH = RB - botY
    const x0 = lw > E ? P.x : R.x, x1 = rw > E ? P2 : R2
    if (lw > E) out.push({ x: R.x, y: R.y, width: lw, height: R.height })
    if (rw > E) out.push({ x: rx, y: R.y, width: rw, height: R.height })
    if (topH > E) out.push({ x: x0, y: R.y, width: x1 - x0, height: topH })
    if (botH > E) out.push({ x: x0, y: botY, width: x1 - x0, height: botH })
  }
  return out
}

function freeRegions(inner: Rect, pins: Rect[], gap: number, dirs: ('h' | 'v')[]): Rect[] {
  const regs = [inner]
  pins.forEach((P, k) => {
    const cx = P.x + P.width / 2, cy = P.y + P.height / 2
    const i = regs.findIndex(R => cx >= R.x && cx <= R.x + R.width && cy >= R.y && cy <= R.y + R.height)
    if (i >= 0) regs.splice(i, 1, ...splitAround(regs[i], P, gap, dirs[k]))
  })
  const minD = 0.12 * Math.min(inner.width, inner.height), grow = (P: Rect): Rect => ({ x: P.x - gap + 0.5, y: P.y - gap + 0.5, width: P.width + 2 * gap - 1, height: P.height + 2 * gap - 1 })
  return regs.filter(r => r.width >= minD && r.height >= minD && r.width * r.height >= 0.03 * inner.width * inner.height && !pins.some(P => hit(r, grow(P))))
}

/** Quotas de photos par région ∝ surface (plus fort reste) */
function quotas(areas: number[], m: number): number[] {
  const tot = areas.reduce((a, b) => a + b, 0), ideal = areas.map(a => (m * a) / tot), q = ideal.map(Math.floor)
  let left = m - q.reduce((a, b) => a + b, 0)
  ideal.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left-- > 0) q[i]++ })
  return q
}

/**
 * Photos épinglées : on teste les 2 façons de découper l'espace libre autour de chaque épingle ×
 * plusieurs répartitions des autres photos dans les régions, puis on garde le meilleur score global.
 * ponytail: rectangles autour des épingles seulement (pas de réagencement qui traverse une épingle) ;
 * beaucoup de photos non épinglées dans une petite zone libre → petites cellules (le score le pénalise).
 */
function solvePinned(o: SolveOptions): LayoutResult {
  const fixed = o.fixed!, ids = new Set(fixed.map(f => f.id))
  const free = o.photos.filter(p => !ids.has(p.id))
  const inner: Rect = { x: o.margin, y: o.margin, width: o.width - 2 * o.margin, height: o.height - 2 * o.margin }
  const alignW = o.alignment ?? 0
  const score = (placed: PlacedPhoto[]) => scoreLayout(placed, inner, o.maxPhotos, o.gap, alignW)
  if (!free.length) return score([...fixed])
  const rnd = mulberry32(o.seed ?? 1)
  const K = Math.min(fixed.length, 3), cands: LayoutResult[] = []
  for (let mask = 0; mask < 1 << K; mask++) {
    const dirs = fixed.map((_, k) => (k < K && (mask >> k) & 1 ? 'v' : 'h') as 'h' | 'v')
    const regs = freeRegions(inner, fixed, o.gap, dirs)
    if (!regs.length) continue
    const q = quotas(regs.map(r => r.width * r.height), free.length)
    const slots = regs.map((r, i) => ({ r, n: q[i] })).filter(x => x.n > 0).sort((a, b) => a.r.width / a.r.height - b.r.width / b.r.height)
    for (let t = 0; t < 4; t++) {
      const order = [...free].sort((a, b) => ratioOf(a) - ratioOf(b))
      if (t) for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]] }
      let i = 0
      const placed = [...fixed]
      for (const { r, n } of slots) {
        const chunk = order.slice(i, i + n); i += n
        placed.push(...solveLayout({ ...o, fixed: undefined, photos: chunk, maxPhotos: n, region: r, effort: 20, budget: 1500, variety: 0, avoid: undefined, seed: (o.seed ?? 1) + t }).photos)
      }
      cands.push(score(placed))
    }
  }
  if (!cands.length) return score([...fixed])
  cands.sort((a, b) => b.score - a.score)
  const avoid = o.avoid ? signature(o.avoid) : null
  const pool = cands.filter(c => signature(c) !== avoid)
  const list = pool.length ? pool : cands
  const ok = list.filter(c => c.score >= list[0].score - (o.variety ?? 0))
  return ok[Math.floor(rnd() * ok.length)]
}
