import { encode, type ImgType } from '../export/exporter'
import { renderFull, type Format } from './render'
import type { LayoutResult, Rect } from '../engine/types'

interface Job { index: number; layout: LayoutResult; crops: Record<string, Rect>; files: [string, File][]; fmt: Format; bg: string; cutGap: number; type: ImgType }

// un collage = décodage + dessin + encodage JPEG/PNG, entièrement hors du thread UI
self.onmessage = async (e: MessageEvent<Job>) => {
  const j = e.data
  const canvas = await renderFull(new OffscreenCanvas(1, 1), j.layout, new Map(j.files), j.fmt, j.bg, j.crops, j.cutGap)
  self.postMessage({ index: j.index, blob: await encode(canvas, j.type, j.fmt) })
}
