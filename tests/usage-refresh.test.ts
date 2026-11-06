import { afterEach, describe, expect, it, vi } from 'vitest'
import { UsageRefresh } from '../src/main/agents/usage-refresh'
import { USAGE_REFRESH_MS } from '../src/shared/types'
import { weeklyHeadroom } from '../src/shared/router'

afterEach(() => { vi.useRealTimers() })

describe('actualización del uso', () => {
  it('consulta al arrancar, cada 30 min y agrupa turnos simultáneos', async () => {
    vi.useFakeTimers()
    const read = vi.fn(async () => {})
    const usage = new UsageRefresh(read)
    usage.start()
    usage.start()
    await vi.advanceTimersByTimeAsync(USAGE_REFRESH_MS)
    expect(read).toHaveBeenCalledTimes(2)
    usage.afterTurn(); usage.afterTurn()
    await vi.advanceTimersByTimeAsync(1000)
    expect(read).toHaveBeenCalledTimes(3)
    usage.stop()
    usage.afterTurn()
    await vi.advanceTimersByTimeAsync(USAGE_REFRESH_MS)
    expect(read).toHaveBeenCalledTimes(3)
  })
  it('comparte una consulta en curso y vuelve a leer tras un cambio de cuota', async () => {
    let finish!: () => void
    const read = vi.fn().mockImplementationOnce(() => new Promise<void>(r => { finish = r })).mockResolvedValue(undefined)
    const usage = new UsageRefresh(read)
    const first = usage.refresh()
    expect(usage.refresh()).toBe(first)
    const changed = usage.refreshAfterChange()
    expect(read).toHaveBeenCalledTimes(1)
    finish()
    await changed
    expect(read).toHaveBeenCalledTimes(2)
    usage.stop()
  })
  it('deja de publicar consultas al cerrar incluso si hay una pendiente', async () => {
    let finish!: () => void
    const read = vi.fn(() => new Promise<void>(r => { finish = r }))
    const usage = new UsageRefresh(read)
    void usage.refresh()
    const changed = usage.refreshAfterChange()
    usage.stop()
    finish()
    await changed
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('acepta datos durante el intervalo de sondeo y rechaza los caducados', () => {
    const now = Date.now()
    const limits = { agent: 'codex' as const, windows: [{ label: 'Semana', usedPercent: 10 }], updatedAt: now - USAGE_REFRESH_MS }
    expect(weeklyHeadroom(limits, now)).toBe(90)
    expect(weeklyHeadroom({ ...limits, updatedAt: now - 36 * 60_000 }, now)).toBeUndefined()
    expect(weeklyHeadroom({ ...limits, refreshError: 'Sin conexión' }, now)).toBeUndefined()
  })
})
