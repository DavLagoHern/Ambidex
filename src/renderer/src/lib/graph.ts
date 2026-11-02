import type { GitCommit } from '@shared/types'

export interface GraphRow {
  col: number
  top: { from: number; to: number }[]
  bottom: { from: number; to: number }[]
  width: number
}

// Calcula los carriles del grafo de commits (orden topológico)
export function computeGraph(commits: GitCommit[]): GraphRow[] {
  let lanes: (string | null)[] = []
  const rows: GraphRow[] = []
  for (const c of commits) {
    let col = lanes.indexOf(c.hash)
    if (col < 0) {
      col = lanes.indexOf(null)
      if (col < 0) col = lanes.length
      lanes[col] = c.hash
    }
    const before = lanes.slice()
    const top = before
      .map((h, i) => (h === null ? null : { from: i, to: h === c.hash ? col : i }))
      .filter((x): x is { from: number; to: number } => !!x)
    // las ramas que esperaban este commit convergen aquí
    lanes = lanes.map((h) => (h === c.hash ? null : h))
    const targets: number[] = []
    const shared = new Set<number>()
    c.parents.forEach((p, k) => {
      let idx = lanes.indexOf(p)
      if (idx >= 0) shared.add(idx)
      else {
        idx = k === 0 ? col : lanes.indexOf(null)
        if (idx < 0) idx = lanes.length
        lanes[idx] = p
      }
      targets.push(idx)
    })
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    const bottom: { from: number; to: number }[] = []
    lanes.forEach((h, i) => {
      if (h === null) return
      if (targets.includes(i)) bottom.push({ from: col, to: i })
      if (!targets.includes(i) || shared.has(i)) bottom.push({ from: i, to: i })
    })
    rows.push({ col, top, bottom, width: Math.max(before.length, lanes.length, col + 1) })
  }
  return rows
}

export const LANE_COLORS = ['#7aa2f7', '#e0af68', '#9ece6a', '#bb9af7', '#f7768e', '#7dcfff', '#ff9e64', '#73daca']
