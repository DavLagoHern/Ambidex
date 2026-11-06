// Firma el .app (necesaria en Apple Silicon tras modificar el bundle nativo).
// Con firma ad hoc el «requisito designado» es el hash del binario, que cambia en cada build, y macOS vuelve a
// pedir acceso a Documentos tras cada instalación. Si hay una identidad de firma en el llavero (o se indica con
// AMBIDEX_SIGN_IDENTITY) se usa esa: el requisito queda estable y el permiso se concede una sola vez.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const app = resolve('src-tauri/target/release/bundle/macos/Ambidex.app')
if (!existsSync(app)) {
  console.error(`No existe ${app}`)
  process.exit(1)
}

function findIdentity() {
  if (process.env.AMBIDEX_SIGN_IDENTITY) return process.env.AMBIDEX_SIGN_IDENTITY
  try {
    const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
    const m = out.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"(Apple Development|Developer ID Application|Apple Distribution)[^"]*"/m)
    return m ? m[1] : null
  } catch {
    return null
  }
}

const sign = (id) => {
  execFileSync('codesign', ['--force', '--deep', '--sign', id, app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
}

const identity = findIdentity()
if (identity) {
  try {
    sign(identity)
    console.log(`Firmado con identidad del llavero: ${app}`)
    process.exit(0)
  } catch {
    console.warn('No se pudo firmar con la identidad del llavero; se firma ad hoc.')
  }
}
sign('-')
console.log(`Firmado (ad hoc): ${app}`)
