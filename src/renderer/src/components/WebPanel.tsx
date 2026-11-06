import { memo, ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { WebIssue } from '@shared/types'
import { isLocalUrl, normalizeAddress, shortUrl, type WebTab } from '@shared/web'
import { api, on } from '../lib/api'
import { toast } from '../lib/app-store'
import { errMsg } from '../lib/utils'
import { Icon } from './Icons'
import { attachNativePage, type NativePage } from '../lib/native-page'

// Lo que el visor necesita de quien lo aloja (el proyecto o una ventana flotante)
export interface WebModel {
  tabs: WebTab[]
  active: string | null
  select: (id: string) => void
  add: (url?: string) => void
  close: (id: string) => void
  update: (id: string, patch: Partial<Omit<WebTab, 'id'>>) => void
}

type WebviewEl = NativePage

interface Nav {
  back: boolean
  fwd: boolean
  loading: boolean
  error?: { text: string; url: string }
}

interface Pages {
  attach: (tabId: string, el: WebviewEl) => () => void
}

// Los errores de una página, listos para pasárselos a un agente (los repetidos, una vez con su cuenta)
export function issuesText(url: string, list: WebIssue[]): string {
  const seen = new Map<string, number>()
  for (const i of list) {
    const line = `[${i.kind === 'network' ? 'red' : i.level === 'error' ? 'error' : 'aviso'}] ${i.text}${i.kind === 'console' && i.source ? `  (${i.source})` : ''}`
    seen.set(line, (seen.get(line) ?? 0) + 1)
  }
  const lines = [...seen].map(([l, n]) => (n > 1 ? `${l}  ×${n}` : l))
  return `En la página ${url} aparecen estos errores:\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n\nEncuentra la causa y arréglalo.`
}

const Page = memo(function Page({ tab, active, pages }: { tab: WebTab; active: boolean; pages: Pages }) {
  const ref = useRef<WebviewEl>(null)
  // la URL inicial se fija una vez: las navegaciones posteriores las hace la propia página o loadURL
  const src = useRef(tab.url || 'about:blank').current
  useEffect(() => {
    const el = ref.current!
    const detach = pages.attach(tab.id, el)
    const native = attachNativePage(el, src, message => el.dispatchEvent(Object.assign(new Event('did-fail-load'), { errorCode: -1, errorDescription: message, validatedURL: src, isMainFrame: true })))
    return () => { detach(); native() }
  }, [])
  return <div ref={ref} className={`web-page ${active ? 'on' : ''}`} />
})

// `extra`: lo que el proyecto añade a la página en blanco y al error de un localhost (p. ej. arrancar el servidor)
// `onToChat`: pasar algo de la página (sus errores) al chat del proyecto
export function WebPanel({
  model,
  floating,
  onHide,
  extra,
  onToChat,
  onActiveContents,
  banner
}: {
  model: WebModel
  floating?: boolean
  onHide?: () => void
  extra?: ReactNode
  onToChat?: (payload: { text?: string; images?: { path: string; url: string }[] }) => void
  // la pestaña que se ve ahora (la que pueden usar los agentes) y un aviso encima de la página
  onActiveContents?: (webContentsId: number | null) => void
  banner?: ReactNode
}) {
  const [nav, setNav] = useState<Record<string, Nav>>({})
  const [issues, setIssues] = useState<Record<string, WebIssue[]>>({})
  const [showIssues, setShowIssues] = useState(false)
  // avisos que llegan antes de saber de qué pestaña son (la página aún no ha avisado de que está lista)
  const early = useRef(new Map<number, WebIssue[]>())
  const [icons, setIcons] = useState<Record<string, string>>({})
  const [draft, setDraft] = useState<string | null>(null)
  const [onTop, setOnTop] = useState(false)
  const [copied, setCopied] = useState(false)
  const urlRef = useRef<HTMLInputElement>(null)
  // al entrar con un clic, el texto queda seleccionado (el mouseup no lo deshace)
  const keepSelection = useRef(false)
  const views = useRef(new Map<string, WebviewEl>())
  const ready = useRef(new Set<string>())
  const pending = useRef(new Map<string, string>())
  const owners = useRef(new Map<number, string>()) // webContentsId → pestaña
  const m = useRef(model)
  m.current = model
  const active = model.tabs.find((t) => t.id === model.active) ?? null
  const st = active ? nav[active.id] : undefined

  const navigate = (tabId: string, url: string) => {
    const el = views.current.get(tabId)
    setNav((n) => ({ ...n, [tabId]: { ...(n[tabId] ?? { back: false, fwd: false }), loading: true, error: undefined } }))
    if (el && ready.current.has(tabId)) el.loadURL(url).catch(() => {})
    else pending.current.set(tabId, url)
  }

  const pages = useRef<Pages>({
    attach: (tabId, el) => {
      views.current.set(tabId, el)
      const sync = (patch: Partial<Nav> = {}) =>
        ready.current.has(tabId) &&
        setNav((n) => ({ ...n, [tabId]: { ...n[tabId], back: el.canGoBack(), fwd: el.canGoForward(), loading: el.isLoading(), ...patch } }))
      const onReady = () => {
        if (!ready.current.has(tabId)) {
          ready.current.add(tabId)
          const wc = el.getWebContentsId()
          owners.current.set(wc, tabId)
          const before = early.current.get(wc)
          if (before) (early.current.delete(wc), setIssues((x) => ({ ...x, [tabId]: [...(x[tabId] ?? []), ...before].slice(-50) })))
          const p = pending.current.get(tabId)
          if (p) (pending.current.delete(tabId), el.loadURL(p).catch(() => {}))
        }
        sync()
      }
      const onNav = (e: Event) => {
        const ev = e as Event & { url: string; isMainFrame?: boolean }
        if (ev.isMainFrame === false) return
        // una página nueva empieza sin errores
        if (e.type === 'did-navigate') setIssues((x) => (x[tabId]?.length ? { ...x, [tabId]: [] } : x))
        m.current.update(tabId, { url: ev.url })
        sync({ error: undefined })
      }
      const onTitle = (e: Event) => m.current.update(tabId, { title: (e as Event & { title: string }).title })
      const onIcon = (e: Event) => {
        const url = (e as Event & { favicons: string[] }).favicons?.[0]
        if (url)
          api.web
            .favicon(url)
            .then((d) => d && setIcons((i) => ({ ...i, [tabId]: d })))
            .catch(() => {})
      }
      const onFail = (e: Event) => {
        const ev = e as Event & { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean }
        // -3 = navegación cancelada (otra la sustituye): no es un error
        if (!ev.isMainFrame || ev.errorCode === -3) return
        sync({ loading: false, error: { text: ev.errorDescription || `Error ${ev.errorCode}`, url: ev.validatedURL } })
      }
      const onStart = () => sync({ loading: true })
      const onStop = () => sync({ loading: false })
      const evs: [string, (e: Event) => void][] = [
        ['dom-ready', onReady],
        ['did-navigate', onNav],
        ['did-navigate-in-page', onNav],
        ['page-title-updated', onTitle],
        ['page-favicon-updated', onIcon],
        ['did-fail-load', onFail],
        ['did-start-loading', onStart],
        ['did-stop-loading', onStop]
      ]
      for (const [n, f] of evs) el.addEventListener(n, f)
      return () => {
        for (const [n, f] of evs) el.removeEventListener(n, f)
        views.current.delete(tabId)
        ready.current.delete(tabId)
        for (const [wc, t] of owners.current) if (t === tabId) owners.current.delete(wc)
        setIssues(({ [tabId]: _, ...rest }) => rest)
      }
    }
  }).current

  const focusUrl = () => {
    urlRef.current?.focus()
    urlRef.current?.select()
  }

  const command = (key: string, tabId: string | null) => {
    const el = tabId ? views.current.get(tabId) : undefined
    if (key === 'l') focusUrl()
    else if (key === 't') m.current.add()
    else if (key === 'w') tabId && m.current.close(tabId)
    else if (key === 'r') el && ready.current.has(tabId!) && el.reload()
    else if (key === '[') el?.canGoBack() && el.goBack()
    else if (key === ']') el?.canGoForward() && el.goForward()
    // ⌘K, ⌘P… con el foco en la página: se los pasamos a la app
    else window.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true }))
  }

  useEffect(() => {
    const offOpen = on('web:open', ({ url, from }) => owners.current.has(from) && m.current.add(url))
    const offKey = on('web:key', ({ from, key }) => {
      const tabId = owners.current.get(from)
      if (tabId) command(key, tabId)
    })
    const offIssue = on('web:issue', ({ from, issue }) => {
      const tabId = owners.current.get(from)
      if (tabId) setIssues((x) => ({ ...x, [tabId]: [...(x[tabId] ?? []), issue].slice(-50) }))
      else early.current.set(from, [...(early.current.get(from) ?? []), issue].slice(-50))
    })
    return () => (offOpen(), offKey(), offIssue())
  }, [])

  // avisa de qué página se ve ahora en cuanto está lista (y de que no hay ninguna al cerrar el visor)
  const onActive = useRef(onActiveContents)
  onActive.current = onActiveContents
  useEffect(() => {
    const el = active && ready.current.has(active.id) ? views.current.get(active.id) : undefined
    onActive.current?.(el ? el.getWebContentsId() : null)
  }, [active?.id, st ? 1 : 0])
  useEffect(() => () => onActive.current?.(null), [])

  // una pestaña nueva enfoca la barra de direcciones en el mismo instante (no se pierde lo que ya se teclea)
  useLayoutEffect(() => {
    if (active?.url === 'about:blank') focusUrl()
  }, [active?.id])

  useEffect(() => {
    if (floating) document.title = active ? active.title || shortUrl(active.url) : 'Web'
  }, [floating, active?.title, active?.url])

  const go = (text: string) => {
    const url = normalizeAddress(text)
    setDraft(null)
    urlRef.current?.blur()
    if (!active) return m.current.add(url)
    navigate(active.id, url)
  }

  const shown = active && active.url !== 'about:blank' ? active.url : ''
  const secure = shown.startsWith('https://')
  const local = !!shown && isLocalUrl(shown)
  const pageIssues = (active && issues[active.id]) || []
  const errors = pageIssues.filter((i) => i.level === 'error').length

  return (
    <div
      className={`webpanel ${floating ? 'floating' : ''}`}
      onKeyDown={(e) => {
        if (!e.metaKey || e.shiftKey || e.altKey || !['l', 't', 'w', 'r'].includes(e.key.toLowerCase())) return
        e.preventDefault()
        e.stopPropagation()
        command(e.key.toLowerCase(), model.active)
      }}
    >
      <div className="web-tabs" data-tauri-drag-region={floating ? 'deep' : undefined}>
        {model.tabs.map((t) => (
          <div
            key={t.id}
            className={`web-tab ${t.id === model.active ? 'on' : ''}`}
            data-tauri-drag-region="false"
            title={t.url === 'about:blank' ? 'Nueva pestaña' : t.url}
            onClick={() => model.select(t.id)}
            onMouseDown={(e) => e.button === 1 && (e.preventDefault(), model.close(t.id))}
          >
            {nav[t.id]?.loading ? (
              <Icon.spinner size={12} className="spin muted" />
            ) : icons[t.id] ? (
              <img src={icons[t.id]} width={13} height={13} alt="" draggable={false} />
            ) : (
              <Icon.globe size={12} className="muted" />
            )}
            <span className="ellipsis">{t.title || shortUrl(t.url)}</span>
            <span className="tab-close" title="Cerrar pestaña (⌘W)" onClick={(e) => (e.stopPropagation(), model.close(t.id))}>
              <Icon.x size={11} />
            </span>
          </div>
        ))}
        <button className="icon-btn" title="Pestaña nueva (⌘T)" onClick={() => model.add()}>
          <Icon.plus size={14} />
        </button>
        <span className="web-drag" />
        {floating ? (
          <button
            className={`icon-btn ${onTop ? 'on' : ''}`}
            title={onTop ? 'Dejar de mostrar siempre encima' : 'Mostrar siempre encima de las demás ventanas'}
            onClick={() => api.web.setOnTop(!onTop).then(() => setOnTop(!onTop))}
          >
            <Icon.pin size={14} />
          </button>
        ) : (
          <button className="icon-btn" title="Abrir en una ventana nueva" disabled={!active} onClick={() => active && api.web.popout(active.url)}>
            <Icon.popout size={14} />
          </button>
        )}
        {onHide && (
          <button className="icon-btn" title="Cerrar el visor (las pestañas se guardan)" onClick={onHide}>
            <Icon.x size={14} />
          </button>
        )}
      </div>

      <div className="web-bar">
        <button className="icon-btn" title="Atrás (⌘[)" disabled={!st?.back} onClick={() => active && command('[', active.id)}>
          <Icon.back size={14} />
        </button>
        <button className="icon-btn" title="Adelante (⌘])" disabled={!st?.fwd} onClick={() => active && command(']', active.id)}>
          <Icon.forward size={14} />
        </button>
        {st?.loading ? (
          <button className="icon-btn" title="Detener" onClick={() => active && views.current.get(active.id)?.stop()}>
            <Icon.x size={14} />
          </button>
        ) : (
          <button className="icon-btn" title="Recargar (⌘R)" disabled={!shown} onClick={() => active && command('r', active.id)}>
            <Icon.reload size={13} />
          </button>
        )}
        <label className={`web-url ${st?.loading ? 'loading' : ''}`}>
          {secure && <Icon.lock size={11} className="muted" />}
          {local && <span className="web-local">local</span>}
          <input
            ref={urlRef}
            value={draft ?? shown}
            placeholder="Escribe una dirección o busca"
            spellCheck={false}
            onFocus={(e) => {
              setDraft(shown)
              e.target.select()
              keepSelection.current = true
            }}
            onMouseUp={(e) => keepSelection.current && (e.preventDefault(), (keepSelection.current = false))}
            onBlur={() => setDraft(null)}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              keepSelection.current = false
              if (e.key === 'Enter') go(e.currentTarget.value)
              if (e.key === 'Escape') (setDraft(null), e.currentTarget.blur())
            }}
          />
        </label>
        <button
          className={`icon-btn ${copied ? 'ok' : ''}`}
          title={copied ? 'Copiado' : 'Copiar enlace'}
          disabled={!shown}
          onClick={() => navigator.clipboard.writeText(shown).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1200)))}
        >
          {copied ? <Icon.check size={13} /> : <Icon.copy size={13} />}
        </button>
        <button className="icon-btn" title="Abrir en el navegador" disabled={!shown} onClick={() => api.openExternal(shown).catch(() => {})}>
          <Icon.external size={13} />
        </button>
        {onToChat && (
          <button
            className="icon-btn"
            title="Enviar una captura de la página al chat (para que el agente la vea)"
            disabled={!shown || !active || !ready.current.has(active.id)}
            onClick={async () => {
              const el = active && views.current.get(active.id)
              if (!el) return
              try {
                const shot = await api.web.capture(el.getWebContentsId())
                onToChat({ text: `Captura de ${shown}:`, images: [shot] })
              } catch (e) {
                toast(`No se pudo capturar la página: ${errMsg(e)}`, 'error')
              }
            }}
          >
            <Icon.camera size={13} />
          </button>
        )}
        {pageIssues.length > 0 && (
          <button
            className={`web-issues-btn ${errors ? 'err' : 'warn'} ${showIssues ? 'on' : ''}`}
            title="Errores de esta página (consola y peticiones)"
            onClick={() => setShowIssues((v) => !v)}
          >
            <Icon.alert size={12} /> {pageIssues.length}
          </button>
        )}
      </div>

      {banner}
      <div className="web-views">
        {showIssues && active && pageIssues.length > 0 && (
          <div className="web-issues">
            <div className="web-issues-head">
              <b>
                {errors} {errors === 1 ? 'error' : 'errores'}
                {pageIssues.length > errors ? ` · ${pageIssues.length - errors} avisos` : ''}
              </b>
              <span style={{ flex: 1 }} />
              <button className="icon-btn" title="Cerrar" onClick={() => setShowIssues(false)}>
                <Icon.x size={12} />
              </button>
            </div>
            <div className="web-issues-list">
              {pageIssues.map((i, k) => (
                <div key={k} className={`web-issue ${i.level}`}>
                  <span className="web-issue-kind">{i.kind === 'network' ? 'red' : i.level === 'error' ? 'error' : 'aviso'}</span>
                  <span className="mono">{i.text}</span>
                  {i.kind === 'console' && i.source && <span className="muted tiny ellipsis">{i.source}</span>}
                </div>
              ))}
            </div>
            <div className="web-issues-foot">
              {onToChat && (
                <button className="btn primary small" onClick={() => (onToChat({ text: issuesText(shown, pageIssues) }), setShowIssues(false))}>
                  <Icon.chat size={12} /> Pedir que lo arreglen
                </button>
              )}
              <button className="btn small" onClick={() => navigator.clipboard.writeText(issuesText(shown, pageIssues))}>
                <Icon.copy size={12} /> Copiar
              </button>
              <button className="btn ghost small" onClick={() => (setIssues((x) => ({ ...x, [active.id]: [] })), setShowIssues(false))}>
                Limpiar
              </button>
            </div>
          </div>
        )}
        {model.tabs.map((t) => (
          <Page key={t.id} tab={t} active={t.id === model.active} pages={pages} />
        ))}
        {active?.url === 'about:blank' && !st?.loading && (
          <div className="web-blank">
            <Icon.globe size={28} className="muted" />
            <b>Escribe una dirección arriba o busca en Google</b>
            <span className="muted small">Los enlaces del chat y de la terminal se abren aquí, también tu localhost. Con ⌘-clic se abren en tu navegador.</span>
            <span className="muted small">
              <kbd>⌘T</kbd> pestaña nueva · <kbd>⌘L</kbd> dirección · <kbd>⌘W</kbd> cerrar pestaña
            </span>
            {extra}
          </div>
        )}
        {active && st?.error && (
          <div className="web-error">
            <Icon.warn size={22} />
            <b>No se pudo abrir la página</b>
            <span className="mono small">{st.error.url}</span>
            <span className="muted small">
              {st.error.text}
              {isLocalUrl(st.error.url) && /REFUSED|ADDRESS_UNREACHABLE/i.test(st.error.text) ? ' · ¿Está arrancado el servidor?' : ''}
            </span>
            <button className="btn small" onClick={() => navigate(active.id, st.error!.url)}>
              <Icon.reload size={12} /> Reintentar
            </button>
            {isLocalUrl(st.error.url) && extra}
          </div>
        )}
        {!model.tabs.length && (
          <div className="web-blank">
            <Icon.globe size={28} className="muted" />
            <button className="btn primary" onClick={() => model.add()}>
              <Icon.plus size={13} /> Pestaña nueva
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
