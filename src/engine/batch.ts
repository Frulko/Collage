import { solveLayout } from './solver'
import type { CropMode, LayoutResult, PhotoInput } from './types'

export type PhotoOrder = 'exif' | 'name' | 'random'
export interface OrderablePhoto extends PhotoInput { name: string; date: number }

export function orderPhotos<T extends OrderablePhoto>(photos: T[], order: PhotoOrder, seed = 1): T[] {
  const p = [...photos]
  if (order === 'name') return p.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  if (order === 'exif') return p.sort((a, b) => a.date - b.date || a.name.localeCompare(b.name, undefined, { numeric: true }))
  let s = seed
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) | 0) >>> 0) / 4294967296
  for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]] }
  return p
}

export interface BatchOptions {
  width: number; height: number; margin: number; gap: number
  maxPhotos: number; minPhotos: number
  cropMode?: CropMode; seed?: number
  alignment?: number
  /** permutations testées par segment candidat (défaut 10 : le batch évalue ~n×max segments) */
  effort?: number
  /** évaluations max par segment candidat (défaut 1500) : borne le temps total quel que soit maxPhotos */
  budget?: number
}
export interface BatchPage { photoIds: string[]; layout: LayoutResult }

const PAGE_COST = 0.9   // coût fixe par page : pousse vers moins de pages (évite 6/6/2)
const MISSING_COST = 1.5 // par photo manquante sous `minPhotos`

/**
 * Optimisation globale : DP sur découpages contigus de la liste ordonnée.
 * cost = Σ_pages [ k·(1 − score) + PAGE_COST + pénalité min ]. Une photo qui dégrade une page
 * passe naturellement sur la suivante, et la fin se rééquilibre (5/5/4 plutôt que 6/6/2).
 * ponytail: contigu seulement (respecte date/nom) ; ajouter un voisinage/échange si on veut réordonner à distance.
 */
export function solveBatch(photos: PhotoInput[], o: BatchOptions, onProgress?: (done: number) => void): BatchPage[] {
  // ponytail: le coût du batch ≈ n × max × budget ; plus d'effort = plus de qualité, linéairement plus de temps
  const n = photos.length
  const max = Math.max(1, o.maxPhotos), kmin = Math.min(Math.max(1, o.minPhotos), max)
  const memo = new Map<number, LayoutResult>()
  const seg = (i: number, k: number) => {
    const key = i * 64 + k
    let r = memo.get(key)
    if (!r) {
      r = solveLayout({ ...o, photos: photos.slice(i, i + k), maxPhotos: max, effort: o.effort ?? 10, budget: o.budget ?? 1500 })
      memo.set(key, r)
    }
    return r
  }
  const cost = new Array(n + 1).fill(Infinity), prev = new Array(n + 1).fill(0)
  cost[0] = 0
  for (let i = 0; i < n; i++) {
    if (cost[i] === Infinity) continue
    for (let k = 1; k <= max && i + k <= n; k++) {
      if (k < kmin && i + k < n) continue // une page sous le minimum n'est tolérée qu'en dernier
      const c = cost[i] + k * (1 - seg(i, k).score) + PAGE_COST + Math.max(0, kmin - k) * MISSING_COST
      if (c < cost[i + k]) { cost[i + k] = c; prev[i + k] = i }
    }
    onProgress?.(i / n)
  }
  const pages: BatchPage[] = []
  for (let e = n; e > 0; e = prev[e]) {
    const s = prev[e]
    pages.unshift({ photoIds: photos.slice(s, e).map(p => p.id), layout: seg(s, e - s) })
  }
  return pages
}
