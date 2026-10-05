import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import CropEditor from './CropEditor'
import Welcome from './Welcome'
import { orderPhotos, type BatchOptions, type BatchPage, type PhotoOrder } from '../engine/batch'
import type { PhotoInput, PlacedPhoto } from '../engine/types'
import { fitPhoto, mulberry32, solveLayout } from '../engine/solver'
import type { CropMode, LayoutResult, Rect } from '../engine/types'
import { filesFromDrop, listIds, loadPhotos, pickDirectory, readHandle, type Photo, type Picked } from '../io/loader'
import { kvClear, kvGet, kvSet } from '../io/session'
import { drawPage, type Format } from '../render/render'
import { download, fileName, safeName, saveToFolder, zipBlobs, type ImgType } from '../export/exporter'

interface Settings {
  preset: '10x15' | 'borne' | 'custom'; landscape: boolean; customW: number; customH: number; dpi: number
  maxPhotos: number; minPhotos: number; margin: number; gap: number; bg: string
  crop: CropMode; order: PhotoOrder; align: number; cuts: boolean
}
const DEFAULTS: Settings = { preset: 'borne', landscape: true, customW: 15, customH: 10, dpi: 300, maxPhotos: 6, minPhotos: 3, margin: 4, gap: 2, bg: '#ffffff', crop: 'cover', order: 'exif', align: 0.2, cuts: false }

interface PageState { photoIds: string[]; layout: LayoutResult; crops: Record<string, Rect>; holes?: Rect[]; ratios?: Record<string, number>; pins?: string[] }
/** `holes` : emplacements vidés par « Enlever » (mise en page conservée) ; `undo` : état avant modification non validée */
interface Page extends PageState { id: number; name?: string; cropMode?: CropMode; notice?: string; undo?: PageState; undoEx?: string[] /* photos qui étaient exclues avant un ajout (remises exclues si on annule) */ }
/** Identifiants déposés (glisser d'une ou plusieurs vignettes de la pellicule) */
const idsOf = (dt: DataTransfer): string[] => {
  try { const j = dt.getData('text/photos'); if (j) return JSON.parse(j) } catch { /* ignore */ }
  const one = dt.getData('text/photo'); return one ? [one] : []
}
const NO_PAGES: Page[] = [], NO_EXCLUDED = new Set<string>()
interface Snap { pages: Page[]; excluded: Set<string>; label: string }
const RATIOS: [string, number][] = [['3:2', 3 / 2], ['2:3', 2 / 3], ['4:3', 4 / 3], ['3:4', 3 / 4], ['1:1', 1], ['16:9', 16 / 9], ['9:16', 9 / 16]]
const origRatio = (ph?: Photo) => (ph ? ph.width / ph.height : 0)
const ratioKey = (r?: number, ph?: Photo) => (!r ? '' : RATIOS.find(x => Math.abs(x[1] - r) < 1e-6)?.[0] ?? (Math.abs(r - origRatio(ph)) < 1e-6 ? 'orig' : ''))
const ratioFromKey = (k: string, ph?: Photo) => (k === 'orig' ? origRatio(ph) : RATIOS.find(x => x[0] === k)?.[1])
/** Photos épinglées du collage (position, taille et recadrage manuel inclus) : gardées telles quelles à chaque recalcul */
const pinsOf = (p: Page) => (p.pins ?? []).flatMap(id => { const x = p.layout.photos.find(y => y.id === id); return x ? [p.crops[id] ? { ...x, crop: p.crops[id] } : x] : [] })
const snap = (p: Page): PageState => p.undo ?? { photoIds: p.photoIds, layout: p.layout, crops: p.crops, holes: p.holes, ratios: p.ratios, pins: p.pins }
interface Saved { project?: string; settings: Settings; excluded: string[]; pages: Page[] }
interface Sel { page: number; photo: string }

function formatOf(s: Settings): Format {
  let [mmW, mmH] = s.preset === 'custom' ? [s.customW * 10, s.customH * 10] : [150, 100]
  if (s.landscape !== mmW >= mmH) [mmW, mmH] = [mmH, mmW]
  const px = (mm: number) => Math.round((mm / 25.4) * s.dpi)
  if (s.preset === 'borne') return s.landscape ? { mmW, mmH, pxW: 1800, pxH: 1200 } : { mmW, mmH, pxW: 1200, pxH: 1800 }
  return { mmW, mmH, pxW: px(mmW), pxH: px(mmH) }
}

const Num = ({ label, value, onChange, min = 0, step = 1 }: { label: string; value: number; onChange: (v: number) => void; min?: number; step?: number }) => (
  <label>{label}<input type="number" min={min} step={step} value={value} onChange={e => onChange(+e.target.value)} /></label>
)

export default function App() {
  const [s, setS] = useState(DEFAULTS)
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS(p => ({ ...p, [k]: v }))
  const [photos, setPhotos] = useState<Photo[]>([])
  const [pages, setPages] = useState<Page[]>(NO_PAGES)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [sel, setSel] = useState<Sel | null>(null)
  const [editing, setEditing] = useState<Sel | null>(null)
  const [drag, setDrag] = useState(false)
  const [project, setProject] = useState('')
  const [showSettings, setShowSettings] = useState(true)
  const [demo, setDemo] = useState(false) // mode démo : photos embarquées, rien n'est sauvegardé
  const [welcome, setWelcome] = useState(true)
  const [autoGen, setAutoGen] = useState(false)
  const pendingName = useRef('')
  const [multi, setMulti] = useState<string[]>([]) // sélection multiple dans la pellicule (⌘/Maj-clic)
  const [overPage, setOverPage] = useState<number | null>(null)
  const lastClick = useRef<string | null>(null)
  const hist = useRef({ tl: [{ pages: NO_PAGES, excluded: NO_EXCLUDED, label: 'Début' }] as Snap[], idx: 0, t: 0, label: '', lt: 0, mode: '' as '' | 'restore' | 'reset' })
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const [save, setSave] = useState<{ st: 'idle' | 'saving' | 'saved' | 'error'; at?: number }>({ st: 'idle' })
  const [excluded, setExcluded] = useState<Set<string>>(NO_EXCLUDED)
  const [stripSel, setStripSel] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'used' | 'free' | 'excluded'>('all')
  const byId = useMemo(() => new Map(photos.map(p => [p.id, p])), [photos])
  const fmt = formatOf(s)
  const pxPerMm = fmt.pxW / fmt.mmW
  const nextId = useRef(1)
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(''), 8000); return () => clearTimeout(t) }, [msg])
  const summary = `${s.preset === 'custom' ? `${s.customW}×${s.customH} cm` : '10×15'} ${s.landscape ? 'paysage' : 'portrait'} · ${fmt.pxW}×${fmt.pxH} · ${s.minPhotos}–${s.maxPhotos} photos · marge ${s.margin} / espace ${s.gap} mm · ${s.crop} · ${s.order === 'exif' ? 'date' : s.order === 'name' ? 'nom' : 'aléatoire'} · découpe ${s.align === 0 ? 'libre' : s.align < 0.5 ? 'facile' : 'max'}`

  const solveOpts = (extra = {}) => ({ width: fmt.pxW, height: fmt.pxH, margin: s.margin * pxPerMm, gap: s.gap * pxPerMm, maxPhotos: s.maxPhotos, cropMode: s.crop, alignment: s.align, ...extra })

  const [resume, setResume] = useState<any>(null)
  useEffect(() => {
    kvGet<Saved>('state').then(v => { if (v) { setS({ ...DEFAULTS, ...v.settings }); setProject(v.project ?? '') } })
    kvGet<any>('dir').then(h => h && setResume(h))
  }, [])

  async function ingest({ files, handle }: Picked, opts: { demo?: boolean } = {}) {
    setBusy('Lecture des photos…'); setSel(null); setStripSel(null)
    const saved = opts.demo ? undefined : await kvGet<Saved>('state') // la démo ne lit ni n'écrase jamais la vraie session
    const { photos: ph, failed } = await loadPhotos(files, (d, t) => setBusy(`Lecture ${d}/${t}…`))
    photos.forEach(p => p.thumb.close())
    const ids = new Set(ph.map(p => p.id))
    // session précédente : on garde les collages dont toutes les photos sont retrouvées
    const keepPages = (ps: Page[]) => ps.filter(p => p.photoIds.every(i => ids.has(i)))
    const keepEx = (e: Iterable<string>) => new Set([...e].filter(i => ids.has(i)))
    let restored = keepPages(saved?.pages ?? []), restoredEx = keepEx(saved?.excluded ?? [])
    // historique sauvegardé : on le reprend (snapshots nettoyés des photos introuvables) ; l'état courant = l'étape où on s'était arrêté
    const sh = opts.demo ? undefined : await kvGet<{ tl: Snap[]; idx: number }>('history')
    if (sh?.tl?.[sh.idx]) {
      const tl = sh.tl.map(x => ({ label: x.label, pages: keepPages(x.pages), excluded: keepEx(x.excluded) }))
      hist.current.tl = tl; hist.current.idx = sh.idx; hist.current.mode = 'restore'
      restored = tl[sh.idx].pages; restoredEx = tl[sh.idx].excluded
      nextId.current = Math.max(nextId.current, ...tl.flatMap(x => x.pages.map(p => p.id + 1)))
    } else {
      hist.current.mode = 'reset'
      nextId.current = Math.max(nextId.current, ...restored.map(p => p.id + 1))
    }
    setPhotos(ph); setPages(restored); setExcluded(restoredEx); setBusy('')
    setDemo(!!opts.demo)
    if (opts.demo) setProject('Démo')
    else if (pendingName.current) { setProject(pendingName.current); pendingName.current = '' }
    else if (saved?.project) setProject(saved.project); else if (handle?.name) setProject(handle.name)
    if (handle && !opts.demo) { kvSet('dir', handle); setResume(handle) }
    navigator.storage?.persist?.() // demande au navigateur de ne pas purger la session
    setMsg(opts.demo ? `Démo : ${ph.length} photos Unsplash chargées` : `${ph.length} photos chargées` + (restored.length ? ` · session restaurée (${restored.length} collages)` : '') + (failed.length ? ` · ${failed.length} illisibles (${failed.slice(0, 3).join(', ')}…)` : ''))
  }
  /** Démo : les 30 photos Unsplash embarquées dans le site (public/demo), puis génération automatique */
  async function loadDemo() {
    setWelcome(false); setBusy('Chargement de la démo…')
    const man: { file: string }[] = await (await fetch('./demo/manifest.json')).json()
    const files = await Promise.all(man.map(async (m, i) => new File([await (await fetch('./demo/' + m.file)).blob()], m.file, { type: 'image/jpeg', lastModified: 1_700_000_000_000 + i * 3_600_000 })))
    setAutoGen(true)
    await ingest({ files }, { demo: true })
  }
  function exitDemo() {
    photos.forEach(p => p.thumb.close())
    if (pages !== NO_PAGES || excluded !== NO_EXCLUDED) hist.current.mode = 'reset'
    setPhotos([]); setPages(NO_PAGES); setExcluded(NO_EXCLUDED); setDemo(false); setProject(''); setMsg(''); setSel(null); setStripSel(null); setMulti([]); setWelcome(true)
  }
  function newProject(name: string) {
    pendingName.current = name.trim(); setWelcome(false)
    if (name.trim()) setProject(name.trim())
    run(choose)
  }
  async function resumeSession() {
    if ((await resume.requestPermission({ mode: 'readwrite' })) !== 'granted') return
    setBusy('Lecture du dossier…')
    await ingest({ files: await readHandle(resume), handle: resume })
  }
  // sauvegarde auto (debounce) : réglages, exclusions, collages
  useEffect(() => {
    if (!photos.length || demo) return
    setSave(v => ({ ...v, st: 'saving' }))
    const t = setTimeout(async () => {
      const ok = await kvSet('state', { project, settings: s, excluded: [...excluded], pages })
      // l'historique partage les mêmes objets (clone structuré) : peu de place en plus
      await kvSet('history', { tl: hist.current.tl, idx: hist.current.idx })
      setSave({ st: ok ? 'saved' : 'error', at: Date.now() })
    }, 400)
    return () => clearTimeout(t)
  }, [demo, project, s, excluded, pages, photos.length, hist.current.idx, hist.current.tl.length])
  // démo : génération automatique dès que les photos sont chargées
  useEffect(() => { if (autoGen && photos.length && !busy) { setAutoGen(false); run(generate) } }, [autoGen, photos, busy])
  useEffect(() => { document.title = project.trim() || 'Collage' }, [project])
  async function choose() {
    try { const f = await pickDirectory(); if (f) return ingest(f) } catch { return } // annulé
    folderInput.current?.click()
  }
  const folderInput = useRef<HTMLInputElement>(null)
  const syncRef = useRef(false) // le prochain choix de dossier (input classique) sert à synchroniser, pas à recharger
  const exRef = useRef(excluded); exRef.current = excluded

  /** Synchronise avec le dossier : les NOUVELLES photos sont ajoutées à la pellicule, inactives (exclues) : à activer à la main. Rien d'autre ne bouge. */
  async function doSync(files: File[]) {
    setBusy('Synchronisation…')
    const { ids } = listIds(files), have = new Set(photos.map(p => p.id)), onDisk = new Set(ids)
    const fresh = new Set(ids.filter(i => !have.has(i)))
    const { photos: added, failed } = await loadPhotos(files, (d, t) => setBusy(`Synchronisation ${d}/${t}…`), fresh)
    const missing = photos.filter(p => !onDisk.has(p.id)).length
    if (added.length) {
      const addedIds = added.map(p => p.id)
      // ces photos n'existaient pas avant : elles sont inactives dans tout l'historique (annuler ne les active pas)
      const nx = new Set([...exRef.current, ...addedIds]), h = hist.current
      h.tl = h.tl.map((sn, i) => ({ ...sn, excluded: i === h.idx ? nx : new Set([...sn.excluded, ...addedIds]) }))
      setPhotos(ps => [...ps, ...added]); setExcluded(nx)
    }
    setBusy('')
    setMsg((added.length ? `Sync : ${added.length} nouvelle(s) photo(s) ajoutée(s) à la pellicule (inactives, ↺ pour les utiliser)` : 'Sync : aucune nouvelle photo')
      + (missing ? ` · ${missing} fichier(s) introuvable(s) dans le dossier` : '') + (failed.length ? ` · ${failed.length} illisible(s)` : ''))
  }
  async function syncFolder() {
    try {
      if (resume) {
        if ((await resume.requestPermission({ mode: 'readwrite' })) !== 'granted') return
        return doSync(await readHandle(resume))
      }
      const f = await pickDirectory()
      if (f) { if (f.handle) { kvSet('dir', f.handle); setResume(f.handle) } return doSync(f.files) }
    } catch { return } // annulé
    syncRef.current = true
    folderInput.current?.click()
  }

  // ---- Historique global (collages + exclusions) : timeline de snapshots immuables
  const note = (label: string) => { hist.current.label = label; hist.current.lt = Date.now() } // nomme la prochaine modification
  useEffect(() => {
    const h = hist.current, cur = h.tl[h.idx]
    if (h.mode) {
      if (h.mode === 'reset') { h.tl = [{ pages, excluded, label: 'Début' }]; h.idx = 0 }
      h.mode = ''; bump(); return
    }
    if (cur.pages === pages && cur.excluded === excluded) return
    const now = Date.now()
    const snap: Snap = { pages, excluded, label: h.label && now - h.lt < 3000 ? h.label : 'Modification' }
    h.label = ''
    // frappe / rafale de la MÊME action (ex. renommer) : une seule entrée ; deux actions différentes restent distinctes
    if (snap.label === cur.label && now - h.t < 1500 && h.idx > 0 && h.idx === h.tl.length - 1) h.tl[h.idx] = snap
    else { h.tl = [...h.tl.slice(0, h.idx + 1), snap].slice(-60); h.idx = h.tl.length - 1 }
    h.t = now; bump()
  }, [pages, excluded])
  function jump(i: number) {
    const h = hist.current, t = h.tl[i]
    if (!t || i === h.idx) return
    h.idx = i
    if (t.pages !== pages || t.excluded !== excluded) { h.mode = 'restore'; setPages(t.pages); setExcluded(t.excluded) }
    setSel(null); setStripSel(null); setMulti([]); setEditing(null); bump()
  }

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !(e.target as HTMLElement).closest('input, select, textarea')) {
        const k = e.key.toLowerCase()
        if (k === 'z') { e.preventDefault(); jump(hist.current.idx + (e.shiftKey ? 1 : -1)) }
        if (k === 'y') { e.preventDefault(); jump(hist.current.idx + 1) }
      }
      if (e.key === 'Escape') { // marche aussi quand le focus est dans un champ / sélecteur
        (document.activeElement as HTMLElement | null)?.blur?.()
        if (editing) setEditing(null); else { setSel(null); setStripSel(null); setMulti([]) }
        return
      }
      if ((e.target as HTMLElement).closest('input, select, textarea')) return
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); removeFromPage(sel.page, sel.photo) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  const workerRef = useRef<Worker | null>(null)
  /** Calcul dans un Web Worker : UI réactive, progression, annulable */
  function runBatch(list: PhotoInput[], opts: BatchOptions, label: string) {
    return new Promise<BatchPage[]>((resolve, reject) => {
      const w = new Worker(new URL('../engine/batch.worker.ts', import.meta.url), { type: 'module' })
      workerRef.current = w
      w.onmessage = e => {
        if (e.data.pages) { w.terminate(); workerRef.current = null; resolve(e.data.pages) }
        else setBusy(`${label} ${Math.round(e.data.progress * 100)}%`)
      }
      w.onerror = e => { w.terminate(); workerRef.current = null; reject(new Error(e.message)) }
      // objets légers uniquement (pas de File/ImageBitmap) vers le worker
      w.postMessage({ photos: list.map(({ id, width, height, focus }) => ({ id, width, height, focus })), opts })
    })
  }
  const poolRef = useRef<Worker[]>([])
  function cancel() { workerRef.current?.terminate(); workerRef.current = null; poolRef.current.forEach(w => w.terminate()); poolRef.current = []; setBusy('') }

  /** Pool de workers : N collages rendus + encodés en parallèle (OffscreenCanvas). 4 max : chaque worker décode des originaux de plusieurs dizaines de Mo. */
  function renderPool(list: Page[], type: ImgType) {
    const files = new Map(photos.map(p => [p.id, p.file]))
    const n = Math.min(list.length, Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1)))
    const results: Blob[] = new Array(list.length)
    let next = 0, done = 0
    return new Promise<Blob[]>((resolve, reject) => {
      const ws = Array.from({ length: n }, () => new Worker(new URL('../render/export.worker.ts', import.meta.url), { type: 'module' }))
      poolRef.current = ws
      const end = () => { ws.forEach(w => w.terminate()); poolRef.current = [] }
      const feed = (w: Worker) => {
        if (next >= list.length) return
        const i = next++, p = list[i]
        w.postMessage({ index: i, layout: p.layout, crops: p.crops, files: p.layout.photos.map(ph => [ph.id, files.get(ph.id)]), fmt, bg: s.bg, cutGap: s.cuts ? s.gap * pxPerMm : 0, type })
      }
      ws.forEach(w => {
        w.onmessage = e => {
          results[e.data.index] = e.data.blob
          setBusy(`Rendu ${++done}/${list.length}…`)
          if (done === list.length) { end(); resolve(results) } else feed(w)
        }
        w.onerror = e => { end(); reject(new Error(e.message)) }
        feed(w)
      })
    })
  }

  /**
   * Générer = tout recalculer SAUF : les photos exclues/retirées (ignorées) et les collages contenant des épingles
   * (conservés, réagencés autour des photos épinglées). Les autres photos sont redistribuées dans de nouveaux collages
   * qui prennent la place des anciens, dans l'ordre.
   */
  async function generate() {
    setBusy('Calcul 0%'); setSel(null); setStripSel(null)
    const anchors = pages.filter(p => p.pins?.length)
    const anchored = new Set(anchors.flatMap(p => p.photoIds))
    const pool = orderPhotos(photos.filter(p => !excluded.has(p.id) && !anchored.has(p.id)), s.order, Date.now())
    const res = pool.length ? await runBatch(pool, { ...solveOpts(), minPhotos: s.minPhotos, effort: 30 }, 'Calcul') : []
    const fresh: Page[] = res.map(r => ({ id: nextId.current++, photoIds: r.photoIds, layout: r.layout, crops: {} }))
    const kept = new Map(anchors.map(p => [p.id, {
      ...p, undo: undefined, notice: undefined, holes: undefined, crops: {},
      layout: resolve(p.photoIds, { seed: Date.now() & 0xffff, variety: 0.03, avoid: p.layout }, p.cropMode, p.ratios, pinsOf(p)),
    } as Page]))
    // les anciens collages sans épingle sont remplacés, dans l'ordre, par les nouveaux ; le reste est ajouté à la fin
    let n = 0
    const merged = pages.flatMap(p => kept.get(p.id) ?? (n < fresh.length ? [fresh[n++]] : []))
    note('Génération'); setShowSettings(false)
    setPages([...merged, ...fresh.slice(n)])
    if (anchors.length) setMsg(`${anchors.length} collage(s) avec épingles conservés · ${excluded.size} photo(s) exclue(s) ignorée(s)`)
    setBusy('')
  }

  const patch = (id: number, f: (p: Page) => Page) => setPages(ps => ps.map(p => (p.id === id ? f(p) : p)))
  const resolve = (ids: string[], extra = {}, cm?: CropMode, ratios?: Record<string, number>, fixed?: PlacedPhoto[]) =>
    solveLayout({ ...solveOpts({ maxPhotos: Math.max(s.maxPhotos, ids.length), ...(cm && { cropMode: cm }), ...extra }), fixed, photos: ids.map(i => ({ ...byId.get(i)!, ratio: ratios?.[i] })), effort: 60 })

  function regenerate(p: Page) {
    note('Regenerate')
    patch(p.id, q => ({ ...q, crops: {}, holes: undefined, layout: resolve(q.photoIds, { seed: Date.now() & 0xffff, variety: 0.03, avoid: q.layout }, q.cropMode, q.ratios, pinsOf(q)) }))
  }
  function shuffle(p: Page) {
    note('Shuffle')
    const rnd = mulberry32(Date.now() & 0xffff), ids = [...p.photoIds]
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]] }
    patch(p.id, q => ({ ...q, photoIds: ids, crops: {}, holes: undefined, layout: resolve(ids, { seed: Date.now() & 0xffff, variety: 0.15, avoid: q.layout }, q.cropMode, q.ratios, pinsOf(q)) }))
  }
  const usedIn = useMemo(() => {
    const m = new Map<string, number>()
    pages.forEach((p, i) => p.photoIds.forEach(id => m.set(id, i)))
    return m
  }, [pages])
  const statusOf = (id: string) => (excluded.has(id) ? 'excluded' : usedIn.has(id) ? 'used' : 'free')
  const freeIds = photos.filter(p => statusOf(p.id) === 'free').map(p => p.id)

  /** Pose `newId` sur la cellule `cellId` ; si elle était déjà dans un collage, les deux photos s'échangent, sinon l'ancienne redevient libre */
  function assign(pageId: number, cellId: string, newId: string) {
    if (isPinned(pageId, cellId)) return setMsg('Photo épinglée : désépinglez-la (📌) pour la remplacer')
    note('Photo remplacée / échangée')
    if (cellId === newId) return
    setExcluded(e => { const n = new Set(e); n.delete(newId); return n })
    setPages(ps => {
      const other = ps.find(p => p.photoIds.includes(newId))
      return ps.map(p => {
        if (p.id !== pageId && p.id !== other?.id) return p
        const ids = p.photoIds.map(i => (p.id === pageId && i === cellId ? newId : other && p.id === other.id && i === newId ? cellId : i))
        return { ...p, photoIds: ids, crops: {}, holes: undefined, layout: resolve(ids, {}, p.cropMode, p.ratios, pinsOf(p)) }
      })
    })
    setSel(null); setStripSel(null)
  }
  /** Enlève sans recalculer : la mise en page reste, l'emplacement devient vide (Réadapter / Garder / Annuler dans la carte) */
  function removeFromPage(pageId: number, photoId: string) {
    note('Photo enlevée')
    setExcluded(e => new Set(e).add(photoId)) // retirée = exclue : les prochaines générations l'ignorent (↺ dans la pellicule pour la réintégrer)
    setPages(ps => ps.flatMap(p => {
      if (p.id !== pageId) return [p]
      const ids = p.photoIds.filter(i => i !== photoId)
      if (!ids.length) return []
      const gone = p.layout.photos.find(x => x.id === photoId)
      return [{ ...p, undo: snap(p), pins: p.pins?.filter(i => i !== photoId), photoIds: ids, holes: [...(p.holes ?? []), ...(gone ? [gone.cell] : [])],
        layout: { ...p.layout, photos: p.layout.photos.filter(x => x.id !== photoId) } }]
    }))
    setSel(null)
  }
  /** Ajoute une ou plusieurs photos : remplit d'abord les emplacements vides tels quels, puis recalcule le collage (annulable). Peut dépasser « Photos max ». */
  function addMany(pageId: number, ids: string[]) {
    const page = pages.find(x => x.id === pageId)
    if (!page) return
    const list = [...new Set(ids)].filter(i => byId.has(i) && usedIn.get(i) === undefined)
    if (!list.length) return setMsg('Ces photos sont déjà dans un collage : utilisez Remplacer pour les déplacer')
    note(list.length > 1 ? `${list.length} photos ajoutées` : 'Photo ajoutée')
    const wasEx = list.filter(i => excluded.has(i))
    patch(pageId, p => {
      let q: Page = { ...p, undoEx: [...(p.undoEx ?? []), ...wasEx] }
      const rest = [...list]
      while (q.holes?.length && rest.length) q = fillHole(q, 0, rest.shift()!)
      if (rest.length) {
        const all = [...q.photoIds, ...rest]
        q = { ...q, undo: snap(q), photoIds: all, crops: {}, holes: undefined, layout: resolve(all, {}, q.cropMode, q.ratios, pinsOf(q)) }
      }
      return q
    })
    setExcluded(e => { const n = new Set(e); list.forEach(i => n.delete(i)); return n })
    setMulti([]); setStripSel(null)
    if (list.length < ids.length) setMsg(`${ids.length - list.length} photo(s) ignorée(s) (déjà dans un collage)`)
  }
  function fillHole(p: Page, idx: number, photoId: string): Page {
    const ph = byId.get(photoId)!, hole = p.holes![idx]
    const holes = p.holes!.filter((_, i) => i !== idx)
    return { ...p, undo: snap(p), photoIds: [...p.photoIds, photoId], holes: holes.length ? holes : undefined,
      layout: { ...p.layout, photos: [...p.layout.photos, fitPhoto(ph, hole, p.cropMode ?? s.crop)] } }
  }
  function pickHole(pageId: number, idx: number, photoId = stripSel) {
    if (!photoId || statusOf(photoId) === 'used') return setMsg('Choisissez une photo libre dans la pellicule pour remplir l’emplacement')
    note('Emplacement rempli')
    patch(pageId, p => fillHole(p, idx, photoId))
    setExcluded(e => { const n = new Set(e); n.delete(photoId); return n })
    setStripSel(null)
  }
  /** Réserve un emplacement vide : le collage est recalculé avec une photo fantôme 3:2 (plus les vides déjà présents), puis on en extrait les trous */
  function addEmpty(p: Page) {
    note('Emplacement vide ajouté')
    patch(p.id, q => {
      const ghosts: PhotoInput[] = [...(q.holes ?? []), { x: 0, y: 0, width: 3, height: 2 }].map((h, i) => ({ id: '__empty__' + i, width: h.width, height: h.height }))
      const photos = [...q.photoIds.map(i => ({ ...byId.get(i)!, ratio: q.ratios?.[i] })), ...ghosts]
      const res = solveLayout({ ...solveOpts({ effort: 60, cropMode: q.cropMode ?? s.crop }), fixed: pinsOf(q), maxPhotos: photos.length, photos })
      return { ...q, undo: snap(q), crops: {}, holes: res.photos.filter(x => x.id.startsWith('__empty__')).map(x => x.cell),
        layout: { ...res, photos: res.photos.filter(x => !x.id.startsWith('__empty__')) } }
    })
  }
  /** Collage manuel : vide, ou avec la photo donnée (sélectionnée / déposée) */
  function newPage(ids: string[] = []) {
    const list = [...new Set(ids)].filter(i => byId.has(i) && usedIn.get(i) === undefined)
    if (ids.length && !list.length) return setMsg('Ces photos sont déjà dans un collage : utilisez Remplacer')
    note('Nouveau collage')
    const id = nextId.current++
    setPages(ps => [...ps, { id, photoIds: list, crops: {}, layout: list.length ? resolve(list) : { score: 0, photos: [] } }])
    if (list.length) { setExcluded(e => { const n = new Set(e); list.forEach(i => n.delete(i)); return n }); setStripSel(null); setMulti([]) }
    setTimeout(() => document.getElementById('page-' + id)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50)
  }
  const isPinned = (pageId: number, id: string) => !!pages.find(x => x.id === pageId)?.pins?.includes(id)
  function togglePin(p: Page, id: string) {
    note(p.pins?.includes(id) ? 'Photo désépinglée' : 'Photo épinglée')
    patch(p.id, q => ({ ...q, pins: q.pins?.includes(id) ? q.pins.filter(i => i !== id) : [...(q.pins ?? []), id] }))
  }
  /** Mode de crop propre à ce collage (recalcule ce collage seul ; annulable) */
  const setPageCrop = (p: Page, mode: CropMode | '') => (note('Mode de crop'), patch(p.id, q => ({
    ...q, undo: snap(q), cropMode: mode || undefined, crops: {}, holes: undefined, layout: resolve(q.photoIds, {}, mode || undefined, q.ratios, pinsOf(q)) })))
  /** Impose un ratio à la cellule d'une photo. Si le collage ne peut plus l'accueillir (photos trop petites / trop rognées), elles sortent vers la pellicule. */
  function setRatio(p: Page, photoId: string, ratio?: number) {
    if (p.pins?.includes(photoId)) return setMsg('Photo épinglée : désépinglez-la (📌) pour changer son ratio')
    note('Ratio d’une photo')
    const ratios = { ...p.ratios }
    if (ratio) ratios[photoId] = ratio; else delete ratios[photoId]
    let ids = [...p.photoIds]
    const inner = (fmt.pxW - 2 * s.margin * pxPerMm) * (fmt.pxH - 2 * s.margin * pxPerMm)
    let res = resolve(ids, {}, p.cropMode, ratios, pinsOf(p))
    const out: string[] = []
    while (ids.length > 1) {
      // pire photo (hors celle réglée) : surface < 40 % de la moyenne ou > 50 % de l'image rognée
      const bad = res.photos.filter(x => x.id !== photoId && !p.pins?.includes(x.id) && (x.cropLoss > 0.5 || (x.width * x.height) / (inner / ids.length) < 0.4))
        .sort((a, b) => a.width * a.height - b.width * b.height)[0]
      if (!bad) break
      out.push(bad.id); ids = ids.filter(i => i !== bad.id); delete ratios[bad.id]
      res = resolve(ids, {}, p.cropMode, ratios, pinsOf(p))
    }
    const names = out.map(i => byId.get(i)?.name ?? i)
    const k = pages.findIndex(x => x.id === p.id) + 1
    patch(p.id, q => ({ ...q, undo: snap(q), photoIds: ids, ratios, crops: {}, holes: undefined, layout: res,
      notice: out.length ? `${out.length} photo(s) sortie(s) → pellicule : ${names.join(', ')}` : undefined }))
    if (out.length) setMsg(`Collage ${k} : ${out.length} photo(s) ne rentrent plus et repartent dans la pellicule (${names.slice(0, 3).join(', ')}${out.length > 3 ? '…' : ''})`)
    setSel(null)
  }
  const readapt = (p: Page) => (note('Collage réadapté'), patch(p.id, q => ({ ...q, holes: undefined, crops: {}, layout: resolve(q.photoIds, {}, q.cropMode, q.ratios, pinsOf(q)) })))
  const keep = (p: Page) => (note('Modification validée'), patch(p.id, q => ({ ...q, undo: undefined, notice: undefined, undoEx: undefined })))
  function cancelEdit(p: Page) {
    note('Modification annulée')
    if (!p.undo) return
    const u = p.undo
    const wasEx = p.undoEx ?? []
    patch(p.id, q => ({ ...q, ...u, undo: undefined, notice: undefined, undoEx: undefined }))
    setExcluded(e => { const n = new Set(e); u.photoIds.forEach(i => n.delete(i)); wasEx.forEach(i => n.add(i)); return n })
    setSel(null)
  }
  function toggleExclude(id: string) {
    note('Photo exclue / réintégrée')
    const used = usedIn.get(id)
    if (!excluded.has(id) && used !== undefined) { removeFromPage(pages[used].id, id); return } // retirer = exclure (déjà fait par removeFromPage)
    setExcluded(e => { const n = new Set(e); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  async function placeFree() {
    setBusy('Calcul 0%')
    const ordered = orderPhotos(photos.filter(p => freeIds.includes(p.id)), s.order, Date.now())
    const res = await runBatch(ordered, { ...solveOpts(), minPhotos: Math.min(s.minPhotos, ordered.length), effort: 30 }, 'Calcul')
    note('Photos libres placées')
    setPages(ps => [...ps, ...res.map(r => ({ id: nextId.current++, photoIds: r.photoIds, layout: r.layout, crops: {} }))])
    setBusy('')
  }
  /** ⌘/Ctrl-clic : ajoute/retire de la sélection · Maj-clic : plage · clic : une seule photo */
  function clickFrame(e: React.MouseEvent, id: string, shown: Photo[]) {
    if (e.metaKey || e.ctrlKey) {
      setSel(null); setStripSel(null); lastClick.current = id
      return setMulti(m => (m.includes(id) ? m.filter(x => x !== id) : [...m, id]))
    }
    if (e.shiftKey && lastClick.current) {
      const a = shown.findIndex(p => p.id === lastClick.current), b = shown.findIndex(p => p.id === id)
      if (a >= 0 && b >= 0) { setSel(null); setStripSel(null); return setMulti(shown.slice(Math.min(a, b), Math.max(a, b) + 1).map(p => p.id)) }
    }
    lastClick.current = id; setMulti([]); pickStrip(id)
  }
  function pickStrip(id: string) {
    setSel(null)
    setStripSel(cur => (cur === id ? null : id))
    const used = usedIn.get(id)
    if (used !== undefined) document.getElementById('page-' + pages[used].id)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  function clickPhoto(page: number, photo: string) {
    if (stripSel) return assign(page, photo, stripSel)
    if (sel && sel.photo !== photo && (isPinned(page, photo) || isPinned(sel.page, sel.photo))) return setMsg('Photo épinglée : désépinglez-la (📌) pour l’échanger')
    if (!sel) return setSel({ page, photo })
    if (sel.page === page && sel.photo === photo) return setSel(null)
    note('Photos échangées')
    // échange entre deux cellules (même page ou pages différentes) puis recalcul des pages touchées
    setPages(ps => ps.map(p => {
      if (p.id !== sel.page && p.id !== page) return p
      const ids = p.photoIds.map(i => (p.id === sel.page && i === sel.photo ? photo : p.id === page && i === photo ? sel.photo : i))
      return { ...p, photoIds: ids, crops: {}, layout: resolve(ids, {}, p.cropMode, p.ratios, pinsOf(p)) }
    }))
    setSel(null)
  }

  const projectName = safeName(project, 'export')
  async function exportPages(list: Page[], type: ImgType, target: 'zip' | 'folder' | 'files', startIdx = 0) {
    setBusy(`Rendu 0/${list.length}…`)
    const blobs = await renderPool(list, type)
    const taken = new Set<string>()
    const files = blobs.map((blob, i) => ({ name: fileName(startIdx + i, type, list[i].name, taken), blob }))
    setBusy('Écriture…')
    if (target === 'zip') download(await zipBlobs(files, projectName), `${projectName}${type === 'png' ? '-png' : ''}.zip`)
    else if (target === 'folder') await saveToFolder(files, projectName)
    else files.forEach(f => download(f.blob, f.name))
    setBusy('')
  }
  const run = (f: () => Promise<void>) => f().catch(e => { setBusy(''); if (e?.name !== 'AbortError') setMsg('Erreur : ' + e?.message) })

  const pickIds = multi.length ? multi : stripSel ? [stripSel] : []
  const shown = photos.filter(p => filter === 'all' || statusOf(p.id) === filter)
  const exportable = pages.filter(p => p.layout.photos.length) // un collage manuel encore vide n'est pas exporté
  const editPage = editing && pages.find(p => p.id === editing.page)
  const editPlaced = editPage?.layout.photos.find(p => p.id === editing!.photo)

  return (
    <div className={'app' + (drag ? ' drag' : '')}
      onDragOver={e => { if (e.dataTransfer.types.includes('text/photo')) return; e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)}
      onDrop={e => { if (e.dataTransfer.types.includes('text/photo')) return; e.preventDefault(); setDrag(false); run(async () => ingest(await filesFromDrop(e.dataTransfer))) }}>
      <div className="top">
      <div className="row1">
        <h1>Collage</h1>
        <input className="project" value={project} placeholder="Nom du projet" title="Nom du projet : titre, ZIP et dossier d'export" onChange={e => setProject(e.target.value)} />
        <button className="primary" onClick={() => run(choose)}>Choisir un dossier</button>
        <input ref={folderInput} type="file" multiple hidden accept="image/*" {...{ webkitdirectory: '' }} onChange={e => { const f = [...(e.target.files ?? [])]; e.target.value = ''; run(() => (syncRef.current ? ((syncRef.current = false), doSync(f)) : ingest({ files: f }))) }} />
        <label className="btn">Fichiers…<input type="file" multiple hidden accept="image/*" onChange={e => run(() => ingest({ files: [...(e.target.files ?? [])] }))} /></label>
        {resume && !photos.length && <button onClick={() => run(resumeSession)}>Reprendre : {resume.name}</button>}
        {!photos.length && !welcome && <button title="Démo, nouveau projet ou reprise" onClick={() => setWelcome(true)}>Accueil</button>}
        {photos.length > 0 && !demo && <button title="Resynchronise avec le dossier : les nouvelles photos sont ajoutées à la pellicule, inactives" onClick={() => run(syncFolder)}>⟳ Sync</button>}
        {!demo && (resume || photos.length > 0) && <button title="Oublier le dossier, les miniatures et les collages sauvegardés" onClick={() => { kvClear(); setResume(null); setMsg('Session oubliée') }}>Oublier</button>}
        {photos.length > 0 && (() => {
          const { tl, idx } = hist.current
          return <>
            <span className="sep" />
            <button className="icon" disabled={idx === 0} title={idx ? `Annuler : ${tl[idx].label} (⌘Z)` : 'Annuler (⌘Z)'} onClick={() => jump(idx - 1)}>↩</button>
            <button className="icon" disabled={idx >= tl.length - 1} title={idx < tl.length - 1 ? `Rétablir : ${tl[idx + 1].label} (⇧⌘Z)` : 'Rétablir (⇧⌘Z)'} onClick={() => jump(idx + 1)}>↪</button>
            <details className="hist"><summary>Historique ({tl.length - 1})</summary>
              <ul>{tl.map((x, i) => ({ x, i })).reverse().map(({ x, i }) => (
                <li key={i} className={i === idx ? 'cur' : i > idx ? 'future' : ''} onClick={e => { jump(i); (e.currentTarget.closest('details') as HTMLDetailsElement).open = false }}>{x.label}</li>
              ))}</ul></details>
          </>
        })()}
        <span className="spacer" />
        {demo && <span className="chip demo" title="Les photos viennent de la démo ; rien n’est écrit dans votre navigateur">🎞 Mode démo · rien n’est sauvegardé <button onClick={exitDemo}>Quitter</button></span>}
        {!photos.length && !msg && <span className="muted">Glissez un dossier ici — rien n’est envoyé sur un serveur</span>}
        {(sel || stripSel || multi.length > 0) && (() => {
          const many = !sel && multi.length > 0
          const name = many ? `${multi.length} photos` : byId.get(sel?.photo ?? stripSel!)?.name ?? ''
          const where = sel ? `collage ${pages.findIndex(x => x.id === sel.page) + 1}` : many ? 'pellicule → glissez-les sur un collage' : 'pellicule → cliquez une photo d’un collage'
          return <span className="chip" title={`Sélection : ${name} (${where})`}>📍 <b>{name}</b> <i>{where}</i>
            <button onClick={() => { setSel(null); setStripSel(null); setMulti([]) }}>✕ Échap</button></span>
        })()}
        {!demo && save.st !== 'idle' && (
          <span className={'save ' + save.st} title="La session (collages, réglages, exclusions) est enregistrée automatiquement dans ce navigateur">
            {save.st === 'saving' ? '● Enregistrement…' : save.st === 'saved' ? `✓ ${new Date(save.at!).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : '⚠ Sauvegarde impossible'}
          </span>
        )}
      </div>

      <div className="row2">
        <button className={showSettings ? 'on' : ''} onClick={() => setShowSettings(v => !v)}>⚙ Réglages {showSettings ? '▴' : '▾'}</button>
        <span className="summary" title="Réglages actuels">{summary}</span>
        <button className="primary" disabled={!photos.length || !!busy} onClick={() => run(generate)} title="Recalcule tout, sauf les collages avec épingles (conservés) ; les photos exclues sont ignorées">Générer</button>
        {!!photos.length && <span className="muted">{photos.length} photos</span>}
        {!!pages.length && <>
          <span className="sep" />
          <strong>{pages.length} collages</strong>
          <button className="primary" disabled={!!busy} onClick={() => run(() => exportPages(exportable, 'jpg', 'zip'))}>Exporter ZIP JPEG</button>
          <button disabled={!!busy} onClick={() => run(() => exportPages(exportable, 'png', 'zip'))}>ZIP PNG</button>
          {'showDirectoryPicker' in window && <button disabled={!!busy} onClick={() => run(() => exportPages(exportable, 'jpg', 'folder'))}>Dossier…</button>}
          {!!freeIds.length && <button disabled={!!busy} onClick={() => run(placeFree)}>Placer {freeIds.length} libres</button>}
          {pages.some(p => p.holes?.length) && <span className="sel" title="Les emplacements vides seront blancs à l’export">⚠ {pages.filter(p => p.holes?.length).length} vide(s)</span>}
        </>}
        {busy && <span className="busy">{busy} {(workerRef.current || poolRef.current.length > 0) && <button onClick={cancel}>Annuler</button>}</span>}
      </div>

      {showSettings && <section className="settings">
        <label>Format
          <select value={s.preset} onChange={e => set('preset', e.target.value as Settings['preset'])}>
            <option value="borne">10×15 — 1800×1200 (borne)</option>
            <option value="10x15">10×15 — dpi exact</option>
            <option value="custom">Personnalisé</option>
          </select></label>
        <label>Orientation
          <select value={s.landscape ? 'l' : 'p'} onChange={e => set('landscape', e.target.value === 'l')}><option value="l">Paysage</option><option value="p">Portrait</option></select></label>
        {s.preset === 'custom' && <><Num label="Largeur cm" value={s.customW} onChange={v => set('customW', v)} step={0.1} /><Num label="Hauteur cm" value={s.customH} onChange={v => set('customH', v)} step={0.1} /></>}
        {s.preset !== 'borne' && <Num label="DPI" value={s.dpi} onChange={v => set('dpi', v)} min={72} />}
        <Num label="Photos max" value={s.maxPhotos} onChange={v => set('maxPhotos', Math.max(1, Math.min(8, v)))} min={1} />
        <Num label="Photos min" value={s.minPhotos} onChange={v => set('minPhotos', v)} min={1} />
        <Num label="Marge mm" value={s.margin} onChange={v => set('margin', v)} step={0.5} />
        <Num label="Espace mm" value={s.gap} onChange={v => set('gap', v)} step={0.5} />
        <label>Fond<input type="color" value={s.bg} onChange={e => set('bg', e.target.value)} /></label>
        <label>Crop
          <select value={s.crop} onChange={e => set('crop', e.target.value as CropMode)}><option value="cover">Cover</option><option value="minimal">Crop minimal</option><option value="contain">Contain</option></select></label>
        <label>Ordre
          <select value={s.order} onChange={e => set('order', e.target.value as PhotoOrder)}><option value="exif">Date EXIF</option><option value="name">Nom</option><option value="random">Aléatoire</option></select></label>
        <label>Découpe
          <select value={s.align} onChange={e => set('align', +e.target.value)}><option value={0}>Libre</option><option value={0.2}>Facile</option><option value={0.5}>Alignée max</option></select></label>
        <label className="check"><input type="checkbox" checked={s.cuts} onChange={e => set('cuts', e.target.checked)} />Traits de coupe</label>
        <span className="muted fmt">{fmt.pxW}×{fmt.pxH} px</span>
      </section>}
      </div>

      {welcome && !photos.length && <Welcome resumeName={resume?.name} onDemo={() => run(loadDemo)} onNew={newProject} onResume={() => { setWelcome(false); run(resumeSession) }} onClose={() => setWelcome(false)} />}

      {msg && <div className="toast" onClick={() => setMsg('')}>{msg} <button>✕</button></div>}

      <main className="grid">
        {pages.map((p, i) => (
          <article key={p.id} id={'page-' + p.id} className={'card' + (overPage === p.id ? ' dropping' : '')}
            onDragOver={e => { if (e.dataTransfer.types.includes('text/photo')) { e.preventDefault(); if (overPage !== p.id) setOverPage(p.id) } }}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverPage(null) }}
            onDrop={e => { const ids = idsOf(e.dataTransfer); setOverPage(null); if (ids.length) { e.preventDefault(); e.stopPropagation(); addMany(p.id, ids) } }}>
            <PageCanvas page={p} byId={byId} fmt={fmt} bg={s.bg} cutGap={s.cuts ? s.gap * pxPerMm : 0} selected={sel?.page === p.id ? sel.photo : undefined} onPick={id => clickPhoto(p.id, id)} onDropPhoto={(cell, id) => assign(p.id, cell, id)} onPickHole={i => pickHole(p.id, i)} onDropHole={(i, id) => pickHole(p.id, i, id)} onDropMany={ids => addMany(p.id, ids)} armed={!!stripSel} />
            <div className="meta">
              <input className="title" value={p.name ?? ''} placeholder={`Collage ${i + 1}`} title="Renommer (nom du fichier exporté)" onChange={e => { note('Collage renommé'); patch(p.id, q => ({ ...q, name: e.target.value })) }} /><span className="muted">{p.photoIds.length} photos · {Math.round(p.layout.score * 100)}%</span>
            </div>
            {p.undo && (
              <div className="selbar">
                <span>{p.notice ?? (p.holes?.length ? `${p.holes.length} emplacement(s) vide(s).` : 'Modification non validée.')}</span>
                {!!p.holes?.length && <button className="primary" onClick={() => readapt(p)}>Réadapter le collage</button>}
                <button onClick={() => keep(p)}>Garder</button>
                <button className="danger" onClick={() => cancelEdit(p)}>Annuler</button>
                {!!p.holes?.length && <span className="muted">ou glissez/cliquez une photo libre sur le vide</span>}
              </div>
            )}
            {sel?.page === p.id && (
              <div className="selbar">
                <span>Photo sélectionnée :</span>
                <button onClick={() => togglePin(p, sel.photo)} title="Épinglée : gardée telle quelle (place, taille, crop) à la regénération ; le reste s’adapte autour">{p.pins?.includes(sel.photo) ? '📌 Désépingler' : '📌 Épingler'}</button>
                <button onClick={() => setEditing(sel)}>Recadrer</button>
                <label className="inl" title="Impose le ratio de la cellule de cette photo (elle est rognée pour le remplir)">Ratio
                  <select value={ratioKey(p.ratios?.[sel.photo], byId.get(sel.photo))} onChange={e => setRatio(p, sel.photo, ratioFromKey(e.target.value, byId.get(sel.photo)))}>
                    <option value="">Libre (auto)</option><option value="orig">Ratio original</option>{RATIOS.map(r => <option key={r[0]} value={r[0]}>{r[0]}</option>)}
                  </select></label>
                <button className="danger" title="Retire la photo (Suppr) ; elle est exclue des prochaines générations" onClick={() => removeFromPage(sel.page, sel.photo)}>Enlever</button>
                <button onClick={() => setSel(null)}>Annuler</button>
                <span className="muted">ou cliquez une autre photo pour l’échanger</span>
              </div>
            )}
            <div className="row">
              <label className="inl" title="Mode de crop de ce collage">Crop
                <select value={p.cropMode ?? ''} onChange={e => setPageCrop(p, e.target.value as CropMode | '')}>
                  <option value="">Global ({s.crop})</option><option value="cover">Cover</option><option value="minimal">Crop minimal</option><option value="contain">Contain</option>
                </select></label>
              {Object.keys(p.crops).length > 0 && <button title="Annuler les recadrages manuels de ce collage" onClick={() => { note('Recadrages réinitialisés'); patch(p.id, q => ({ ...q, crops: {} })) }}>Réinit. recadrages</button>}
            </div>
            <div className="row">
              <button onClick={() => regenerate(p)}>Regenerate</button>
              <button onClick={() => shuffle(p)}>Shuffle</button>
              {p.photoIds.length + (p.holes?.length ?? 0) < s.maxPhotos && <button title="Réserver un emplacement vide à remplir ensuite" onClick={() => addEmpty(p)}>＋ Vide</button>}
              {pickIds.some(i => statusOf(i) !== 'used') && <button title="Ajoute la sélection de la pellicule à ce collage (vous pouvez aussi la glisser dessus)" onClick={() => addMany(p.id, pickIds)}>＋ Ajouter{pickIds.length > 1 ? ` (${pickIds.length})` : ''}</button>}
              <button disabled={!!busy || !p.layout.photos.length} onClick={() => run(() => exportPages([p], 'jpg', 'files', i))}>JPG</button>
              <button disabled={!!busy || !p.layout.photos.length} onClick={() => run(() => exportPages([p], 'png', 'files', i))}>PNG</button>
            </div>
          </article>
        ))}
        {!!photos.length && (
          <article className="card placeholder" onClick={() => newPage(pickIds)}
            onDragOver={e => { if (e.dataTransfer.types.includes('text/photo')) e.preventDefault() }}
            onDrop={e => { const ids = idsOf(e.dataTransfer); if (ids.length) { e.preventDefault(); e.stopPropagation(); newPage(ids) } }}>
            <div className="ph" style={{ aspectRatio: `${fmt.pxW}/${fmt.pxH}` }}><span>＋</span></div>
            <b>Nouveau collage</b>
            <span className="muted">{pickIds.length ? `Cliquez pour y mettre ${pickIds.length > 1 ? `les ${pickIds.length} photos sélectionnées` : 'la photo sélectionnée'}` : 'Cliquez, ou glissez des photos de la pellicule'}</span>
          </article>
        )}
      </main>

      {!!photos.length && (
        <footer className="strip">
          <div className="stripbar">
            {([['all', 'Toutes', photos.length], ['used', 'Utilisées', photos.filter(p => statusOf(p.id) === 'used').length],
              ['free', 'Non utilisées', freeIds.length], ['excluded', 'Exclues', excluded.size]] as const).map(([k, l, n]) => (
              <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l} ({n})</button>
            ))}
            <span className="muted">Clic = sélectionner · ⌘/Maj-clic = plusieurs · glisser sur une photo = remplacer, ailleurs sur le collage = ajouter · ✕ = exclure</span>
          </div>
          <div className="film">
            {shown.map(p => {
              const st = statusOf(p.id)
              return (
                <div key={p.id} className={`frame ${st}${stripSel === p.id ? ' sel' : ''}${multi.includes(p.id) ? ' multi' : ''}`} draggable title={p.name}
                  onDragStart={e => { const ids = multi.includes(p.id) ? multi : [p.id]; e.dataTransfer.setData('text/photo', ids[0]); e.dataTransfer.setData('text/photos', JSON.stringify(ids)); e.dataTransfer.effectAllowed = 'copyMove'; setSel(null) }} onClick={e => clickFrame(e, p.id, shown)}>
                  <Thumb bmp={p.thumb} />
                  <span className="badge">{st === 'used' ? `C${usedIn.get(p.id)! + 1}` : st === 'free' ? 'libre' : 'exclue'}</span>
                  <button className="x" title={st === 'excluded' ? 'Réutiliser' : 'Exclure'} onClick={e => { e.stopPropagation(); toggleExclude(p.id) }}>{st === 'excluded' ? '↺' : '✕'}</button>
                </div>
              )
            })}
          </div>
        </footer>
      )}

      {editing && editPage && editPlaced && byId.get(editing.photo) && (
        <CropEditor photo={byId.get(editing.photo)!} placed={{ ...editPlaced, crop: editPage.crops[editing.photo] ?? editPlaced.crop }}
          onClose={() => setEditing(null)}
          onApply={c => { note('Recadrage manuel'); patch(editPage.id, q => ({ ...q, crops: { ...q.crops, [editing.photo]: c } })); setEditing(null); setSel(null) }} />
      )}
    </div>
  )
}

function PageCanvas({ page, byId, fmt, bg, selected, onPick, onDropPhoto, onPickHole, onDropHole, onDropMany, armed, cutGap }: { onDropMany: (ids: string[]) => void; cutGap: number; onPickHole: (i: number) => void; onDropHole: (i: number, id: string) => void; page: Page; byId: Map<string, Photo>; fmt: Format; bg: string; selected?: string; onPick: (id: string) => void; onDropPhoto: (cell: string, id: string) => void; armed: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const cssW = 360, dpr = window.devicePixelRatio || 1
  const scale = (cssW * dpr) / fmt.pxW
  useEffect(() => {
    const c = ref.current!, ctx = c.getContext('2d')!
    drawPage(ctx, page.layout, scale, bg, id => byId.get(id)?.thumb, page.crops, cutGap)
    ctx.save(); ctx.setLineDash([8 * dpr, 6 * dpr]); ctx.strokeStyle = '#888'; ctx.lineWidth = 2 * dpr; ctx.fillStyle = 'rgba(128,128,128,.15)'
    for (const h of page.holes ?? []) { ctx.fillRect(h.x * scale, h.y * scale, h.width * scale, h.height * scale); ctx.strokeRect(h.x * scale, h.y * scale, h.width * scale, h.height * scale) }
    ctx.restore()
    ctx.font = `${14 * dpr}px system-ui`
    for (const id of page.pins ?? []) { const q = page.layout.photos.find(x => x.id === id); if (q) { ctx.fillStyle = '#000a'; ctx.beginPath(); ctx.arc(q.x * scale + 14 * dpr, q.y * scale + 14 * dpr, 11 * dpr, 0, 7); ctx.fill(); ctx.fillStyle = '#fff'; ctx.fillText('📌', q.x * scale + 6.5 * dpr, q.y * scale + 19 * dpr) } }
    const p = page.layout.photos.find(q => q.id === selected)
    if (p) { ctx.strokeStyle = '#2f81f7'; ctx.lineWidth = 4 * dpr; ctx.strokeRect(p.x * scale, p.y * scale, p.width * scale, p.height * scale) }
  }, [page, byId, fmt, bg, selected, scale, dpr, cutGap])
  const hitAt = (e: { clientX: number; clientY: number; currentTarget: HTMLCanvasElement }) => {
    const r = e.currentTarget.getBoundingClientRect(), k = fmt.pxW / r.width
    const x = (e.clientX - r.left) * k, y = (e.clientY - r.top) * k
    const inside = (p: Rect) => x >= p.x && x <= p.x + p.width && y >= p.y && y <= p.y + p.height
    const photo = page.layout.photos.find(inside)
    const hole = photo ? -1 : (page.holes ?? []).findIndex(inside)
    return { photo, hole }
  }
  return (
    <canvas ref={ref} width={Math.round(fmt.pxW * scale)} height={Math.round(fmt.pxH * scale)} style={{ width: cssW, aspectRatio: `${fmt.pxW}/${fmt.pxH}` }}
      className={armed ? 'armed' : ''}
      onClick={e => { const { photo, hole } = hitAt(e); if (photo) onPick(photo.id); else if (hole >= 0) onPickHole(hole) }}
      onDragOver={e => { if (e.dataTransfer.types.includes('text/photo')) e.preventDefault() }}
      onDrop={e => {
        const ids = idsOf(e.dataTransfer); if (!ids.length) return
        e.preventDefault(); e.stopPropagation()
        const { photo, hole } = hitAt(e)
        if (ids.length === 1 && photo) onDropPhoto(photo.id, ids[0]); else if (ids.length === 1 && hole >= 0) onDropHole(hole, ids[0]); else onDropMany(ids) // plusieurs, ou lâché hors d'une cellule : ajout
      }} />
  )
}

function Thumb({ bmp }: { bmp: ImageBitmap }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const h = 84, w = Math.round((bmp.width / bmp.height) * h)
  useEffect(() => { ref.current!.getContext('2d')!.drawImage(bmp, 0, 0, w, h) }, [bmp, w])
  return <canvas ref={ref} width={w} height={h} />
}
