import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchAccountLimits, parseAccountLimits } from '../src/main/agents/usage-limits'
import { parseRolloutLimits } from '../src/main/agents/codex'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const bucket = { primary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: 1793777016 }, planType: 'pro' }
function fakeCli(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ambidex-limits-')); dirs.push(dir)
  const bin = join(dir, 'codex.cjs')
  writeFileSync(bin, `#!${process.execPath}\n${body}`); chmodSync(bin, 0o755)
  return { dir, bin }
}

describe('uso de la cuenta de Codex', () => {
  it('elige el bucket de Codex y conserva el porcentaje consumido', () => {
    expect(parseAccountLimits({ rateLimits: { primary: { usedPercent: 5 } }, rateLimitsByLimitId: { codex: bucket } }, 123)).toMatchObject({
      source: 'live', updatedAt: 123, plan: 'pro', windows: [{ label: 'Semana', usedPercent: 61, resetsAt: 1793777016 }]
    })
  })
  it('no inventa un cero cuando no hay cuota', () => {
    expect(() => parseAccountLimits({ rateLimits: { primary: { usedPercent: null } } })).toThrow('no ha devuelto')
  })
  it('fecha el dato de sesión con el evento y no con la última escritura del archivo', () => {
    const text = JSON.stringify({ timestamp: '2026-11-03T10:00:00Z', payload: { rate_limits: { primary: { used_percent: 61, window_minutes: 10080 } } } })
    expect(parseRolloutLimits(text, 999)?.updatedAt).toBe(Date.parse('2026-11-03T10:00:00Z'))
  })
  it('consulta solo la cuenta y cierra el proceso sin lanzar un turno', async () => {
    const { bin, dir } = fakeCli(`const r = require('node:readline').createInterface({ input: process.stdin });
      r.on('line', line => { const d = JSON.parse(line);
        if (d.method === 'initialized') return;
        if (d.method === 'initialize') console.log(JSON.stringify({id:d.id,result:{}}));
        else if (d.method === 'account/rateLimits/read') console.log(JSON.stringify({id:d.id,result:{rateLimits:${JSON.stringify(bucket)}}}));
        else { console.log(JSON.stringify({id:d.id,error:{message:'No se permiten turnos'}})); }
      });`)
    expect(await fetchAccountLimits(bin, dir, process.env)).toMatchObject({ source: 'live', windows: [{ usedPercent: 61 }] })
  })
  it('propaga un error de cuenta en vez de mostrar un dato inventado', async () => {
    const { bin, dir } = fakeCli(`process.stdin.once('data', () => console.log(JSON.stringify({id:1,error:{message:'Sin sesión'}})));`)
    await expect(fetchAccountLimits(bin, dir, process.env)).rejects.toThrow('Sin sesión')
  })
})
