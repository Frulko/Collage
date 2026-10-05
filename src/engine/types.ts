export type CropMode = 'cover' | 'contain' | 'minimal'

export interface Rect { x: number; y: number; width: number; height: number }

/** Entrée du solver. `focus` (0..1) = point d'intérêt : branche ici smart crop / détection de visages. */
export interface PhotoInput {
  id: string
  width: number
  height: number
  focus?: { x: number; y: number }
  /** Ratio (l/h) imposé à la cellule de la photo ; la photo est rognée pour le remplir. */
  ratio?: number
}

export interface PlacedPhoto extends Rect {
  id: string
  /** Zone source visible, normalisée 0..1 */
  crop: Rect
  /** Cellule allouée par la partition (>= rect visible en mode contain/minimal) */
  cell: Rect
  /** Fraction de surface d'image supprimée (0..1) */
  cropLoss: number
  /** ratio imposé demandé (écho de PhotoInput.ratio) */
  ratio?: number
}

export interface ScoreBreakdown { crop: number; empty: number; small: number; sizeVar: number; balance: number; align: number }

export interface LayoutResult { score: number; photos: PlacedPhoto[]; breakdown?: ScoreBreakdown }

export interface SolveOptions {
  width: number
  height: number
  photos: PhotoInput[]
  /** Maximum, pas obligation. Si photos.length > maxPhotos, seules les maxPhotos premières sont placées. */
  maxPhotos: number
  margin: number
  gap: number
  cropMode?: CropMode
  seed?: number
  /** Nb max de permutations testées (défaut 120 ; toutes si n! <= effort) */
  effort?: number
  /** 0..1 : importance de la découpe facile (coupes alignées et longues). 0 = off. Aligne aussi exactement les gouttières entre rangées. */
  alignment?: number
  /** Photos épinglées : gardées telles quelles (position, taille, crop) ; les autres s'adaptent autour. */
  fixed?: PlacedPhoto[]
  /** Zone à remplir à la place de la page (usage interne : sous-régions autour des épingles) */
  region?: Rect
  /** Nb max d'évaluations (permutations × arbres) ; au-delà, permutations et arbres sont échantillonnés. Défaut 20000. */
  budget?: number
  /** >0 : choisit aléatoirement parmi les layouts à moins de `variety` du meilleur score (Regenerate/Shuffle) */
  variety?: number
  /** Layout à éviter (Regenerate doit proposer autre chose) */
  avoid?: LayoutResult
}
