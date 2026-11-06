// Visor de salida con proceso simulado: no ejecuta tareas ni afecta a la app instalada.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { _electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const fixture = join(root, 'tests/.working-fixture.tsx')
const data = mkdtempSync(join(tmpdir(), 'ambidex-working-test-'))
const require = createRequire(import.meta.url)
let app, server
try {
  writeFileSync(fixture, `import React from 'react'; import {createRoot} from 'react-dom/client';
import {Working, Item} from '../src/renderer/src/components/chat/parts';
import {BottomPanel} from '../src/renderer/src/components/BottomPanel';
import {ProjectProvider,useStore} from '../src/renderer/src/lib/project-store';
import {api} from '../src/renderer/src/lib/api';
import '../src/renderer/src/styles.css';
const now=Date.now(),tool={id:'tool',toolId:'tool',type:'tool',name:'Bash',input:'npm run test:texts | tail -8',status:'running',at:now-20*60000};
const session={id:'s',agent:'claude',cwd:'/tmp',items:[tool]};
const listeners=new Set<()=>void>();
const ps:any={id:'p',state:{runs:[{id:'r',sessionId:'s',projectId:'p',agent:'claude',status:'running',startedAt:now-20*60000,lastActivityAt:now-19*60000}],sessions:{s:session},terminals:[],bottomTab:'log',logRun:'r',panels:{bottom:false}},subscribe:(l)=>{listeners.add(l);return()=>listeners.delete(l)},set:(patch)=>{ps.state={...ps.state,...(typeof patch==='function'?patch(ps.state):patch)};listeners.forEach(l=>l())},loadMessages:async()=>{},cancelSession:()=>{(window as any).workingTest.cancelled=true}};
api.runs.log=async()=>[{at:now,stream:'stderr',line:'Salida del proceso de prueba'}];
(window as any).workingTest={ps,cancelled:false,signal:()=>ps.set({runs:[{...ps.state.runs[0],lastActivityAt:Date.now()}]})};
function Fixture(){const bottom=useStore(s=>s.panels.bottom);return <><Working session={session as any}/><Item session={session as any} item={tool as any}/>{bottom&&<div style={{height:450}}><BottomPanel visible/></div>}</>}
createRoot(document.getElementById('root')).render(<ProjectProvider value={ps}><Fixture/></ProjectProvider>);`)
  server = await createServer({configFile:false,root,resolve:{alias:{'@shared':join(root,'src/shared')}},plugins:[react(),{name:'fixture',configureServer(s){s.middlewares.use(async(req,res,next)=>{if(req.url!=='/')return next();res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/', '<div id="root"></div><script type="module" src="/tests/.working-fixture.tsx"></script>'))})}}],server:{host:'127.0.0.1',port:0}})
  await server.listen()
  const env = {...process.env,AMBIDEX_USER_DATA:data,ELECTRON_RENDERER_URL:`http://127.0.0.1:${server.httpServer.address().port}`};delete env.ELECTRON_RUN_AS_NODE
  app = await _electron.launch({executablePath:require('electron'),args:[join(root,'out/main/index.js')],env})
  const page = await app.firstWindow()
  await page.waitForSelector('.working-quiet')
  if(!await page.locator('.working').innerText().then(t=>t.includes('Sin salida nueva'))) throw Error('Falta el aviso de silencio')
  await page.locator('.tool-live-output').click()
  await page.waitForSelector('.runlog-command')
  if(!await page.locator('.runlog-command').innerText().then(t=>t.includes('npm run test:texts'))) throw Error('No muestra el comando actual')
  await page.waitForSelector('text=Salida del proceso de prueba')
  await page.getByRole('button',{name:'Todo',exact:true}).click()
  await page.waitForSelector('.log-line')
  await page.getByRole('button',{name:'Salida',exact:true}).click()
  await page.evaluate(()=>window.workingTest.signal())
  await page.waitForSelector('.working-quiet',{state:'detached'})
  await page.getByRole('button',{name:'Detener',exact:true}).click()
  if(!await page.evaluate(()=>window.workingTest.cancelled)) throw Error('Detener dejó de funcionar')
  await page.screenshot({path:join(data,'working.png')})
  console.log('PASS: acción silenciosa, abrir salida, comando, stderr, filtros, actividad y detener. '+join(data,'working.png'))

} finally {
  await app?.close(); await server?.close(); rmSync(fixture,{force:true})
}
