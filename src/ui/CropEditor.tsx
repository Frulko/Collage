import { useEffect, useRef, useState } from 'react'
import { coverCrop } from '../engine/solver'
import type { PlacedPhoto, Rect } from '../engine/types'
import type { Photo } from '../io/loader'

/** Recadrage manuel : glisser pour déplacer, curseur pour zoomer. Le rect de destination reste fixe. */
export default function CropEditor({ photo, placed, onApply, onClose }: { photo: Photo; placed: PlacedPhoto; onApply: (c: Rect) => void; onClose: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const ar = photo.width / photo.height, destAr = placed.width / placed.height
  const init = placed.crop
  const [zoom, setZoom] = useState(Math.min(4, Math.max(1, 1 / Math.max(init.width / coverCrop(ar, destAr).width, 1e-6))))
  const [f, setF] = useState({ x: init.x + init.width / 2, y: init.y + init.height / 2 })
  const crop = coverCrop(ar, destAr, f, zoom)
  const W = 360, H = Math.round(W / destAr)

  useEffect(() => {
    const ctx = ref.current!.getContext('2d')!
    ctx.drawImage(photo.thumb, crop.x * photo.thumb.width, crop.y * photo.thumb.height, crop.width * photo.thumb.width, crop.height * photo.thumb.height, 0, 0, W, H)
  })

  const drag = useRef<{ x: number; y: number } | null>(null)
  return (
    <div className="modal" onClick={onClose}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <canvas ref={ref} width={W} height={H} style={{ cursor: 'grab', touchAction: 'none' }}
          onPointerDown={e => { drag.current = { x: e.clientX, y: e.clientY }; e.currentTarget.setPointerCapture(e.pointerId) }}
          onPointerUp={() => (drag.current = null)}
          onPointerMove={e => {
            if (!drag.current) return
            const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y
            drag.current = { x: e.clientX, y: e.clientY }
            setF(p => ({ x: p.x - (dx / W) * crop.width, y: p.y - (dy / H) * crop.height }))
          }} />
        <label>Zoom <input type="range" min={1} max={4} step={0.01} value={zoom} onChange={e => setZoom(+e.target.value)} /></label>
        <div className="row">
          <button onClick={() => { setZoom(1); setF({ x: 0.5, y: 0.5 }) }}>Réinitialiser</button>
          <button onClick={onClose}>Annuler</button>
          <button className="primary" onClick={() => onApply(crop)}>Appliquer</button>
        </div>
      </div>
    </div>
  )
}
