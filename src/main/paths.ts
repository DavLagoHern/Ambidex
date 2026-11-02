import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// Carpetas de la app. Una instalación de cuando se llamaba «Code AI» sigue usando las suyas: la base de datos
// guarda rutas absolutas (worktrees, imágenes adjuntas, Jev) y moverlas las rompería.
const legacyHome = join(homedir(), '.code-ai')
export const APP_HOME = existsSync(legacyHome) && !existsSync(join(homedir(), '.ambidex')) ? legacyHome : join(homedir(), '.ambidex')

export function legacyUserData(appData: string): string | undefined {
  const old = join(appData, 'Code AI')
  return existsSync(old) && !existsSync(join(appData, 'Ambidex')) ? old : undefined
}

export const dbFile = (userData: string) => join(userData, existsSync(join(userData, 'code-ai.db')) ? 'code-ai.db' : 'ambidex.db')
