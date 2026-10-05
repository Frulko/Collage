import { cutSegments } from '../engine/scoring'
import type { LayoutResult, Rect } from '../engine/types'

export interface Format { mmW: number; mmH: number; pxW: number; pxH: number }
type Src = { width: number; height: number } & CanvasImageSource

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

function drawPhoto(ctx: Ctx, p: LayoutResult['photos'][number], img: Src, scale: number, crop?: Rect) {
  const c = crop ?? p.crop
  const x0 = Math.round(p.x * scale), y0 = Math.round(p.y * scale)
  ctx.drawImage(img, c.x * img.width, c.y * img.height, c.width * img.width, c.height * img.height,
    x0, y0, Math.round((p.x + p.width) * scale) - x0, Math.round((p.y + p.height) * scale) - y0)
}

/** traits de coupe : filets fins au centre des gouttières (jamais sur une photo) */
function drawCuts(ctx: Ctx, layout: LayoutResult, scale: number, cutGap: number) {
  if (cutGap * scale < 4) return
  ctx.strokeStyle = '#888'; ctx.lineWidth = Math.max(1, scale * 2)
  for (const c of cutSegments(layout.photos, cutGap)) {
    ctx.beginPath()
    if (c.vertical) { ctx.moveTo(c.pos * scale, c.from * scale); ctx.lineTo(c.pos * scale, c.to * scale) }
    else { ctx.moveTo(c.from * scale, c.pos * scale); ctx.lineTo(c.to * scale, c.pos * scale) }
    ctx.stroke()
  }
}

const fillBg = (ctx: Ctx, bg: string) => { ctx.fillStyle = bg; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height); ctx.imageSmoothingQuality = 'high' }

/** Preview : dessine un layout (en px du format final) à l'échelle `scale`. */
export function drawPage(ctx: Ctx, layout: LayoutResult, scale: number, bg: string, src: (id: string) => Src | undefined, crops: Record<string, Rect> = {}, cutGap = 0) {
  fillBg(ctx, bg)
  for (const p of layout.photos) { const img = src(p.id); if (img) drawPhoto(ctx, p, img, scale, crops[p.id]) }
  drawCuts(ctx, layout, scale, cutGap)
}

/** Rendu pleine résolution (main thread ou worker) : décode les originaux un par un → mémoire bornée à 1 image. */
export async function renderFull(canvas: HTMLCanvasElement | OffscreenCanvas, layout: LayoutResult, files: Map<string, File>, fmt: Format, bg: string, crops: Record<string, Rect>, cutGap = 0) {
  canvas.width = fmt.pxW; canvas.height = fmt.pxH
  const ctx = canvas.getContext('2d') as Ctx
  fillBg(ctx, bg)
  for (const p of layout.photos) {
    const bmp = await createImageBitmap(files.get(p.id)!, { imageOrientation: 'from-image' })
    drawPhoto(ctx, p, bmp, 1, crops[p.id])
    bmp.close()
  }
  drawCuts(ctx, layout, 1, cutGap)
  return canvas
}
