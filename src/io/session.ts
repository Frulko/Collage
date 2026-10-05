/** Persistance locale (IndexedDB) : handle du dossier, miniatures, état de session. Aucun serveur. */
const db = new Promise<IDBDatabase>((res, rej) => {
  const r = indexedDB.open('collage', 1)
  r.onupgradeneeded = () => r.result.createObjectStore('kv')
  r.onsuccess = () => res(r.result)
  r.onerror = () => rej(r.error)
})
const tx = async <T,>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>) => {
  const d = await db
  return new Promise<T>((res, rej) => { const r = f(d.transaction('kv', mode).objectStore('kv')); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
}
export const kvGet = <T,>(k: string) => tx<T | undefined>('readonly', s => s.get(k)).catch(() => undefined)
/** true si écrit, false si échec (stockage plein/bloqué) */
export const kvSet = (k: string, v: unknown) => tx('readwrite', s => s.put(v, k)).then(() => true, () => false)
export const kvClear = () => tx('readwrite', s => s.clear()).catch(() => undefined)
