import { describe, expect, it } from 'vitest'
import {
  applyDrop, defaultDock, DOCK_PANELS, DockNode, DockPanel, dropLabel, findDrop, GAP, isDock, isLeaf, layoutDock, Rect, removePanel, resizeSplit, upgradeDock, Visible, FOLD_H
} from '../src/renderer/src/lib/dock'

const ALL: Visible = { sidebar: true, chat: true, editor: true, web: true, terminal: true, agents: true, activity: true }
const BASIC: Visible = { sidebar: true, chat: true, editor: false, web: false, terminal: false, agents: true, activity: false }
const MIN: Record<DockPanel, [number, number]> = {
  sidebar: [180, 120],
  chat: [320, 200],
  editor: [280, 120],
  web: [280, 120],
  terminal: [220, 80],
  agents: [220, 140],
  activity: [220, 120]
}

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const center = (r: Rect) => [r.x + r.w / 2, r.y + r.h / 2] as const

function leaves(n: DockNode): DockPanel[] {
  return isLeaf(n) ? [n.panel] : n.children.flatMap(leaves)
}

// un generador pseudoaleatorio con semilla para que la prueba sea repetible
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
}

describe('Disposición de paneles', () => {
  it('la disposición de siempre es válida y conserva los tamaños de antes', () => {
    expect(isDock(defaultDock())).toBe(true)
    const d = defaultDock({ rightW: 410, bottomH: 333, sideW: Number.NaN })
    expect(isDock(d)).toBe(true)
    const lay = layoutDock(d, 1600, 900, ALL)
    expect(lay.rects.agents!.w).toBe(410)
    expect(lay.rects.terminal!.h).toBe(333)
    expect(lay.rects.sidebar!.w).toBe(272)
  })

  it('rechaza árboles guardados rotos', () => {
    expect(isDock(null)).toBe(false)
    expect(isDock({ panel: 'chat', size: 1 })).toBe(false)
    const dup = defaultDock() as { children: DockNode[] }
    dup.children[0] = { panel: 'chat', size: 200 }
    expect(isDock(dup)).toBe(false)
    expect(isDock({ dir: 'diag', size: 0, children: [] })).toBe(false)
  })

  it('al cambiar el tamaño de la ventana, los laterales se quedan y el chat se lleva la diferencia', () => {
    for (const w of [1392, 1800, 2560]) {
      const lay = layoutDock(defaultDock(), w, 800, BASIC)
      expect(lay.rects.sidebar!.w).toBe(272)
      expect(lay.rects.agents!.w).toBe(300)
      expect(lay.rects.chat!.w).toBe(w - 272 - 300 - 2 * GAP)
      expect(lay.rects.agents!.x + lay.rects.agents!.w).toBe(w)
      expect(lay.splitters).toHaveLength(2)
    }
  })

  it('en una ventana estrecha el chat no baja de su mínimo: encogen los laterales', () => {
    const lay = layoutDock(defaultDock(), 800, 600, BASIC)
    expect(lay.rects.chat!.w).toBeGreaterThanOrEqual(320)
    expect(lay.rects.sidebar!.w).toBeGreaterThanOrEqual(180)
    expect(lay.rects.agents!.w).toBeGreaterThanOrEqual(220)
    expect(lay.rects.agents!.x + lay.rects.agents!.w).toBe(800)
  })

  it('un panel oculto vuelve a aparecer en el mismo sitio y con su tamaño', () => {
    const t = defaultDock()
    const before = layoutDock(t, 1500, 900, BASIC).rects.agents
    const hidden = layoutDock(t, 1500, 900, { ...BASIC, agents: false })
    expect(hidden.rects.agents).toBeUndefined()
    expect(hidden.rects.chat!.x + hidden.rects.chat!.w).toBe(1500)
    expect(layoutDock(t, 1500, 900, BASIC).rects.agents).toEqual(before)
  })

  it('soltar la terminal sobre la web las intercambia, con el tamaño de cada sitio', () => {
    const t = defaultDock()
    const vis = { ...BASIC, web: true, terminal: true }
    const lay = layoutDock(t, 1500, 900, vis)
    const [x, y] = center(lay.rects.web!)
    const hit = findDrop(lay, x, y, 'terminal')!
    expect(hit.drop).toEqual({ kind: 'swap', panel: 'web' })
    expect(dropLabel(hit.drop)).toBe('Intercambiar con Web')
    const after = layoutDock(applyDrop(t, lay, 'terminal', hit.drop), 1500, 900, vis).rects
    expect(after.terminal).toEqual(lay.rects.web)
    expect(after.web).toEqual(lay.rects.terminal)
  })

  it('soltar en el borde de un panel lo coloca a ese lado; en el borde del área, a todo lo ancho', () => {
    const t = defaultDock()
    const vis = { ...BASIC, web: true, terminal: true }
    const lay = layoutDock(t, 1500, 900, vis)
    const web = lay.rects.web!

    const right = findDrop(lay, web.x + web.w - 5, web.y + web.h / 2, 'terminal')!
    expect(right.drop).toEqual({ kind: 'side', panel: 'web', side: 'right' })
    const t2 = applyDrop(t, lay, 'terminal', right.drop)
    expect(isDock(t2)).toBe(true)
    const r2 = layoutDock(t2, 1500, 900, vis).rects
    // la columna que tenía la terminal debajo desaparece: la terminal queda a la derecha de la web, a toda la altura
    expect(r2.terminal!.x).toBe(r2.web!.x + r2.web!.w + GAP)
    expect(r2.terminal!.h).toBe(900)
    expect(r2.chat!.h).toBe(900)

    const bottom = findDrop(lay, 700, 895, 'agents')!
    expect(bottom.drop).toEqual({ kind: 'side', panel: null, side: 'bottom' })
    const r3 = layoutDock(applyDrop(t, lay, 'agents', bottom.drop), 1500, 900, vis).rects
    expect(r3.agents!.w).toBe(1500)
    expect(r3.agents!.y + r3.agents!.h).toBe(900)

    expect(findDrop(lay, ...center(lay.rects.terminal!), 'terminal')).toBeNull()
  })

  it('arrastrar un separador cambia los dos lados sin pasar de los mínimos', () => {
    const t = defaultDock()
    const lay = layoutDock(t, 1500, 900, BASIC)
    const sp = lay.splitters.find((s) => s.rect.x === lay.rects.agents!.x - GAP)!
    const wider = layoutDock(resizeSplit(t, sp, -80), 1500, 900, BASIC).rects
    expect(wider.agents!.w).toBe(380)
    const tooFar = layoutDock(resizeSplit(t, sp, 500), 1500, 900, BASIC).rects
    expect(tooFar.agents!.w).toBe(220)
  })

  it('quitar un panel funde las divisiones que se quedan con un solo hijo', () => {
    const t = removePanel(defaultDock(), 'terminal')
    expect(isLeaf(t)).toBe(false)
    // la columna (chat · editor · web) / terminal se convierte en parte de la fila principal
    expect((t as { children: DockNode[] }).children.map((c) => (isLeaf(c) ? c.panel : 'split'))).toEqual(['sidebar', 'chat', 'editor', 'web', 'split'])
  })

  it('Actividad es un panel propio, debajo de Agentes, y se puede ocultar o mover sin tocar al otro', () => {
    const t = defaultDock()
    const lay = layoutDock(t, 1500, 900, ALL)
    const a = lay.rects.agents!
    const act = lay.rects.activity!
    expect(act.x).toBe(a.x)
    expect(act.y).toBeGreaterThan(a.y)
    // oculta, Agentes ocupa toda la columna
    const only = layoutDock(t, 1500, 900, { ...ALL, activity: false })
    expect(only.rects.activity).toBeUndefined()
    expect(only.rects.agents!.h).toBeGreaterThan(a.h)
    // arrastrada abajo del todo, queda a todo lo ancho
    const bottom = findDrop(lay, 700, 895, 'activity')!
    const r = layoutDock(applyDrop(t, lay, 'activity', bottom.drop), 1500, 900, ALL).rects
    expect(r.activity!.w).toBe(1500)
    expect(r.activity!.y + r.activity!.h).toBe(900)
    expect(r.agents!.w).toBeLessThan(1500)
  })

  it('plegar Agentes o Actividad deja solo la cabecera y el otro se lleva el sitio', () => {
    const t = defaultDock()
    const open = layoutDock(t, 1500, 900, ALL)
    const fa = layoutDock(t, 1500, 900, ALL, undefined, { activity: true })
    expect(fa.rects.activity!.h).toBe(FOLD_H)
    expect(fa.rects.activity!.y + FOLD_H).toBe(900)
    expect(fa.rects.agents!.h).toBe(900 - FOLD_H - GAP)
    // entre los dos no queda separador que arrastrar
    expect(fa.splitters.length).toBe(open.splitters.length - 1)
    const fg = layoutDock(t, 1500, 900, ALL, undefined, { agents: true })
    expect(fg.rects.agents!.h).toBe(FOLD_H)
    expect(fg.rects.activity!.h).toBe(900 - FOLD_H - GAP)
    // los dos plegados: el ancho de la columna no cambia
    const both = layoutDock(t, 1500, 900, ALL, undefined, { agents: true, activity: true })
    expect(both.rects.agents!.h).toBe(FOLD_H)
    expect(both.rects.agents!.w).toBe(open.rects.agents!.w)
  })

  it('una disposición guardada sin Actividad se conserva y la recibe debajo de Agentes', () => {
    // la de antes: Agentes a la derecha del todo, sin panel de actividad
    const old = {
      dir: 'row',
      size: 0,
      children: [
        { panel: 'sidebar', size: 250 },
        { panel: 'chat', size: 700 },
        { panel: 'editor', size: 400 },
        { panel: 'web', size: 300 },
        { panel: 'terminal', size: 200 },
        { panel: 'agents', size: 340 }
      ]
    }
    expect(isDock(old)).toBe(false)
    const up = upgradeDock(old)!
    expect(isDock(up)).toBe(true)
    const kids = (up as { children: DockNode[] }).children
    expect(kids.slice(0, 5).map((c) => (isLeaf(c) ? c.panel : 'split'))).toEqual(['sidebar', 'chat', 'editor', 'web', 'terminal'])
    expect(kids[0]).toMatchObject({ size: 250 })
    const right = kids[5] as { dir: string; children: DockNode[] }
    expect(right.dir).toBe('col')
    expect(right.children.map((c) => (isLeaf(c) ? c.panel : '?'))).toEqual(['agents', 'activity'])
    // lo roto sigue rechazado, y uno ya al día no cambia
    expect(upgradeDock({ panel: 'chat', size: 1 })).toBeNull()
    const cur = defaultDock()
    expect(upgradeDock(cur)).toBe(cur)
  })

  it('después de cientos de movimientos al azar, ningún panel se pierde, se solapa ni baja de su mínimo', () => {
    const rand = rng(7)
    const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)]
    let t = defaultDock()
    for (let i = 0; i < 400; i++) {
      const vis = Object.fromEntries(DOCK_PANELS.map((p) => [p, p === 'chat' || rand() < 0.7])) as Visible
      const lay = layoutDock(t, 1600, 1000, vis)
      const shown = DOCK_PANELS.filter((p) => vis[p])
      for (const p of shown) {
        const r = lay.rects[p]!
        expect(r.x).toBeGreaterThanOrEqual(0)
        expect(r.y).toBeGreaterThanOrEqual(0)
        expect(r.x + r.w).toBeLessThanOrEqual(1600)
        expect(r.y + r.h).toBeLessThanOrEqual(1000)
        expect(r.w).toBeGreaterThanOrEqual(MIN[p][0] - 1)
        expect(r.h).toBeGreaterThanOrEqual(MIN[p][1] - 1)
        for (const q of shown) if (q < p) expect(overlap(r, lay.rects[q]!)).toBe(false)
      }
      const dragged = pick(shown)
      const x = rand() * 1600
      const y = rand() * 1000
      const hit = findDrop(lay, x, y, dragged)
      if (hit) t = applyDrop(t, lay, dragged, hit.drop)
      expect(isDock(t)).toBe(true)
      expect(leaves(t).sort()).toEqual([...DOCK_PANELS].sort())
    }
  })
})
