import { useEffect, useState } from 'react'

interface Props {
  resumeName?: string
  onDemo: () => void
  onNew: (projectName: string) => void
  onResume: () => void
  onClose: () => void
}

const DEMO_THUMBS = [1, 2, 3, 4, 5, 6].map(i => `./demo/demo-0${i}.jpg`)

/** Modale d'accueil : démo (30 photos Unsplash embarquées), nouveau projet, ou reprise de la session */
export default function Welcome({ resumeName, onDemo, onNew, onResume, onClose }: Props) {
  const [name, setName] = useState('')
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  return (
    <div className="welcome" onClick={onClose}>
      <div className="box" role="dialog" aria-modal="true" aria-label="Bienvenue dans Collage" onClick={e => e.stopPropagation()}>
        <button className="close" title="Fermer (Échap)" onClick={onClose}>✕</button>
        <header>
          <span className="logo" aria-hidden><i /><i /><i /><i /></span>
          <div>
            <h2>Bienvenue dans Collage</h2>
            <p>Compose automatiquement vos photos en collages prêts à imprimer (10×15, bornes photo). 100 % local : rien n’est envoyé sur un serveur.</p>
          </div>
        </header>

        <div className={'opts' + (resumeName ? ' three' : '')}>
          <section className="opt demo">
            <div className="mosaic" aria-hidden>{DEMO_THUMBS.map(s => <img key={s} src={s} alt="" loading="lazy" />)}</div>
            <h3>Charger la démo</h3>
            <p>30 photos Unsplash, collages générés automatiquement. Rien n’est sauvegardé.</p>
            <button className="primary big" onClick={onDemo}>Essayer avec la démo</button>
          </section>

          <section className="opt">
            <div className="ico" aria-hidden>📁</div>
            <h3>Nouveau projet</h3>
            <p>Choisissez un dossier de photos (potentiellement des centaines).</p>
            <input placeholder="Nom du projet (facultatif)" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && onNew(name)} />
            <button className="big" onClick={() => onNew(name)}>Choisir un dossier…</button>
          </section>

          {resumeName && (
            <section className="opt">
              <div className="ico" aria-hidden>↩</div>
              <h3>Reprendre</h3>
              <p>Retrouvez votre dernière session : <b>{resumeName}</b>.</p>
              <button className="big" onClick={onResume}>Reprendre</button>
            </section>
          )}
        </div>

        <footer>
          Photos de démo : <a href="./demo/CREDITS.md" target="_blank" rel="noreferrer">Unsplash (crédits)</a> · <button className="link" onClick={onClose}>Continuer sans choisir</button>
        </footer>
      </div>
    </div>
  )
}
