import { FSWatcher, watch } from 'fs'
import { readdir, readFile, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import type { DirEntry, FileContent } from '@shared/types'

const HIDDEN = new Set(['.git', '.DS_Store'])

export async function listDir(dir: string): Promise<DirEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter((e) => !HIDDEN.has(e.name))
    .map((e) => ({ name: e.name, path: join(dir, e.name), isDir: e.isDirectory() }))
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
}

export async function readText(path: string): Promise<FileContent> {
  const s = await stat(path)
  if (s.size > 8 * 1024 * 1024) return { content: '', binary: false, tooLarge: true }
  const buf = await readFile(path)
  const binary = buf.subarray(0, 8000).includes(0)
  return { content: binary ? '' : buf.toString('utf8'), binary, tooLarge: false }
}

export const writeText = (path: string, content: string) => writeFile(path, content, 'utf8')

// Un vigilante por proyecto para refrescar Git y los editores cuando los agentes (u otros procesos) tocan ficheros
const watchers = new Map<string, { dir: string; watcher: FSWatcher }>()

const IGNORED = /(^|\/)(node_modules|\.next|dist|out|build|target|\.venv|venv|__pycache__)\//

export function watchDir(key: string, dir: string, onChange: (paths: string[]) => void) {
  const cur = watchers.get(key)
  if (cur?.dir === dir) return
  cur?.watcher.close()
  watchers.delete(key)
  let pending = new Set<string>()
  let timer: NodeJS.Timeout | null = null
  try {
    const watcher = watch(dir, { recursive: true }, (_ev, file) => {
      if (!file) return
      const f = file.toString()
      if (IGNORED.test(f) || /\.git\/(objects|logs)\//.test(f)) return
      pending.add(join(dir, f))
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const paths = [...pending]
        pending = new Set()
        onChange(paths)
      }, 300)
    })
    watcher.on('error', () => unwatch(key))
    watchers.set(key, { dir, watcher })
  } catch {
    /* carpeta inaccesible: sin vigilancia */
  }
}

export function unwatch(key: string) {
  watchers.get(key)?.watcher.close()
  watchers.delete(key)
}

export function unwatchAll() {
  for (const k of [...watchers.keys()]) unwatch(k)
}
