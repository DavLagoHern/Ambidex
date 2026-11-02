import type { AgentEvent, AgentId, Permission } from '@shared/types'

export interface RunRequest {
  cwd: string
  resumeId?: string
  model?: string
  effort?: string
  permission?: Permission
  // salida estructurada: Claude recibe el JSON, Codex la ruta de un fichero con el esquema
  schema?: { json: string; file: string }
  // opciones adicionales del usuario (p. ej. red o búsqueda web en Codex)
  extra?: string[]
  // herramientas permitidas sin preguntar (Claude: --allowedTools)
  allowedTools?: string[]
  // imágenes adjuntas (rutas ya comprobadas, dentro de la carpeta de adjuntos de la app)
  images?: string[]
  // continuar la sesión en una copia nueva (la original sigue abierta en otro sitio)
  fork?: boolean
}

export interface Parser {
  // Una línea de stdout → cero o más eventos normalizados
  onLine(line: string): AgentEvent[]
  // Eventos que solo se conocen al terminar (p. ej. límites de Codex en su fichero de sesión)
  onExit?(): Promise<AgentEvent[]>
}

export interface Adapter {
  agent: AgentId
  // El prompt se envía siempre por stdin: nunca se interpreta como opción y no tiene límite de longitud.
  buildArgs(req: RunRequest): string[]
  // Lo que se escribe en stdin (por defecto, el texto tal cual)
  stdin?(text: string, req: RunRequest): string
  createParser(): Parser
  // Líneas de stderr que no aportan nada al usuario
  isNoise(stderrLine: string): boolean
}

export const short = (v: unknown, max = 4000): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? ''
  return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} caracteres más)` : s
}

export const parseJson = (line: string): any => {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}
