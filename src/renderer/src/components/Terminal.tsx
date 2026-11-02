import { useEffect, useRef } from 'react'
import { Terminal as XTerm, ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { AgentId } from '@shared/types'
import { findLinks, isLocalUrl } from '@shared/web'
import { api, on } from '../lib/api'
import { useApp } from '../lib/app-store'

const THEMES: Record<'dark' | 'light', ITheme> = {
  dark: {
    background: '#121317',
    foreground: '#e7e8ec',
    cursor: '#b4a7ff',
    selectionBackground: '#8b7cf650',
    black: '#1c1e24',
    brightBlack: '#6c717d',
    red: '#f0616d',
    green: '#4ec27d',
    yellow: '#e5b85c',
    blue: '#6ea8fe',
    magenta: '#b4a7ff',
    cyan: '#5fd4c4'
  },
  light: {
    background: '#f4f4f2',
    foreground: '#1d1e22',
    cursor: '#6d5ce8',
    selectionBackground: '#6d5ce840',
    black: '#1d1e22',
    brightBlack: '#8a8d96',
    red: '#d73644',
    green: '#1f8a4c',
    yellow: '#a46a00',
    blue: '#2f6fe0',
    magenta: '#6d5ce8',
    cyan: '#0f8a85',
    white: '#e2e2df'
  }
}

export function TerminalView({
  id,
  cwd,
  visible,
  login,
  dev,
  detach,
  onExit,
  onLink,
  onUrl
}: {
  id: string
  cwd: string
  visible: boolean
  login?: AgentId
  // script de package.json que se lanza al abrirla (servidor de desarrollo)
  dev?: string
  // en una ventana de panel: al cerrarla, la terminal sigue viva (la dueña es la ventana principal)
  detach?: boolean
  onExit?: (code: number) => void
  // por defecto los enlaces van al navegador; en un proyecto, al visor web
  onLink?: (url: string, e: MouseEvent) => void
  // la primera dirección local que imprime (p. ej. http://localhost:5173 de Vite)
  onUrl?: (url: string) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const theme = useApp((s) => s.theme)
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit
  const onLinkRef = useRef(onLink)
  onLinkRef.current = onLink
  const onUrlRef = useRef(onUrl)
  onUrlRef.current = onUrl

  useEffect(() => {
    const term = new XTerm({
      fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      allowProposedApi: true,
      macOptionIsMeta: true,
      scrollback: 5000,
      theme: THEMES[theme]
    })
    termRef.current = term
    const fit = new FitAddon()
    fitRef.current = fit
    term.loadAddon(fit)
    // URLs (p. ej. http://localhost:5173 de un servidor de desarrollo) se abren en el navegador
    term.loadAddon(new WebLinksAddon((e, url) => (onLinkRef.current ? onLinkRef.current(url, e) : api.openExternal(url).catch(() => {}))))
    term.open(host.current!)
    // los trozos de salida pueden cortar una URL: se mira el final de lo último que llegó, sin colores
    let tail = ''
    let urlSeen = false
    // hasta saber si se engancha a una terminal que ya existía, lo que llega se guarda: si existía,
    // ya viene incluido en lo que devuelve el proceso principal
    let early: string[] | null = []
    const offData = on('term:data', (p) => {
      if (p.id !== id) return
      if (early) return void early.push(p.data)
      term.write(p.data)
      if (urlSeen || !onUrlRef.current) return
      tail = (tail + p.data.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')).slice(-400)
      // solo una URL ya completa (le sigue algo, p. ej. el salto de línea): un trozo cortado no vale
      const url = findLinks(tail).find((l) => l.end < tail.length && isLocalUrl(l.url) && /:\d+/.test(l.url))?.url
      if (url) {
        urlSeen = true
        onUrlRef.current(url)
      }
    })
    const offExit = on('term:exit', (p) => {
      if (p.id !== id) return
      term.write(`\r\n\x1b[90m[proceso terminado${p.code ? ` con código ${p.code}` : ''}]\x1b[0m\r\n`)
      onExitRef.current?.(p.code)
    })
    term.onData((d) => api.term.write(id, d))
    term.onResize(({ cols, rows }) => api.term.resize(id, cols, rows))
    api.term
      .create(id, { cwd, login, dev })
      .then((r) => {
        term.write(r?.buffer ?? early!.join(''))
        early = null
        try {
          fit.fit()
          api.term.resize(id, term.cols, term.rows)
        } catch {
          /* contenedor oculto */
        }
      })
      .catch((e) => ((early = null), term.write(`\x1b[31m${String(e?.message ?? e)}\x1b[0m\r\n`)))
    const ro = new ResizeObserver(() => {
      try {
        if (host.current?.offsetParent) fit.fit()
      } catch {
        /* ignore */
      }
    })
    ro.observe(host.current!)
    return () => {
      ro.disconnect()
      offData()
      offExit()
      if (!detach) api.term.kill(id)
      term.dispose()
    }
    // el tema se actualiza en caliente en otro efecto
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, cwd, login, dev, detach])

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = THEMES[theme]
  }, [theme])

  useEffect(() => {
    if (!visible) return
    const t = setTimeout(() => {
      try {
        fitRef.current?.fit()
        // no le quita el foco a lo que estés escribiendo en otro sitio (⌘K, el chat…)
        const el = document.activeElement as HTMLElement | null
        const typing = !!el && el !== document.body && (el.matches('input, textarea, select, [contenteditable="true"]') || el.isContentEditable) && !host.current?.contains(el)
        if (!typing) termRef.current?.focus()
      } catch {
        /* ignore */
      }
    }, 30)
    return () => clearTimeout(t)
  }, [visible])

  return <div className="terminal-host" ref={host} style={{ display: visible ? undefined : 'none' }} />
}
