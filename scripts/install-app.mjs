// Instala Ambidex en /Applications, crea un acceso directo en el Escritorio y la abre.
// Si encuentra la instalación de cuando se llamaba «Code AI», la cierra y la manda a la Papelera.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const APP = { name: 'Ambidex', id: 'dev.ambidex.app' }
const OLD = { name: 'Code AI', id: 'app.codeai.desktop' }
const src = resolve(`src-tauri/target/release/bundle/macos/${APP.name}.app`)
const dst = `/Applications/${APP.name}.app`
const link = join(homedir(), 'Desktop', APP.name)

if (!existsSync(src)) {
  console.error('Primero ejecuta: npm run dist')
  process.exit(1)
}

const bundleId = (app) => execFileSync('defaults', ['read', join(app, 'Contents/Info'), 'CFBundleIdentifier'], { encoding: 'utf8' }).trim()

// hay que esperar a que se cierre de verdad: reemplazar el bundle con la app viva la deja colgada
function quit(app, { name, id }) {
  const executable = execFileSync('defaults', ['read', join(app, 'Contents/Info'), 'CFBundleExecutable'], { encoding: 'utf8' }).trim()
  const exe = join(app, 'Contents/MacOS', executable)
  const running = () => {
    try {
      execFileSync('pgrep', ['-f', exe], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
  if (!running()) return
  try {
    execFileSync('osascript', ['-e', `tell application id "${id}" to quit`], { stdio: 'ignore' })
  } catch {
    /* puede cancelarse si hay agentes trabajando */
  }
  const until = Date.now() + 20000
  while (running() && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
  if (running()) {
    console.error(`${name} sigue abierta (¿hay agentes trabajando?). Ciérrala y vuelve a ejecutar npm run install:app.`)
    process.exit(1)
  }
}

// un acceso del Escritorio solo se toca si es un enlace simbólico (lo creó este script)
function unlinkIfSymlink(path) {
  try {
    if (lstatSync(path).isSymbolicLink()) unlinkSync(path)
  } catch {
    /* no existe */
  }
}

// la instalación antigua se cierra y va a la Papelera (se puede recuperar); sus datos se siguen usando.
// Se mueve sin pasar por Finder, que pediría permiso de automatización y dejaría el script esperando.
const old = `/Applications/${OLD.name}.app`
if (existsSync(old) && bundleId(old) === OLD.id) {
  quit(old, OLD)
  let trashed = join(homedir(), '.Trash', `${OLD.name}.app`)
  if (existsSync(trashed)) trashed = join(homedir(), '.Trash', `${OLD.name} ${Date.now()}.app`)
  renameSync(old, trashed)
  unlinkIfSymlink(join(homedir(), 'Desktop', OLD.name))
  console.log(`${old} está en la Papelera; tus conversaciones y ajustes se conservan.`)
}

// solo se reemplaza una instalación previa de esta misma app
if (existsSync(dst)) {
  const id = bundleId(dst)
  if (id !== APP.id) {
    console.error(`${dst} existe y no es ${APP.name} (${id}); no se toca.`)
    process.exit(1)
  }
  quit(dst, APP)
  rmSync(dst, { recursive: true, force: true })
}
cpSync(src, dst, { recursive: true, verbatimSymlinks: true })

let current = null
try {
  current = lstatSync(link)
} catch {
  /* no existe */
}
if (current?.isSymbolicLink()) unlinkSync(link)
if (current && !current.isSymbolicLink()) console.warn(`${link} ya existe y no es un acceso de ${APP.name}; no se crea el acceso.`)
else symlinkSync(dst, link)
if (current?.isSymbolicLink() && readlinkSync(link) !== dst) console.warn('Acceso del Escritorio actualizado')
console.log(`Instalada en ${dst} · acceso directo en ${link}`)
// al instalarse sola al salir de la app (actualización), no se vuelve a abrir
if (!process.env.AMBIDEX_NO_OPEN) execFileSync('open', [dst])
