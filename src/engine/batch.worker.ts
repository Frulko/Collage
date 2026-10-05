import { solveBatch, type BatchOptions } from './batch'
import type { PhotoInput } from './types'

// Calcul hors du thread UI : la page reste réactive et le calcul est annulable (worker.terminate())
self.onmessage = (e: MessageEvent<{ photos: PhotoInput[]; opts: BatchOptions }>) => {
  let last = 0
  const pages = solveBatch(e.data.photos, e.data.opts, d => {
    const now = Date.now()
    if (now - last > 100) { last = now; self.postMessage({ progress: d }) }
  })
  self.postMessage({ pages })
}
