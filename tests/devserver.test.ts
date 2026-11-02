import { writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { detectDevScripts } from '../src/main/devserver'
import { tmpDir } from './helpers'

const project = (scripts: Record<string, unknown>, lock?: string) => {
  const dir = tmpDir('ambidex-dev-')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts }))
  if (lock) writeFileSync(join(dir, lock), '')
  return dir
}

describe('Servidor de desarrollo', () => {
  it('elige los scripts que arrancan un servidor, primero dev', () => {
    const dir = project({ build: 'vite build', start: 'node server.js', dev: 'vite', 'dev:api': 'tsx watch api.ts', lint: 'eslint .', test: 'vitest' })
    expect(detectDevScripts(dir).map((s) => s.command)).toEqual(['npm run dev', 'npm run start', 'npm run dev:api'])
  })

  it('usa el gestor de paquetes del proyecto', () => {
    expect(detectDevScripts(project({ dev: 'next dev' }, 'pnpm-lock.yaml'))[0].command).toBe('pnpm run dev')
    expect(detectDevScripts(project({ dev: 'next dev' }, 'yarn.lock'))[0].command).toBe('yarn run dev')
    expect(detectDevScripts(project({ dev: 'next dev' }, 'bun.lockb'))[0].command).toBe('bun run dev')
  })

  it('nunca compone un comando con un nombre de script raro', () => {
    const dir = project({ 'dev; rm -rf ~': 'vite', 'dev$(whoami)': 'vite', serve: 42, preview: 'vite preview' })
    expect(detectDevScripts(dir).map((s) => s.name)).toEqual(['preview'])
  })

  it('sin package.json no hay nada que arrancar', () => {
    expect(detectDevScripts(tmpDir('ambidex-dev-empty-'))).toEqual([])
  })
})
