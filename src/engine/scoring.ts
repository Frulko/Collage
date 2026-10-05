import type { LayoutResult, PlacedPhoto, Rect } from './types'

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/**
 * Score 0..1 (1 = idéal). Pénalités pondérées :
 * crop (0.40) · espaces vides (0.20) · photos trop petites (0.15) · écarts de taille (0.15) · déséquilibre (0.10),
 * pondérés par (1 − alignW), + alignW × lignes de coupe en trop (découpe aux ciseaux).
 * Le nombre de photos par page n'est volontairement pas récompensé ici : c'est le rôle du batch optimizer.
 */
export interface CutSegment { vertical: boolean; pos: number; from: number; to: number }

/** Segments de gouttière (là où passent les ciseaux), déduits des cellules voisines séparées de `gap`. */
export function cutSegments(ph: PlacedPhoto[], gap: number): CutSegment[] {
  const out: CutSegment[] = [], e = 0.51
  for (const a of ph) for (const b of ph) {
    if (a === b) continue
    const A = a.cell, B = b.cell
    const oy0 = Math.max(A.y, B.y), oy1 = Math.min(A.y + A.height, B.y + B.height)
    const ox0 = Math.max(A.x, B.x), ox1 = Math.min(A.x + A.width, B.x + B.width)
    if (Math.abs(B.x - (A.x + A.width) - gap) <= e && oy1 - oy0 > e) out.push({ vertical: true, pos: A.x + A.width + gap / 2, from: oy0, to: oy1 })
    if (Math.abs(B.y - (A.y + A.height) - gap) <= e && ox1 - ox0 > e) out.push({ vertical: false, pos: A.y + A.height + gap / 2, from: ox0, to: ox1 })
  }
  return out
}

/** Nombre de lignes de coupe distinctes (positions fusionnées à `tol` près) */
export function cutLineCount(segs: CutSegment[], tol: number): number {
  let n = 0
  for (const v of [true, false]) {
    const ps = segs.filter(s => s.vertical === v).map(s => s.pos).sort((a, b) => a - b)
    ps.forEach((p, i) => { if (!i || p - ps[i - 1] > tol) n++ })
  }
  return n
}

/** Lignes minimales pour n photos : grille r×c la plus économe */
const minLines = (n: number) => { let m = n - 1; for (let r = 1; r <= n; r++) m = Math.min(m, r + Math.ceil(n / r) - 2); return m }

export function scoreLayout(ph: PlacedPhoto[], inner: Rect, maxPhotos: number, gap = 0, alignW = 0): LayoutResult {
  const n = ph.length
  const innerArea = inner.width * inner.height
  let sum = 0, sumCells = 0, min = Infinity, cx = 0, cy = 0, cropSum = 0, cropMax = 0
  const areas: number[] = []
  for (const p of ph) {
    const a = p.width * p.height
    areas.push(a); sum += a; sumCells += p.cell.width * p.cell.height
    if (a < min) min = a
    cx += a * (p.x + p.width / 2); cy += a * (p.y + p.height / 2)
    cropSum += p.cropLoss; if (p.cropLoss > cropMax) cropMax = p.cropLoss
  }
  const mean = sum / n
  const std = Math.sqrt(areas.reduce((s, a) => s + (a - mean) ** 2, 0) / n)
  const crop = clamp01((0.6 * (cropSum / n) + 0.4 * cropMax) / 0.35)
  const empty = clamp01((1 - sum / sumCells) / 0.3)
  const rel = min / (innerArea / n), abs = min / (innerArea / maxPhotos)
  const small = Math.max(clamp01((0.55 - rel) / 0.55), clamp01((0.5 - abs) / 0.5))
  const sizeVar = clamp01(std / mean / 0.7)
  const d = Math.hypot((cx / sum - (inner.x + inner.width / 2)) / inner.width, (cy / sum - (inner.y + inner.height / 2)) / inner.height)
  const balance = clamp01(d / 0.12)
  let align = 0
  if (alignW > 0 && n > 2) {
    const lb = minLines(n)
    align = clamp01((cutLineCount(cutSegments(ph, gap), inner.width * 0.002) - lb) / Math.max(1, n - 1 - lb))
  }
  // ratios imposés : écart (en log) entre l'aspect de la cellule et le ratio demandé
  let rdev = 0, rn = 0
  for (const p of ph) if (p.ratio) { rn++; rdev += clamp01(Math.abs(Math.log(p.cell.width / p.cell.height / p.ratio)) / 0.2) }
  const score = Math.max(0, 1 - 0.3 * (rn ? rdev / rn : 0) - ((1 - alignW) * (0.4 * crop + 0.2 * empty + 0.15 * small + 0.15 * sizeVar + 0.1 * balance) + alignW * align))
  return { score, photos: ph, breakdown: { crop, empty, small, sizeVar, balance, align } }
}
