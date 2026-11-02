import { useEffect, useMemo, useState } from 'react'
import type { WebTab } from '@shared/web'
import { api } from './lib/api'
import { uid } from './lib/utils'
import { WebModel, WebPanel } from './components/WebPanel'

// Ventana flotante con el visor web (copia de una pestaña del proyecto): pestañas propias, sin el resto de la app
export default function WebWindow({ initial }: { initial: string }) {
  const [state, setState] = useState<{ tabs: WebTab[]; active: string | null }>(() => {
    const t = { id: uid(), url: initial }
    return { tabs: [t], active: t.id }
  })

  // mismo tema que la app
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    let pref = 'dark'
    const apply = () => (document.documentElement.dataset.theme = pref === 'system' ? (media.matches ? 'dark' : 'light') : pref)
    api
      .getSettings()
      .then((s) => ((pref = s.theme), apply()))
      .catch(apply)
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [])

  const model = useMemo<WebModel>(
    () => ({
      ...state,
      select: (id) => setState((s) => ({ ...s, active: id })),
      add: (url = 'about:blank') => {
        const t = { id: uid(), url }
        setState((s) => ({ tabs: [...s.tabs, t], active: t.id }))
      },
      close: (id) =>
        setState((s) => {
          const i = s.tabs.findIndex((t) => t.id === id)
          const tabs = s.tabs.filter((t) => t.id !== id)
          // cerrar la última pestaña cierra la ventana
          if (!tabs.length) setTimeout(() => window.close())
          return { tabs, active: s.active === id ? (tabs[Math.min(i, tabs.length - 1)]?.id ?? null) : s.active }
        }),
      update: (id, patch) => setState((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
    }),
    [state]
  )

  return (
    <div className="webwin">
      <WebPanel model={model} floating />
    </div>
  )
}
