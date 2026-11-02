// Renderiza build/icon.svg a PNG 1024 con Electron (fondo transparente).
// Uso: electron scripts/render-icon.cjs
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('fs')
const { join } = require('path')

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const root = join(__dirname, '..')
  const svg = readFileSync(join(root, 'build/icon.svg'), 'utf8')
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } })
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 400))
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  writeFileSync(join(root, 'build/icon.png'), img.resize({ width: 1024, height: 1024, quality: 'best' }).toPNG())
  app.quit()
})
