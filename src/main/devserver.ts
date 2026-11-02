import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { DevScript } from '@shared/types'

// Scripts de package.json que arrancan un servidor de desarrollo, en orden de preferencia.
// El comando se compone con piezas de una lista fija y un nombre de script validado: nunca con texto libre.
const PREFERRED = ['dev', 'start', 'serve', 'preview', 'storybook', 'watch']
const LOOKS_LIKE_SERVER = /\b(dev|serve|server|start|preview|watch|storybook)\b/
const SAFE_NAME = /^[\w:.@/-]+$/

export function packageManager(dir: string): DevScript['pm'] {
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun'
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

export function detectDevScripts(dir: string): DevScript[] {
  let scripts: Record<string, unknown>
  try {
    scripts = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))?.scripts ?? {}
  } catch {
    return []
  }
  const pm = packageManager(dir)
  const rank = (n: string) => {
    const i = PREFERRED.indexOf(n)
    return i >= 0 ? i : PREFERRED.length
  }
  return Object.entries(scripts)
    .filter(([name, body]) => typeof body === 'string' && SAFE_NAME.test(name) && (PREFERRED.includes(name) || LOOKS_LIKE_SERVER.test(name)))
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([name, body]) => ({ name, pm, command: `${pm} run ${name}`, script: String(body) }))
}
