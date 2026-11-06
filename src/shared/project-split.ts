export type ProjectSplit = [string, string] | null

// Mantener el lado que tiene el foco al cambiar de pestaña; nunca duplicar un proyecto.
export function selectSplitProject(split: ProjectSplit, active: string | null, next: string): ProjectSplit {
  if (!split || split.includes(next)) return split
  return active === split[1] ? [split[0], next] : [next, split[1]]
}

export function splitWithProject(open: string[], active: string | null, target?: string): ProjectSplit {
  if (!active || !open.includes(active)) return null
  const other = target && target !== active && open.includes(target) ? target : open.find(id => id !== active)
  return other ? [active, other] : null
}
