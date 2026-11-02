import { existsSync, realpathSync } from 'fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path'

// Resuelve enlaces simbólicos incluso si la ruta (o parte de ella) todavía no existe
export function realish(p: string): string {
  const abs = resolve(p)
  let cur = abs
  const rest: string[] = []
  while (!existsSync(cur)) {
    const parent = dirname(cur)
    if (parent === cur) return abs
    rest.unshift(basename(cur))
    cur = parent
  }
  try {
    return join(realpathSync(cur), ...rest)
  } catch {
    return abs
  }
}

export function isInside(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep)
}

// Solo se permite leer/escribir/ejecutar Git dentro de las carpetas que el usuario ha abierto como
// proyecto (y sus repos/worktrees asociados). Protege frente a un renderer comprometido.
export class PathGuard {
  constructor(private roots: () => string[]) {}

  allowed(p: string): boolean {
    if (!p || !isAbsolute(p)) return false
    const target = realish(p)
    return this.roots().some((r) => isInside(target, realish(r)))
  }

  check(p: string, what = 'La ruta'): string {
    if (typeof p !== 'string' || !isAbsolute(p)) throw new Error(`${what} debe ser absoluta`)
    if (!this.allowed(p)) throw new Error(`${what} está fuera de los proyectos abiertos: ${p}`)
    return p
  }
}

// Subcomandos que la UI puede pedir mediante `git:run` (menú de Git)
const GIT_ALLOWED = new Set(['add', 'reset', 'clean', 'pull', 'push', 'fetch', 'checkout', 'merge', 'rebase', 'branch', 'remote', 'stash', 'tag', 'cherry-pick', 'revert', 'commit'])
// Opciones que permiten ejecutar programas arbitrarios o cambiar la configuración
const GIT_FORBIDDEN = /^(-c|--config|--config-env|--exec|--upload-pack|--receive-pack|--exec-path|--git-dir|--work-tree|--namespace|--template)(=|$)/

export function checkGitArgs(args: unknown): string[] {
  if (!Array.isArray(args) || !args.length || !args.every((a) => typeof a === 'string')) throw new Error('Argumentos de git no válidos')
  if (!GIT_ALLOWED.has(args[0])) throw new Error(`Subcomando de git no permitido: ${args[0]}`)
  const bad = args.find((a) => GIT_FORBIDDEN.test(a))
  if (bad) throw new Error(`Opción de git no permitida: ${bad}`)
  // `rebase -x <cmd>` es la forma corta de --exec
  if (args[0] === 'rebase' && args.some((a) => /^-[a-zA-Z]*x/.test(a))) throw new Error('Opción de git no permitida: -x')
  return args as string[]
}

export function checkExternalUrl(url: string): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error('URL no válida')
  }
  if (!['http:', 'https:', 'mailto:'].includes(u.protocol)) throw new Error(`Protocolo no permitido: ${u.protocol}`)
  return u.toString()
}
