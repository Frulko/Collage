import { zipSync } from 'fflate'
import type { Format } from '../render/render'

export type ImgType = 'jpg' | 'png'

/** JPEG qualité haute + densité JFIF (300 DPI) pour que la borne respecte la taille physique */
export async function encode(c: HTMLCanvasElement | OffscreenCanvas, type: ImgType, fmt: Format, quality = 0.95): Promise<Blob> {
  const mime = type === 'jpg' ? 'image/jpeg' : 'image/png'
  const blob = 'convertToBlob' in c ? await c.convertToBlob({ type: mime, quality })
    : await new Promise<Blob>((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('toBlob'))), mime, quality))
  if (type === 'png') return blob
  const u = new Uint8Array(await blob.arrayBuffer())
  if (u[2] === 0xff && u[3] === 0xe0 && u[6] === 0x4a) { // APP0 JFIF
    const dpi = Math.round(fmt.pxW / (fmt.mmW / 25.4))
    u[13] = 1; u[14] = dpi >> 8; u[15] = dpi & 255; u[16] = dpi >> 8; u[17] = dpi & 255
  }
  return new Blob([u], { type: 'image/jpeg' })
}

export const safeName = (s: string, fallback: string) => s.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-').trim().replace(/^\.+/, '') || fallback

/** Nom personnalisé (nettoyé) ou collage-001 ; `taken` garantit l'unicité */
export function fileName(i: number, t: ImgType, custom?: string, taken = new Set<string>()) {
  const clean = custom?.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-').trim().replace(/^\.+/, '')
  const base = clean || `collage-${String(i + 1).padStart(3, '0')}`
  let name = base, n = 2
  while (taken.has(name.toLowerCase())) name = `${base}-${n++}`
  taken.add(name.toLowerCase())
  return `${name}.${t}`
}

export function download(blob: Blob, name: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob); a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10000)
}

export async function zipBlobs(files: { name: string; blob: Blob }[], folder = 'export') {
  const o: Record<string, Uint8Array> = {}
  for (const f of files) o[folder + '/' + f.name] = new Uint8Array(await f.blob.arrayBuffer())
  return new Blob([zipSync(o, { level: 0 }) as BlobPart], { type: 'application/zip' }) // level 0 : JPEG/PNG déjà compressés
}

/** File System Access API : écrit dans <dossier choisi>/<folder>/ */
export async function saveToFolder(files: { name: string; blob: Blob }[], folder = 'export') {
  const root = await (window as any).showDirectoryPicker({ mode: 'readwrite' })
  const dir = await root.getDirectoryHandle(folder, { create: true })
  for (const f of files) {
    const w = await (await dir.getFileHandle(f.name, { create: true })).createWritable()
    await w.write(f.blob); await w.close()
  }
}
