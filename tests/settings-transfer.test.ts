import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import { exportSettings, parseSettingsFile } from '../src/shared/settings-transfer'

describe('exportar e importar ajustes', () => {
  it('no exporta rutas, carpetas ni estado propio de cada equipo', () => {
    const file = exportSettings({
      ...DEFAULT_SETTINGS,
      claudePath: '/usr/bin/claude',
      codexPath: '/opt/codex',
      activeProjectId: 'p1',
      extraRepos: { p1: ['/x'] },
      worktreeDir: '/tmp/wt',
      setupComplete: true,
      prompts: [{ id: 'a', name: 'revisar', text: 'Revisa esto' }]
    })
    expect(Object.keys(file.settings)).not.toEqual(expect.arrayContaining(['claudePath']))
    for (const k of ['claudePath', 'codexPath', 'activeProjectId', 'extraRepos', 'worktreeDir', 'setupComplete']) expect(file.settings).not.toHaveProperty(k)
    expect(file.settings.prompts).toHaveLength(1)
    expect(file.settings.routePrefs).toEqual(DEFAULT_SETTINGS.routePrefs)
  })

  it('lo exportado se importa igual', () => {
    const file = exportSettings({ ...DEFAULT_SETTINGS, theme: 'light', orchParallel: 4 })
    const { settings, ignored } = parseSettingsFile(JSON.stringify(file))
    expect(settings).toEqual(file.settings)
    expect(ignored).toEqual([])
  })

  it('ignora claves ajenas o con un tipo incorrecto', () => {
    const text = JSON.stringify({ format: 'ambidex-settings', version: 1, settings: { theme: 'dark', claudePath: '/x', orchMode: 'Z', autoCompact: '5', __proto__: { x: 1 } } })
    const { settings, ignored } = parseSettingsFile(text)
    expect(settings).toEqual({ theme: 'dark' })
    expect(ignored.sort()).toEqual(['autoCompact', 'claudePath', 'orchMode'])
  })

  it('rechaza lo que no es un fichero de ajustes', () => {
    expect(() => parseSettingsFile('no json')).toThrow(/JSON/)
    expect(() => parseSettingsFile('{"a":1}')).toThrow(/no es un fichero/i)
    expect(() => parseSettingsFile('{"format":"ambidex-settings","version":99,"settings":{}}')).toThrow(/más nueva/)
    expect(() => parseSettingsFile('{"format":"ambidex-settings","version":1,"settings":{"claudePath":"/x"}}')).toThrow(/ningún ajuste/)
  })
})
