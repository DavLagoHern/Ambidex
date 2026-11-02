// Firma ad hoc del .app (necesaria en Apple Silicon tras modificar el bundle de Electron).
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const app = resolve('dist/mac-arm64/Ambidex.app')
if (!existsSync(app)) {
  console.error(`No existe ${app}`)
  process.exit(1)
}
execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
console.log(`Firmado (ad hoc): ${app}`)
