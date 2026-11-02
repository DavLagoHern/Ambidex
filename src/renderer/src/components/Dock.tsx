import { CSSProperties, ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { NativeMenuItem, SavedLayout } from '@shared/types'
import { api } from '../lib/api'
import { askText, getApp, saveSettings, toast, useApp } from '../lib/app-store'
import {
  applyDrop, DOCK_NAMES, DOCK_PANELS, DockLayout, DockNode, DockPanel, DockSplitter, dropLabel, findDrop, GROW, GROW_CODE, layoutDock, PRESETS, Rect,
  resizeSplit, Side, Visible
} from '../lib/dock'
import { ProjectStore, usePS, useStore } from '../lib/project-store'
import { Icon, IconName } from './Icons'

// Separador arrastrable. `onDrag` recibe el desplazamiento acumulado desde el inicio del arrastre.
export function Splitter({
  dir,
  onDrag,
  onEnd,
  className,
  style
}: {
  dir: 'x' | 'y'
  onDrag: (delta: number) => void
  onEnd?: () => void
  className?: string
  style?: CSSProperties
}) {
  const start = useRef(0)
  return (
    <div
      className={`splitter splitter-${dir} ${className ?? ''}`}
      style={style}
      onMouseDown={(e) => {
        e.preventDefault()
        start.current = dir === 'x' ? e.clientX : e.clientY
        const move = (ev: MouseEvent) => onDrag((dir === 'x' ? ev.clientX : ev.clientY) - start.current)
        const up = () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
          document.body.classList.remove('dragging', `dragging-${dir}`)
          onEnd?.()
        }
        document.body.classList.add('dragging', `dragging-${dir}`)
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }}
    />
  )
}

// Cabeceras de panel que sirven para arrastrarlo (por su zona vacía o su título, no por sus botones)
const HEADERS = '.panel-header, .agent-tabs, .bottom-tabs, .web-tabs, .editor-area > .tabs'
const CONTROLS = 'button, input, select, textarea, a, label, [draggable="true"], [role="button"], .tab, .web-tab, .modebar, .seg, .pill'

const SHORTCUT: Partial<Record<DockPanel, string>> = { sidebar: 'Cmd+B', terminal: 'Cmd+J', agents: 'Cmd+Alt+B', editor: 'Cmd+E' }

// Qué paneles se ven en esta ventana (los que están en otra ventana, no)
export function useVisible(): Visible {
  const sidebar = useStore((s) => s.panels.sidebar)
  const terminal = useStore((s) => s.panels.bottom)
  const agents = useStore((s) => s.panels.right)
  const web = useStore((s) => s.web.open)
  const editor = useStore((s) => s.layout === 'code' || s.tabs.length > 0)
  const popped = useStore((s) => s.popped)
  return useMemo(() => {
    const v: Visible = { sidebar, chat: true, editor, web, terminal, agents }
    for (const p of popped) v[p] = false
    return v
  }, [sidebar, editor, web, terminal, agents, popped])
}

export const POPOUT: DockPanel[] = ['chat', 'terminal', 'editor', 'agents']

const rectStyle = (r: Rect): CSSProperties => ({ left: r.x, top: r.y, width: r.w, height: r.h })

function overHeader(target: EventTarget, pane: HTMLElement) {
  const t = target as Element
  const h = t.closest?.(HEADERS)
  if (!h || !pane.contains(h) || t.closest(CONTROLS)) return false
  // solo la cabecera de arriba del panel, no las de lo que haya dentro
  return h.getBoundingClientRect().top - pane.getBoundingClientRect().top < 60
}

// Menú de un panel: moverlo a un borde, intercambiarlo con otro u ocultarlo
async function panelMenu(ps: ProjectStore, p: DockPanel, lay: DockLayout, vis: Visible) {
  const others = DOCK_PANELS.filter((q) => q !== p && vis[q])
  const hideable = p !== 'chat' && !(p === 'editor' && ps.state.tabs.length > 0)
  const sides: [Side, string][] = [
    ['left', 'A la izquierda del todo'],
    ['right', 'A la derecha del todo'],
    ['top', 'Arriba, a todo lo ancho'],
    ['bottom', 'Abajo, a todo lo ancho']
  ]
  const items: NativeMenuItem[] = [
    { label: `Mover ${DOCK_NAMES[p]}`, enabled: false },
    ...sides.map(([id, label]) => ({ id, label })),
    { type: 'separator' },
    ...others.map((q) => ({ id: `swap:${q}`, label: `Intercambiar con ${DOCK_NAMES[q]}` })),
    { type: 'separator' },
    ...(POPOUT.includes(p) ? [{ id: 'popout', label: 'Abrir en una ventana nueva' }] : []),
    ...(hideable ? [{ id: 'hide', label: 'Ocultar', accelerator: SHORTCUT[p] }] : []),
    { id: 'reset', label: 'Restablecer diseño' }
  ]
  const c = await api.contextMenu(items)
  if (!c) return
  if (c === 'hide') return ps.toggleDock(p, false)
  if (c === 'popout') return ps.popOut(p)
  if (c === 'reset') return ps.resetDock()
  const drop = c.startsWith('swap:') ? { kind: 'swap' as const, panel: c.slice(5) as DockPanel } : { kind: 'side' as const, panel: null, side: c as Side }
  ps.setDock(applyDrop(ps.state.dock, lay, p, drop))
}

interface Drag {
  panel: DockPanel
  x: number
  y: number
  hit: ReturnType<typeof findDrop>
}

// Área de paneles del proyecto. Todos los paneles son hermanos con posición absoluta: moverlos de sitio
// no los vuelve a montar, así que las terminales, el editor y las páginas web siguen como estaban.
export function Dock({ content }: { content: Record<DockPanel, ReactNode> }) {
  const ps = usePS()
  const tree = useStore((s) => s.dock)
  const code = useStore((s) => s.layout === 'code')
  const vis = useVisible()
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [drag, setDrag] = useState<Drag | null>(null)
  const resizing = useRef<{ tree: DockNode; sp: DockSplitter } | null>(null)

  useLayoutEffect(() => {
    const el = box.current!
    const read = () => ({ w: el.clientWidth, h: el.clientHeight })
    const same = (a: { w: number; h: number }, b: { w: number; h: number }) => a.w === b.w && a.h === b.h
    const first = read()
    if (first.w && first.h) setSize(first)
    // un proyecto en segundo plano mide 0: se conserva el último tamaño hasta que vuelva a verse
    const ro = new ResizeObserver(() => {
      const next = read()
      if (next.w && next.h) flushSync(() => setSize((s) => (same(s, next) ? s : next)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const lay = useMemo(() => layoutDock(tree, size.w, size.h, vis, code ? GROW_CODE : GROW), [tree, size, vis, code])
  const layRef = useRef(lay)
  layRef.current = lay

  const begin = (panel: DockPanel, sx: number, sy: number) => {
    let started = false
    let hit: Drag['hit'] = null
    const move = (ev: MouseEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return
        started = true
        document.body.classList.add('dock-dragging')
      }
      const b = box.current!.getBoundingClientRect()
      const x = ev.clientX - b.left
      const y = ev.clientY - b.top
      hit = findDrop(layRef.current, x, y, panel)
      setDrag({ panel, x, y, hit })
    }
    const end = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      window.removeEventListener('keydown', key, true)
      document.body.classList.remove('dock-dragging')
      setDrag(null)
    }
    const up = () => {
      end()
      if (started && hit) ps.setDock(applyDrop(ps.state.dock, layRef.current, panel, hit.drop))
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      started = false
      end()
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    window.addEventListener('keydown', key, true)
  }

  const empty = !DOCK_PANELS.some((p) => vis[p] && content[p] != null)

  return (
    <div className="dock" ref={box}>
      {empty && (
        <div className="center-msg muted dock-empty">
          <Icon.layout size={22} />
          Los paneles de este proyecto están en otras ventanas. Ciérralas para traerlos aquí, o muestra otro panel desde la barra de arriba.
        </div>
      )}
      {DOCK_PANELS.map((p) => {
        if (content[p] == null) return null
        const r = vis[p] ? lay.rects[p] : undefined
        return (
          <div
            key={p}
            className={`dock-pane dock-${p} ${drag?.panel === p ? 'drag-src' : ''}`}
            style={r ? rectStyle(r) : { display: 'none' }}
            onMouseDown={(e) => {
              if (e.button === 0 && overHeader(e.target, e.currentTarget)) begin(p, e.clientX, e.clientY)
            }}
            onContextMenu={(e) => {
              if (!overHeader(e.target, e.currentTarget)) return
              e.preventDefault()
              panelMenu(ps, p, lay, vis)
            }}
          >
            {content[p]}
          </div>
        )
      })}
      {lay.splitters.map((sp) => (
        <Splitter
          key={sp.key}
          dir={sp.dir === 'row' ? 'x' : 'y'}
          className="dock-split"
          style={rectStyle(sp.rect)}
          onDrag={(d) => {
            resizing.current ??= { tree: ps.state.dock, sp }
            ps.set({ dock: resizeSplit(resizing.current.tree, resizing.current.sp, d) })
          }}
          onEnd={() => {
            if (resizing.current) ps.setDock(ps.state.dock)
            resizing.current = null
          }}
        />
      ))}
      {drag && (
        <div className="dock-overlay">
          {drag.hit && (
            <div className={`dock-drop ${drag.hit.drop.kind}`} style={rectStyle(drag.hit.rect)}>
              <span>{dropLabel(drag.hit.drop)}</span>
            </div>
          )}
          <div className="dock-ghost" style={{ left: drag.x + 14, top: drag.y + 14 }}>
            {DOCK_NAMES[drag.panel]}
          </div>
        </div>
      )}
    </div>
  )
}

// Interruptores de paneles en la barra de título: siempre a la vista, aunque un panel esté oculto
const TOGGLES: { p: DockPanel; icon: IconName; title: string }[] = [
  { p: 'sidebar', icon: 'panelLeft', title: 'Barra lateral (⌘B)' },
  { p: 'terminal', icon: 'terminal', title: 'Terminal (⌘J)' },
  { p: 'web', icon: 'globe', title: 'Web' },
  { p: 'agents', icon: 'activity', title: 'Agentes (⌥⌘B)' }
]

// Guarda la disposición actual con un nombre (si ya existe, la sustituye)
export async function saveCurrentLayout(ps: ProjectStore) {
  const name = (await askText('Guardar diseño', 'Nombre del diseño (por ejemplo «Revisión»)', ''))?.trim()
  if (!name) return
  const saved = (getApp().settings?.layouts ?? []).filter((l) => l.name !== name)
  await saveSettings({ layouts: [...saved, { name, ...ps.currentLayout() }] })
  toast(`Diseño «${name}» guardado: lo tienes en el menú Diseño`)
}

const NO_LAYOUTS: SavedLayout[] = []

export function LayoutControls() {
  const ps = usePS()
  const vis = useVisible()
  const popped = useStore((s) => s.popped)
  const code = useStore((s) => s.layout === 'code')
  const saved = useApp((s) => s.settings?.layouts ?? NO_LAYOUTS)

  const menu = async () => {
    const items: NativeMenuItem[] = [
      { id: 'sidebar', label: 'Barra lateral', type: 'checkbox', checked: vis.sidebar, accelerator: SHORTCUT.sidebar },
      { id: 'editor', label: 'Editor siempre visible', type: 'checkbox', checked: code, accelerator: SHORTCUT.editor },
      { id: 'web', label: 'Web', type: 'checkbox', checked: vis.web },
      { id: 'terminal', label: 'Terminal', type: 'checkbox', checked: vis.terminal, accelerator: SHORTCUT.terminal },
      { id: 'agents', label: 'Agentes', type: 'checkbox', checked: vis.agents, accelerator: SHORTCUT.agents },
      { type: 'separator' },
      {
        label: 'Abrir en una ventana nueva',
        submenu: POPOUT.map((p) => ({ id: `popout:${p}`, label: popped.includes(p) ? `${DOCK_NAMES[p]} (ya está en otra ventana)` : DOCK_NAMES[p] }))
      },
      {
        label: 'Aplicar diseño',
        submenu: [
          ...PRESETS.map((p) => ({ id: `preset:${p.name}`, label: p.name })),
          ...(saved.length ? [{ type: 'separator' as const }, ...saved.map((l) => ({ id: `saved:${l.name}`, label: l.name }))] : [])
        ]
      },
      { id: 'save', label: 'Guardar el diseño actual…' },
      { label: 'Borrar un diseño guardado', submenu: saved.map((l) => ({ id: `delete:${l.name}`, label: l.name })) },
      { id: 'reset', label: 'Restablecer diseño' },
      { type: 'separator' },
      { label: 'Para mover un panel, arrastra su cabecera', enabled: false }
    ]
    const c = await api.contextMenu(items)
    if (!c) return
    const [kind, name] = [c.slice(0, c.indexOf(':')), c.slice(c.indexOf(':') + 1)]
    if (c === 'reset') ps.resetDock()
    else if (c === 'save') saveCurrentLayout(ps)
    else if (kind === 'popout') ps.popOut(name as DockPanel)
    else if (kind === 'preset') ps.applyLayout(PRESETS.find((p) => p.name === name)!)
    else if (kind === 'saved') {
      const l = saved.find((x) => x.name === name)
      if (l) ps.applyLayout(l)
    } else if (kind === 'delete') saveSettings({ layouts: saved.filter((l) => l.name !== name) })
    else ps.toggleDock(c as DockPanel)
  }

  return (
    <div className="layout-ctl">
      {TOGGLES.map(({ p, icon, title }) => {
        const I = Icon[icon]
        const away = popped.includes(p)
        return (
          <button
            key={p}
            className={`tb-btn icon ${vis[p] || away ? 'on' : ''} ${away ? 'away' : ''}`}
            title={away ? `${title}: está en otra ventana (clic para verla)` : `${vis[p] ? 'Ocultar' : 'Mostrar'}: ${title}`}
            onClick={() => (away ? api.panel.open(ps.id, p) : ps.toggleDock(p))}
          >
            <I size={15} />
          </button>
        )
      })}
      <button className="tb-btn icon" title="Diseño: qué paneles se ven y restablecer" onClick={menu}>
        <Icon.layout size={15} />
      </button>
    </div>
  )
}
