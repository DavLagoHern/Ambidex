import type { Settings } from './types'

// Exportar e importar la configuración para pasarla de un equipo a otro. Solo viaja lo que es una preferencia:
// rutas de CLI, carpetas, proyecto activo y estado del asistente dependen de cada máquina y se quedan fuera.
// Las conversaciones, los proyectos y las credenciales tampoco forman parte del fichero.
export const SETTINGS_FORMAT = 'ambidex-settings'
export const SETTINGS_VERSION = 1

type Kind = 'string' | 'boolean' | 'number' | 'array' | 'object' | readonly string[]

const PORTABLE: Record<string, Kind> = {
  enabledAgents: 'array',
  claudeModel: 'string',
  codexModel: 'string',
  claudeEffort: 'string',
  codexEffort: 'string',
  claudeMode: 'string',
  codexSandbox: 'string',
  commitAgent: ['claude', 'codex'],
  defaultAgent: ['claude', 'codex'],
  stripApiKeys: 'boolean',
  theme: 'string',
  notifications: 'boolean',
  routerMode: ['rules', 'ai', 'jev'],
  routePrefs: 'object',
  routeCategories: 'array',
  difficultyCriteria: 'object',
  modelPolicy: 'object',
  autoUpdateClis: 'boolean',
  autoUpdateApp: 'boolean',
  orchMode: ['A', 'B', 'C', 'D', 'E'],
  orchMaxRounds: 'number',
  orchApprovePlan: 'boolean',
  orchParallel: 'number',
  codexNetwork: 'boolean',
  autoCompact: 'number',
  codexWebSearch: ['default', 'live', 'disabled'],
  agentWeb: 'boolean',
  layouts: 'array',
  prompts: 'array'
}

export interface SettingsFile {
  format: typeof SETTINGS_FORMAT
  version: number
  exportedAt: string
  settings: Partial<Settings>
}

const fits = (kind: Kind, v: unknown): boolean => {
  if (Array.isArray(kind)) return typeof v === 'string' && kind.includes(v)
  if (kind === 'array') return Array.isArray(v)
  if (kind === 'object') return typeof v === 'object' && v !== null && !Array.isArray(v)
  if (kind === 'number') return typeof v === 'number' && Number.isFinite(v)
  return typeof v === kind
}

export function exportSettings(settings: Settings, now = new Date()): SettingsFile {
  const out: Record<string, unknown> = {}
  const all = settings as unknown as Record<string, unknown>
  for (const key of Object.keys(PORTABLE)) if (all[key] !== undefined && fits(PORTABLE[key], all[key])) out[key] = all[key]
  return { format: SETTINGS_FORMAT, version: SETTINGS_VERSION, exportedAt: now.toISOString(), settings: out as Partial<Settings> }
}

// Devuelve solo los ajustes válidos y portables; lo demás se ignora y se cuenta para avisar al usuario.
export function parseSettingsFile(text: string): { settings: Partial<Settings>; ignored: string[] } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('El contenido no es un JSON válido.')
  }
  const file = data as Partial<SettingsFile> | null
  if (!file || typeof file !== 'object' || file.format !== SETTINGS_FORMAT) throw new Error('No es un fichero de ajustes de Ambidex.')
  if (typeof file.version !== 'number' || file.version > SETTINGS_VERSION) throw new Error('Este fichero es de una versión más nueva de Ambidex. Actualiza la app e inténtalo de nuevo.')
  const src = file.settings
  if (!src || typeof src !== 'object' || Array.isArray(src)) throw new Error('El fichero no contiene ajustes.')
  const settings: Record<string, unknown> = {}
  const ignored: string[] = []
  for (const [key, value] of Object.entries(src)) {
    if (Object.hasOwn(PORTABLE, key) && fits(PORTABLE[key], value)) settings[key] = value
    else ignored.push(key)
  }
  if (!Object.keys(settings).length) throw new Error('El fichero no tiene ningún ajuste que se pueda importar.')
  return { settings: settings as Partial<Settings>, ignored }
}
