import exifr from 'exifr'
import type { OrderablePhoto } from '../engine/batch'
import { kvGet, kvSet } from './session'

export interface Photo extends OrderablePhoto { file: File; thumb: ImageBitmap }
interface Cached { width: number; height: number; date: number; blob: Blob }

const THUMB = 512
const isImage = (f: File) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|avif|gif|bmp)$/i.test(f.name)

/** EXIF : orientation appliquée par createImageBitmap('from-image') ; date réelle via exifr (sinon lastModified). */
async function loadOne(file: File, id: string): Promise<Photo> {
  const hit = await kvGet<Cached>('thumb:' + id)
  if (hit) return { id, name: file.name, file, date: hit.date, width: hit.width, height: hit.height, thumb: await createImageBitmap(hit.blob) }
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const { width, height } = bmp
  const s = Math.min(1, THUMB / Math.max(width, height))
  const thumb = await createImageBitmap(bmp, { resizeWidth: Math.round(width * s), resizeHeight: Math.round(height * s), resizeQuality: 'high' })
  bmp.close()
  let date = file.lastModified
  try {
    const ex = await exifr.parse(file, { pick: ['DateTimeOriginal', 'CreateDate'] })
    const d = ex?.DateTimeOriginal ?? ex?.CreateDate
    if (d instanceof Date && !isNaN(+d)) date = +d
  } catch { /* pas d'EXIF */ }
  const oc = new OffscreenCanvas(thumb.width, thumb.height)
  oc.getContext('2d')!.drawImage(thumb, 0, 0)
  oc.convertToBlob({ type: 'image/jpeg', quality: 0.85 }).then(blob => kvSet('thumb:' + id, { width, height, date, blob }))
  return { id, name: file.name, file, date, width, height, thumb }
}

/** id stable d'une session à l'autre (nom|taille|date) → les collages sauvegardés retrouvent leurs photos */
export function listIds(files: File[]) {
  const list = files.filter(isImage), seen = new Map<string, number>()
  const ids = list.map(f => {
    const base = `${f.name}|${f.size}|${f.lastModified}`, n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n ? `${base}#${n}` : base
  })
  return { list, ids }
}

/** `only` : ne charge que ces ids (synchronisation du dossier : seulement les nouvelles photos) */
export async function loadPhotos(files: File[], onProgress?: (done: number, total: number) => void, only?: Set<string>) {
  const { list, ids } = listIds(files)
  const todo = list.map((_, i) => i).filter(i => !only || only.has(ids[i]))
  const photos: Photo[] = [], failed: string[] = []
  let next = 0, done = 0
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < todo.length) {
      const i = todo[next++]
      try { photos.push(await loadOne(list[i], ids[i])) } catch { failed.push(list[i].name) }
      onProgress?.(++done, todo.length)
    }
  }))
  return { photos, failed }
}

export async function readHandle(dir: any, out: File[] = []): Promise<File[]> {
  for await (const h of dir.values()) {
    if (h.kind === 'file') out.push(await h.getFile())
    else await readHandle(h, out)
  }
  return out
}

export interface Picked { files: File[]; handle?: any }

/** File System Access API si dispo, sinon null (l'UI bascule sur <input webkitdirectory>) */
export async function pickDirectory(): Promise<Picked | null> {
  const w = window as any
  if (!w.showDirectoryPicker) return null
  const handle = await w.showDirectoryPicker({ mode: 'readwrite' })
  return { files: await readHandle(handle), handle }
}

/** Drag & drop de fichiers ou dossiers (handle récupéré si le navigateur le permet) */
export async function filesFromDrop(dt: DataTransfer): Promise<Picked> {
  // ponytail: les items du drop ne sont valides que synchroniquement → on lance tout avant le premier await
  const first: any = dt.items[0]
  const handleP: Promise<any> = first?.getAsFileSystemHandle?.() ?? Promise.resolve(null)
  const entries = [...dt.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean)
  const handle = await handleP.catch(() => null)
  if (handle?.kind === 'directory' && dt.items.length === 1) return { files: await readHandle(handle), handle }
  const out: File[] = []
  const walk = async (e: any): Promise<void> => {
    if (e.isFile) out.push(await new Promise<File>(r => e.file(r)))
    else if (e.isDirectory) {
      const rd = e.createReader()
      for (;;) {
        const batch: any[] = await new Promise(r => rd.readEntries(r))
        if (!batch.length) break
        for (const c of batch) await walk(c)
      }
    }
  }
  if (entries.length) for (const e of entries) await walk(e)
  else out.push(...dt.files)
  return { files: out }
}
