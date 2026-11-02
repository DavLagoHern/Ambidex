import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, resolve, sep } from 'path'
import type { UndoFile } from '@shared/types'

// Puntos de control de cada turno de un agente, para poder deshacer lo que hizo.
// Una foto es un «tree» de Git con lo que haría `git add -A`, escrito con un índice temporal:
// no toca tu índice, ni tus ramas, ni tu historial (no hay commits ni referencias nuevas).

function run(cwd: string, args: string[], o: { env?: Record<string, string>; timeout?: number } = {}): Promise<Buffer> {
  return new Promise((ok, fail) =>
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'buffer',
        maxBuffer: 512 * 1024 * 1024,
        timeout: o.timeout ?? 60_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', ...o.env }
      },
      (err, stdout, stderr) => (err ? fail(new Error(String(stderr || err.message).trim())) : ok(stdout))
    )
  )
}

const text = async (cwd: string, args: string[], o?: { env?: Record<string, string>; timeout?: number }) => (await run(cwd, args, o)).toString('utf8').trim()

async function root(cwd: string): Promise<string | null> {
  try {
    return await text(cwd, ['rev-parse', '--show-toplevel'])
  } catch {
    return null
  }
}

// null si la carpeta no es un repositorio o la foto tarda demasiado (p. ej. ficheros enormes sin ignorar)
export async function snapshot(cwd: string, timeout = 20_000): Promise<string | null> {
  const top = await root(cwd)
  if (!top) return null
  const tmp = resolve(tmpdir(), `ambidex-index-${randomUUID()}`)
  try {
    // se parte del índice real: así solo se vuelven a leer los ficheros que han cambiado. La copia conserva
    // la fecha del original: Git la usa para releer los ficheros tocados en el mismo segundo que el índice
    const index = resolve(top, await text(top, ['rev-parse', '--git-path', 'index']))
    if (existsSync(index)) {
      copyFileSync(index, tmp)
      const st = statSync(index)
      utimesSync(tmp, st.atime, st.mtime)
    }
    const env = { GIT_INDEX_FILE: tmp }
    await run(top, ['add', '-A', '--', '.'], { env, timeout })
    return await text(top, ['write-tree'], { env })
  } catch {
    return null
  } finally {
    rmSync(tmp, { force: true })
    rmSync(tmp + '.lock', { force: true })
  }
}

interface Change {
  path: string
  status: string // A, D, M, T
  beforeMode: string
  beforeOid: string
}

async function changes(top: string, a: string, b: string): Promise<Change[]> {
  // -z: rutas tal cual, sin comillas ni escapes
  const parts = (await run(top, ['diff-tree', '-r', '-z', '--no-renames', a, b])).toString('utf8').split('\0')
  const out: Change[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = parts[i].match(/^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])/)
    if (m) out.push({ path: parts[i + 1], status: m[5], beforeMode: m[1], beforeOid: m[3] })
  }
  return out
}

export interface UndoPlan {
  root: string
  files: (UndoFile & { change: Change })[]
}

// Qué haría deshacer el turno: volver cada fichero que tocó a como estaba antes, salvo los que han cambiado después
export async function undoPlan(cwd: string, before: string, after: string): Promise<UndoPlan> {
  const top = await root(cwd)
  if (!top) throw new Error('La carpeta ya no es un repositorio de Git')
  const list = await changes(top, before, after)
  const now = await snapshot(top)
  if (!now) throw new Error('No se pudo leer el estado actual de los ficheros')
  const since = new Set((await changes(top, after, now)).map((c) => c.path))
  return {
    root: top,
    files: list.map((c) => ({
      path: c.path,
      action: since.has(c.path) ? 'conflict' : c.status === 'A' ? 'delete' : 'restore',
      change: c
    }))
  }
}

export async function undo(cwd: string, before: string, after: string): Promise<{ restored: string[]; deleted: string[]; skipped: string[] }> {
  const plan = await undoPlan(cwd, before, after)
  const out = { restored: [] as string[], deleted: [] as string[], skipped: [] as string[] }
  for (const f of plan.files) {
    const abs = resolve(plan.root, f.path)
    // submódulos y conflictos no se tocan; ninguna ruta puede salir del repositorio
    if (f.action === 'conflict' || f.change.beforeMode === '160000' || !abs.startsWith(plan.root + sep)) {
      out.skipped.push(f.path)
      continue
    }
    const exists = (() => {
      try {
        return lstatSync(abs)
      } catch {
        return null
      }
    })()
    if (f.action === 'delete') {
      if (exists && !exists.isDirectory()) rmSync(abs, { force: true })
      out.deleted.push(f.path)
      continue
    }
    const data = await run(plan.root, ['cat-file', 'blob', f.change.beforeOid])
    mkdirSync(dirname(abs), { recursive: true })
    if (exists && (exists.isSymbolicLink() || exists.isDirectory() || f.change.beforeMode === '120000')) rmSync(abs, { recursive: true, force: true })
    if (f.change.beforeMode === '120000') symlinkSync(data.toString('utf8'), abs)
    else {
      writeFileSync(abs, data)
      const mode = statSync(abs).mode & 0o777
      chmodSync(abs, f.change.beforeMode === '100755' ? mode | 0o111 : mode & ~0o111)
    }
    out.restored.push(f.path)
  }
  return out
}
