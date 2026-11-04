// Isolated Electron window, real image IPC, no agents or installed-app restart.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { _electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
const root = resolve(import.meta.dirname, '../..')
const fixture = join(root, 'tests/.images-fixture.tsx')
const data = mkdtempSync(join(tmpdir(), 'ambidex-image-test-'))
const require = createRequire(import.meta.url)
const generated = process.env.TEST_IMAGE || join(data, 'sample.png')
if (!process.env.TEST_IMAGE) writeFileSync(generated, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1kAAAAASUVORK5CYII=', 'base64'))
let app, server
try {
  writeFileSync(fixture, `import React from 'react'; import {createRoot} from 'react-dom/client';
import {Markdown} from '../src/renderer/src/components/Markdown';
import {Lightbox} from '../src/renderer/src/components/Overlays';
import {Item, SentImages} from '../src/renderer/src/components/chat/parts';
import {ProjectProvider} from '../src/renderer/src/lib/project-store';
import '../src/renderer/src/styles.css';
const src = ${JSON.stringify(generated)};
const source = await window.bridge.invoke('fs:image', src);
const saved = await window.bridge.invoke('attachments:save', Uint8Array.from(atob(source.split(',')[1]), c=>c.charCodeAt(0)), 'image/png');
const session = {agent:'claude', cwd:'/tmp'};
createRoot(document.getElementById('root')).render(<div style={{padding:24, maxWidth:700}}><h2>Respuesta con imagen</h2><Markdown text={'[Flujo de Jev](<'+src+'>)'} /><h2>Herramienta histórica de Claude</h2><ProjectProvider value={{state:{workspace:'/tmp'}} as any}><Item session={session as any} item={{id:'1', type:'tool', toolId:'1', name:'Read', input:src, status:'done', output:'[image]'}} /></ProjectProvider><h2>Adjuntos del usuario</h2><SentImages paths={[saved]} /><Lightbox /></div>);`)
  server = await createServer({configFile:false, root, resolve:{alias:{'@shared':join(root,'src/shared')}}, plugins:[react(), {name:'fixture', configureServer(s){s.middlewares.use(async(req,res,next)=>{if(req.url!=='/')return next();res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/', '<div id="root"></div><script type="module" src="/tests/.images-fixture.tsx"></script>'))})}}], server:{host:'127.0.0.1',port:0}})
  await server.listen()
  const port = server.httpServer.address().port
  const env = {...process.env, AMBIDEX_USER_DATA:data, ELECTRON_RENDERER_URL:`http://127.0.0.1:${port}`}; delete env.ELECTRON_RUN_AS_NODE
  app = await _electron.launch({executablePath:require('electron'), args:[join(root,'out/main/index.js')], env})
  const page = await app.firstWindow()
  await page.waitForFunction(()=>document.querySelectorAll('.chat-image img').length===2 && document.querySelector('.sent-img img')?.naturalWidth>0 && [...document.querySelectorAll('.chat-image img')].every(i=>i.complete&&i.naturalWidth>0),null,{timeout:30000})
  await page.locator('.chat-image').first().click()
  await page.waitForSelector('.lightbox img')
  if (!await page.locator('.lightbox img').evaluate(i=>i.naturalWidth>0)) throw Error('Popup image not loaded')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.lightbox', {state:'detached'})
  await page.screenshot({path:join(data,'images.png')})
  console.log('PASS: Markdown image link, historical Read thumbnail, real IPC, popup and Escape. Screenshot: '+join(data,'images.png'))
} finally {
  await app?.close(); await server?.close(); rmSync(fixture,{force:true})
}
