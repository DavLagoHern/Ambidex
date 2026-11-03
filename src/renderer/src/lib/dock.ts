// Disposición de los paneles de un proyecto: un árbol de filas y columnas cuyas hojas son paneles.
// Cada nodo guarda su tamaño en píxeles a lo largo de la división que lo contiene. En cada división,
// el hijo que tiene el panel principal visible (el chat, o el editor en la disposición «código»)
// se queda con lo que sobra, así que al cambiar el tamaño de la ventana los laterales no se deforman.
// Ocultar un panel no lo saca del árbol: al volver a mostrarlo reaparece donde estaba.

import type { LayoutShow } from '@shared/types'

export type DockPanel = 'sidebar' | 'chat' | 'editor' | 'web' | 'terminal' | 'agents' | 'activity'
export type Side = 'left' | 'right' | 'top' | 'bottom'
export type DockDir = 'row' | 'col'
export interface DockLeaf {
  panel: DockPanel
  size: number
}
export interface DockSplit {
  dir: DockDir
  size: number
  children: DockNode[]
}
export type DockNode = DockLeaf | DockSplit
export type Visible = Record<DockPanel, boolean>
export type { LayoutShow }
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const DOCK_PANELS: DockPanel[] = ['sidebar', 'chat', 'editor', 'web', 'terminal', 'agents', 'activity']
export const DOCK_NAMES: Record<DockPanel, string> = {
  sidebar: 'Barra lateral',
  chat: 'Chat',
  editor: 'Editor',
  web: 'Web',
  terminal: 'Terminal',
  agents: 'Agentes',
  activity: 'Actividad'
}
// quién se queda con el espacio libre de cada división
export const GROW: DockPanel[] = ['chat', 'editor', 'web', 'terminal', 'agents', 'activity', 'sidebar']
export const GROW_CODE: DockPanel[] = ['editor', 'chat', 'web', 'terminal', 'agents', 'activity', 'sidebar']

export const GAP = 1 // la línea del separador
const EDGE = 14 // franja de los bordes del área que coloca el panel a todo lo ancho o alto
const MIN: Record<DockPanel, [number, number]> = {
  sidebar: [180, 120],
  chat: [320, 200],
  editor: [280, 120],
  web: [280, 120],
  terminal: [220, 80],
  agents: [220, 140],
  activity: [220, 120]
}
// tamaño con el que llega un panel a un sitio nuevo
const PREF: Record<DockPanel, [number, number]> = {
  sidebar: [272, 320],
  chat: [560, 420],
  editor: [560, 360],
  web: [560, 420],
  terminal: [520, 260],
  agents: [300, 320],
  activity: [300, 260]
}

export const isLeaf = (n: DockNode): n is DockLeaf => 'panel' in n
const axisOf = (dir: DockDir) => (dir === 'row' ? 0 : 1)
const dirOf = (side: Side): DockDir => (side === 'left' || side === 'right' ? 'row' : 'col')
const clone = (n: DockNode): DockNode => (isLeaf(n) ? { ...n } : { ...n, children: n.children.map(clone) })

export interface LegacySizes {
  sideW?: number
  rightW?: number
  bottomH?: number
  editorW?: number
  webW?: number
}

const leaf = (panel: DockPanel, size: number): DockLeaf => ({ panel, size })
const split = (dir: DockDir, size: number, children: DockNode[]): DockSplit => ({ dir, size, children })

// La columna de la derecha: Agentes arriba y Actividad debajo (cada uno se puede arrastrar a otro sitio)
const rightColumn = (w: number): DockSplit => split('col', w, [leaf('agents', 300), leaf('activity', 360)])

// La disposición de siempre: barra lateral | (chat · editor · web) sobre la terminal | agentes sobre actividad
export function defaultDock(old: LegacySizes = {}): DockNode {
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : d)
  return {
    dir: 'row',
    size: 0,
    children: [
      { panel: 'sidebar', size: n(old.sideW, 272) },
      {
        dir: 'col',
        size: 820,
        children: [
          {
            dir: 'row',
            size: 600,
            children: [
              { panel: 'chat', size: 820 },
              { panel: 'editor', size: n(old.editorW, 620) },
              { panel: 'web', size: n(old.webW, 560) }
            ]
          },
          { panel: 'terminal', size: n(old.bottomH, 260) }
        ]
      },
      rightColumn(n(old.rightW, 300))
    ]
  }
}


// Diseños de serie: qué se ve y dónde. La disposición «código» deja el editor a la vista y le da el espacio.
export const PRESETS: { name: string; dock: DockNode; show: LayoutShow }[] = [
  { name: 'Normal', dock: defaultDock(), show: { sidebar: true, terminal: false, web: false, agents: true, activity: true, code: false } },
  {
    name: 'Frontend',
    dock: split('row', 0, [
      leaf('sidebar', 240),
      split('col', 900, [split('row', 600, [leaf('chat', 480), leaf('editor', 520), leaf('web', 860)]), leaf('terminal', 220)]),
      rightColumn(280)
    ]),
    show: { sidebar: false, terminal: true, web: true, agents: false, activity: false, code: false }
  },
  {
    name: 'Código',
    dock: split('row', 0, [
      leaf('sidebar', 272),
      split('col', 900, [split('row', 600, [leaf('editor', 800), leaf('chat', 460), leaf('web', 520)]), leaf('terminal', 240)]),
      rightColumn(280)
    ]),
    show: { sidebar: true, terminal: true, web: false, agents: false, activity: false, code: true }
  },
  { name: 'Concentrado', dock: defaultDock(), show: { sidebar: false, terminal: false, web: false, agents: false, activity: false, code: false } }
]

// Comprueba un árbol guardado: estructura correcta y cada panel exactamente una vez
function validDock(x: unknown, panels: DockPanel[]): boolean {
  const seen = new Set<string>()
  const ok = (n: unknown, depth: number): boolean => {
    if (!n || typeof n !== 'object' || depth > 12) return false
    const o = n as Record<string, unknown>
    if (typeof o.size !== 'number' || !Number.isFinite(o.size) || o.size < 0) return false
    if ('panel' in o) {
      if (!panels.includes(o.panel as DockPanel) || seen.has(o.panel as string)) return false
      seen.add(o.panel as string)
      return true
    }
    return (o.dir === 'row' || o.dir === 'col') && Array.isArray(o.children) && o.children.length > 0 && o.children.every((c) => ok(c, depth + 1))
  }
  return ok(x, 0) && seen.size === panels.length
}

export const isDock = (x: unknown): x is DockNode => validDock(x, DOCK_PANELS)

// Disposición guardada antes de que existiera el panel «Actividad» (venía dentro de Agentes): se conserva todo y la
// Actividad entra justo debajo de los Agentes, en la misma columna.
export function upgradeDock(x: unknown): DockNode | null {
  if (isDock(x)) return x
  if (!validDock(x, DOCK_PANELS.filter((p) => p !== 'activity'))) return null
  const put = (n: DockNode): DockNode => {
    if (isLeaf(n)) return n.panel === 'agents' ? split('col', n.size, [{ ...n, size: Math.min(n.size, 300) }, leaf('activity', 360)]) : n
    return { ...n, children: n.children.map(put) }
  }
  const out = put(x as DockNode)
  return isDock(out) ? out : null
}

export function contains(n: DockNode, p: DockPanel): boolean {
  return isLeaf(n) ? n.panel === p : n.children.some((c) => contains(c, p))
}

function shown(n: DockNode, vis: Visible): boolean {
  return isLeaf(n) ? vis[n.panel] : n.children.some((c) => shown(c, vis))
}

// Paneles plegados: solo su cabecera. En una columna ocupan eso y el resto se lo llevan los de al lado; en una fila
// conservan su ancho (se pliega el contenido, no el sitio).
export type Folded = Partial<Record<DockPanel, boolean>>
export const FOLD_H = 38 // alto de la cabecera de un panel
export const FOLDABLE: DockPanel[] = ['agents', 'activity']

function minOf(n: DockNode, axis: number, vis: Visible, folded: Folded = {}): number {
  if (isLeaf(n)) return axis === 1 && folded[n.panel] ? FOLD_H : MIN[n.panel][axis]
  const kids = n.children.filter((c) => shown(c, vis)).map((c) => minOf(c, axis, vis, folded))
  if (!kids.length) return 0
  return axisOf(n.dir) === axis ? kids.reduce((a, b) => a + b, 0) + GAP * (kids.length - 1) : Math.max(...kids)
}

// ---------- cálculo de la disposición ----------

export interface DockSplitter {
  key: string
  path: number[]
  a: number // índices en `children` de los dos lados del separador
  b: number
  dir: DockDir
  rect: Rect
  sa: number // tamaño actual de cada lado
  sb: number
  minA: number
  minB: number
}

export interface DockLayout {
  w: number
  h: number
  rects: Partial<Record<DockPanel, Rect>>
  splitters: DockSplitter[]
}

// Reparte `len` píxeles: los hijos fijos piden su tamaño (como mínimo su mínimo) y el flexible
// se queda el resto. Si no cabe, primero encogen los fijos y, si aun así no llega, todos en proporción.
export function allocate(sizes: number[], mins: number[], flex: number, len: number): number[] {
  const s = sizes.map((v, k) => (k === flex ? 0 : Math.max(mins[k], v)))
  const fixed = () => s.reduce((a, v, k) => (k === flex ? a : a + v), 0)
  let rest = len - fixed()
  if (rest < mins[flex]) {
    const slack = s.reduce((a, v, k) => (k === flex ? a : a + v - mins[k]), 0)
    const take = Math.min(mins[flex] - rest, slack)
    if (slack > 0) for (let k = 0; k < s.length; k++) if (k !== flex) s[k] -= ((s[k] - mins[k]) * take) / slack
    rest = len - fixed()
    if (rest < mins[flex]) {
      const total = mins.reduce((a, v) => a + v, 0) || 1
      return mins.map((m) => (Math.max(0, len) * m) / total)
    }
  }
  s[flex] = rest
  return s
}

export function layoutDock(tree: DockNode, w: number, h: number, vis: Visible, grow: DockPanel[] = GROW, folded: Folded = {}): DockLayout {
  const out: DockLayout = { w, h, rects: {}, splitters: [] }
  const walk = (n: DockNode, r: Rect, path: number[]) => {
    if (isLeaf(n)) {
      out.rects[n.panel] = r
      return
    }
    const idx = n.children.map((c, i) => (shown(c, vis) ? i : -1)).filter((i) => i >= 0)
    if (!idx.length) return
    if (idx.length === 1) return walk(n.children[idx[0]], r, [...path, idx[0]])
    const axis = axisOf(n.dir)
    const kids = idx.map((i) => n.children[i])
    const isFold = (c: DockNode) => axis === 1 && isLeaf(c) && !!folded[c.panel]
    const mins = kids.map((c) => minOf(c, axis, vis, folded))
    // quien se lleva el espacio libre nunca es un panel plegado (salvo que lo estén todos)
    const open = kids.map((c, k) => (isFold(c) ? -1 : k)).filter((k) => k >= 0)
    const main = grow.find((p) => vis[p] && !folded[p] && kids.some((c, k) => open.includes(k) && contains(c, p)))
    const flex = main ? kids.findIndex((c, k) => open.includes(k) && contains(c, main)) : (open.at(-1) ?? kids.length - 1)
    const len = (axis === 0 ? r.w : r.h) - GAP * (kids.length - 1)
    const sizes = allocate(
      kids.map((c) => (isFold(c) ? FOLD_H : c.size)),
      mins,
      flex,
      len
    )
    let acc = axis === 0 ? r.x : r.y
    kids.forEach((c, k) => {
      const start = Math.round(acc)
      const end = Math.round(acc + sizes[k])
      const cr = axis === 0 ? { x: start, y: r.y, w: end - start, h: r.h } : { x: r.x, y: start, w: r.w, h: end - start }
      walk(c, cr, [...path, idx[k]])
      // junto a un panel plegado no hay separador: su alto es el de la cabecera
      if (k < kids.length - 1 && !isFold(c) && !isFold(kids[k + 1])) {
        const sr = axis === 0 ? { x: end, y: r.y, w: GAP, h: r.h } : { x: r.x, y: end, w: r.w, h: GAP }
        const nextEnd = Math.round(acc + sizes[k] + GAP + sizes[k + 1])
        out.splitters.push({
          key: `${path.join('.')}:${idx[k]}`,
          path,
          a: idx[k],
          b: idx[k + 1],
          dir: n.dir,
          rect: sr,
          sa: end - start,
          sb: nextEnd - (end + GAP),
          minA: mins[k],
          minB: mins[k + 1]
        })
      }
      acc += sizes[k] + GAP
    })
  }
  walk(tree, { x: 0, y: 0, w, h }, [])
  return out
}

// Nuevo tamaño de los dos lados de un separador tras arrastrarlo `delta` píxeles
export function resizeSplit(tree: DockNode, sp: DockSplitter, delta: number): DockNode {
  const sa = Math.max(sp.minA, Math.min(sp.sa + sp.sb - sp.minB, sp.sa + delta))
  const t = clone(tree)
  let n = t
  for (const i of sp.path) n = (n as DockSplit).children[i]
  const kids = (n as DockSplit).children
  kids[sp.a].size = Math.round(sa)
  kids[sp.b].size = Math.round(sp.sa + sp.sb - sa)
  return t
}

// ---------- mover paneles ----------

export type Drop = { kind: 'swap'; panel: DockPanel } | { kind: 'side'; panel: DockPanel | null; side: Side }

const SIDES: Side[] = ['left', 'right', 'top', 'bottom']

function placeRect(r: Rect, side: Side, s: number): Rect {
  if (side === 'left') return { ...r, w: s }
  if (side === 'right') return { ...r, x: r.x + r.w - s, w: s }
  if (side === 'top') return { ...r, h: s }
  return { ...r, y: r.y + r.h - s, h: s }
}

// junto a un panel ocupa como mucho la mitad de su sitio (si se queda corto, el reparto respeta los mínimos)
function placeSize(p: DockPanel, side: Side, extent: number, share: number) {
  return Math.round(Math.min(PREF[p][axisOf(dirOf(side))], extent * share))
}

// Dónde caería un panel arrastrado hasta (x, y), relativo al área de paneles
export function findDrop(lay: DockLayout, x: number, y: number, dragged: DockPanel): { drop: Drop; rect: Rect } | null {
  if (x < 0 || y < 0 || x > lay.w || y > lay.h) return null
  const whole = { x: 0, y: 0, w: lay.w, h: lay.h }
  const edge = x < EDGE ? 'left' : x > lay.w - EDGE ? 'right' : y < EDGE ? 'top' : y > lay.h - EDGE ? 'bottom' : null
  if (edge) {
    const ext = edge === 'left' || edge === 'right' ? lay.w : lay.h
    return { drop: { kind: 'side', panel: null, side: edge }, rect: placeRect(whole, edge, placeSize(dragged, edge, ext, 1 / 3)) }
  }
  for (const p of DOCK_PANELS) {
    const r = lay.rects[p]
    if (!r || x < r.x || x >= r.x + r.w || y < r.y || y >= r.y + r.h) continue
    if (p === dragged) return null
    const rx = (x - r.x) / r.w
    const ry = (y - r.y) / r.h
    const d = [rx, 1 - rx, ry, 1 - ry]
    const m = Math.min(...d)
    if (m > 0.28) return { drop: { kind: 'swap', panel: p }, rect: r }
    const side = SIDES[d.indexOf(m)]
    const ext = side === 'left' || side === 'right' ? r.w : r.h
    return { drop: { kind: 'side', panel: p, side }, rect: placeRect(r, side, placeSize(dragged, side, ext, 1 / 2)) }
  }
  return null
}

export function dropLabel(d: Drop): string {
  if (d.kind === 'swap') return `Intercambiar con ${DOCK_NAMES[d.panel]}`
  if (!d.panel) return { left: 'A la izquierda del todo', right: 'A la derecha del todo', top: 'Arriba, a todo lo ancho', bottom: 'Abajo, a todo lo ancho' }[d.side]
  const n = DOCK_NAMES[d.panel]
  return { left: `A la izquierda de ${n}`, right: `A la derecha de ${n}`, top: `Encima de ${n}`, bottom: `Debajo de ${n}` }[d.side]
}

// Quita un panel del árbol. Una división que se queda con un solo hijo se sustituye por él,
// y si ese hijo es una división en el mismo sentido que su nuevo padre, se funde con él.
export function removePanel(tree: DockNode, p: DockPanel): DockNode {
  const walk = (n: DockNode): DockNode | null => {
    if (isLeaf(n)) return n.panel === p ? null : n
    const kids = n.children.map(walk).filter((c): c is DockNode => !!c)
    if (!kids.length) return null
    if (kids.length === 1) return { ...kids[0], size: n.size }
    return { ...n, children: kids.flatMap((c) => (!isLeaf(c) && c.dir === n.dir ? c.children : [c])) }
  }
  return walk(clone(tree)) ?? tree
}

export function swapPanels(tree: DockNode, a: DockPanel, b: DockPanel): DockNode {
  const walk = (n: DockNode): DockNode =>
    isLeaf(n) ? { ...n, panel: n.panel === a ? b : n.panel === b ? a : n.panel } : { ...n, children: n.children.map(walk) }
  return walk(tree)
}

function wrap(node: DockNode, leaf: DockLeaf, side: Side, ext: number): DockSplit {
  const rest = { ...node, size: Math.max(0, ext - leaf.size - GAP) }
  const before = side === 'left' || side === 'top'
  return { dir: dirOf(side), size: node.size, children: before ? [leaf, rest] : [rest, leaf] }
}

// Coloca `p` junto a `target` (o junto a todo el área si es null), tomando `size` píxeles de un hueco de `ext`
export function insertPanel(tree: DockNode, p: DockPanel, target: DockPanel | null, side: Side, size: number, ext: number): DockNode {
  const t = removePanel(tree, p)
  const leaf: DockLeaf = { panel: p, size }
  const dir = dirOf(side)
  const before = side === 'left' || side === 'top'
  if (!target) {
    if (!isLeaf(t) && t.dir === dir) return { ...t, children: before ? [leaf, ...t.children] : [...t.children, leaf] }
    return { ...wrap(t, leaf, side, ext), size: 0 }
  }
  const walk = (n: DockNode): DockNode => {
    if (isLeaf(n)) return n.panel === target ? wrap(n, leaf, side, ext) : n
    const i = n.children.findIndex((c) => isLeaf(c) && c.panel === target)
    if (i >= 0 && n.dir === dir) {
      const kids = [...n.children]
      kids[i] = { ...kids[i], size: Math.max(0, ext - size - GAP) }
      kids.splice(before ? i : i + 1, 0, leaf)
      return { ...n, children: kids }
    }
    return { ...n, children: n.children.map(walk) }
  }
  return walk(t)
}

export function applyDrop(tree: DockNode, lay: DockLayout, dragged: DockPanel, d: Drop): DockNode {
  if (d.kind === 'swap') return swapPanels(tree, dragged, d.panel)
  const r = d.panel ? lay.rects[d.panel] : { x: 0, y: 0, w: lay.w, h: lay.h }
  if (!r) return tree
  const ext = d.side === 'left' || d.side === 'right' ? r.w : r.h
  return insertPanel(tree, dragged, d.panel, d.side, placeSize(dragged, d.side, ext, d.panel ? 1 / 2 : 1 / 3), ext)
}
