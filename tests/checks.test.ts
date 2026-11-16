import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { CheckRunner, detectChecks, detectTestCommand, isCheckResultCurrent, type ProjectCheck } from '../src/main/checks'
import { isAlive } from '../src/main/agents/runner'
import { cleanupTmp, initRepo, tmpDir, waitFor } from './helpers'

const runners: CheckRunner[] = []
afterEach(async () => { await Promise.all(runners.splice(0).map(r => r.stop())); cleanupTmp() })
function runner() { const r = new CheckRunner(); runners.push(r); return r }
const command = (code: string, extra: Partial<ProjectCheck> = {}): ProjectCheck => ({ id: 'test', label: 'Prueba', kind: 'test', command: [process.execPath, '-e', code], ...extra })

describe('recetas de comprobación', () => {
  it('detecta tipos, compilación y tests con el gestor declarado', () => {
    const cwd = tmpDir()
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.0.0', scripts: { typecheck: 'tsc --noEmit', build: 'vite build', test: 'vitest run' } }))
    writeFileSync(join(cwd, 'yarn.lock'), '')
    expect(detectChecks(cwd).map(c => c.command)).toEqual([['pnpm', 'run', 'typecheck'], ['pnpm', 'run', 'build'], ['pnpm', 'test']])
    expect(detectTestCommand(cwd)).toEqual(['pnpm', 'test'])
  })
  it('reconoce bun.lock y omite el test de ejemplo de npm', () => {
    const cwd = tmpDir()
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { build: 'bun build .', test: 'echo "Error: no test specified" && exit 1' } }))
    writeFileSync(join(cwd, 'bun.lock'), '')
    expect(detectChecks(cwd).map(c => c.command)).toEqual([['bun', 'run', 'build']])
    expect(detectTestCommand(cwd)).toBeUndefined()
  })
  it.each([
    ['pyproject.toml', '[tool.pytest.ini_options]', ['python3', '-m', 'pytest']],
    ['go.mod', 'module test', ['go', 'test', './...']],
    ['Cargo.toml', '[package]', ['cargo', 'test']],
    ['Package.swift', '', ['swift', 'test']]
  ] as const)('detecta los tests de %s', (file, content, expected) => {
    const cwd = tmpDir(); writeFileSync(join(cwd, file), content)
    expect(detectTestCommand(cwd)).toEqual([...expected])
  })
  it('una carpeta sin configuración o con JSON inválido no tiene tests inventados', () => {
    const cwd = tmpDir()
    expect(detectChecks(cwd)).toEqual([])
    writeFileSync(join(cwd, 'package.json'), '{')
    expect(detectChecks(cwd)).toEqual([])
  })
})

describe('ejecutor común de comprobaciones', () => {
  it('verifica un tree y detecta si una edición posterior invalida la evidencia', async () => {
    const cwd = initRepo(), r = runner()
    const result = await r.start(cwd, command('console.log("OK")'), { runId: 'run-1' }).done
    expect(result).toMatchObject({ outcome: 'passed', verified: true, validity: 'current', code: 0, outputTail: 'OK', runId: 'run-1' })
    expect(result.tree).toBe(result.treeAfter)
    expect(await isCheckResultCurrent(result)).toBe(true)
    writeFileSync(join(cwd, 'README.md'), 'Después del test')
    expect(await isCheckResultCurrent(result)).toBe(false)
    expect(r.runningCount()).toBe(0)
  })
  it('conserva código de salida y cola de stdout/stderr al fallar', async () => {
    const result = await runner().start(initRepo(), command('console.log("salida"); console.error("error"); process.exit(7)')).done
    expect(result).toMatchObject({ outcome: 'failed', verified: false, code: 7, validity: 'current' })
    expect(result.outputTail).toContain('salida')
    expect(result.outputTail).toContain('error')
  })
  it('los argumentos son literales y nunca pasan por un shell', async () => {
    const cwd = initRepo(), marker = join(cwd, 'injected')
    const literal = `; touch ${marker}`
    const result = await runner().start(cwd, { ...command(''), command: [process.execPath, '-e', 'console.log(process.argv[1])', literal] }).done
    expect(result.outputTail).toBe(literal)
    expect(existsSync(marker)).toBe(false)
    expect(result.verified).toBe(true)
  })
  it('un cambio durante la ejecución deja el resultado desactualizado', async () => {
    const cwd = initRepo(), ready = join(tmpDir(), 'ready'), r = runner()
    const job = r.start(cwd, command(`require('fs').writeFileSync(${JSON.stringify(ready)}, '1'); setTimeout(() => {}, 180)`))
    await waitFor(() => existsSync(ready))
    writeFileSync(join(cwd, 'README.md'), 'Mientras ejecutaba')
    const result = await job.done
    expect(result).toMatchObject({ outcome: 'passed', validity: 'stale', verified: false })
    expect(result.tree).not.toBe(result.treeAfter)
  })
  it('sin Git el exit 0 se conserva pero no se declara evidencia verificada', async () => {
    const result = await runner().start(tmpDir(), command('process.exit(0)')).done
    expect(result).toMatchObject({ outcome: 'passed', validity: 'unverified', verified: false, tree: null, treeAfter: null })
  })
  it('limita el tiempo y termina el proceso', async () => {
    const result = await runner().start(initRepo(), command('setInterval(() => {}, 100)', { timeoutMs: 40 })).done
    expect(result).toMatchObject({ outcome: 'timed-out', verified: false })
  })
  it('cancelar antes de empezar no lanza el comando', async () => {
    const cwd = initRepo(), marker = join(cwd, 'not-created'), abort = new AbortController()
    abort.abort()
    const result = await runner().start(cwd, command(`require('fs').writeFileSync(${JSON.stringify(marker)}, '1')`), { signal: abort.signal }).done
    expect(result.outcome).toBe('cancelled')
    expect(existsSync(marker)).toBe(false)
  })
  it('cancelar mata el grupo de procesos y permite cerrar el ejecutor', async () => {
    const cwd = initRepo(), pidfile = join(tmpDir(), 'child.pid'), r = runner()
    const code = `const {spawn}=require('child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'ignore'}); require('fs').writeFileSync(${JSON.stringify(pidfile)},String(c.pid));setInterval(()=>{},100)`
    const job = r.start(cwd, command(code))
    await waitFor(() => existsSync(pidfile))
    const pid = Number(readFileSync(pidfile, 'utf8'))
    expect(isAlive(pid)).toBe(true)
    await r.stop()
    expect((await job.done).outcome).toBe('cancelled')
    await waitFor(() => !isAlive(pid))
    expect(r.runningCount()).toBe(0)
    expect(() => r.start(cwd, command(''))).toThrow('cerrado')
  })
  it('captura un ejecutable inexistente como error, sin dejar un trabajo activo', async () => {
    const r = runner()
    const result = await r.start(initRepo(), { ...command(''), command: ['/no/existe/ambidex-check'] }).done
    expect(result).toMatchObject({ outcome: 'error', verified: false })
    expect(result.outputTail).toContain('ENOENT')
    expect(r.runningCount()).toBe(0)
  })
  it('acota la salida guardada y valida la receta antes de ejecutarla', async () => {
    const r = runner(), cwd = initRepo()
    const result = await r.start(cwd, command('console.log("x".repeat(30000))')).done
    expect(result.outputTail.length).toBeLessThanOrEqual(20000)
    expect(() => r.start(cwd, { ...command(''), command: [] })).toThrow('ejecutable')
    expect(() => r.start(cwd, command('', { timeoutMs: Infinity }))).toThrow('tiempo máximo')
  })
})
