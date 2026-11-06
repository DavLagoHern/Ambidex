// Popup real con respuestas simuladas: nunca canjea reinicios de la cuenta del usuario.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { _electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const fixture = join(root, 'tests/.usage-fixture.tsx')
const data = mkdtempSync(join(tmpdir(), 'ambidex-usage-test-'))
const require = createRequire(import.meta.url)
let app, server
try {
  writeFileSync(fixture, `import React from 'react'; import {createRoot} from 'react-dom/client';
import {UsagePopup} from '../src/renderer/src/components/UsagePopup';
import {setApp} from '../src/renderer/src/lib/app-store';
import {api} from '../src/renderer/src/lib/api';
import '../src/renderer/src/styles.css';
document.body.classList.add('dark');
const values = {codex:{agent:'codex', source:'live', windows:[{label:'Semana',usedPercent:61,resetsAt:Date.now()/1000+86400}],updatedAt:Date.now(),resetCredits:{availableCount:2}},claude:{agent:'claude',source:'stream',windows:[{label:'Semana',usedPercent:28}],updatedAt:Date.now()}};
const calls = {keys:[],external:''}; (window as any).usageTest={calls, empty:()=>{values.codex.resetCredits.availableCount=0;setApp({limits:{...values}})}};
api.agentLimits = async()=>values as any;
api.openExternal = async(url)=>{calls.external=url};
api.resetCredit = async(key)=>{calls.keys.push(key);if(calls.keys.length===1)throw Error('Fallo de red simulado');values.codex.resetCredits.availableCount=1;return 'alreadyRedeemed'};
setApp({limits:values as any});
createRoot(document.getElementById('root')).render(<UsagePopup onClose={()=>{document.querySelector('.overlay')?.remove()}}/>);`)
  server = await createServer({configFile:false,root,resolve:{alias:{'@shared':join(root,'src/shared')}},plugins:[react(),{name:'fixture',configureServer(s){s.middlewares.use(async(req,res,next)=>{if(req.url!=='/')return next();res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/', '<div id="root"></div><script type="module" src="/tests/.usage-fixture.tsx"></script>'))})}}],server:{host:'127.0.0.1',port:0}})
  await server.listen()
  const env = {...process.env,AMBIDEX_USER_DATA:data,ELECTRON_RENDERER_URL:`http://127.0.0.1:${server.httpServer.address().port}`};delete env.ELECTRON_RUN_AS_NODE
  app = await _electron.launch({executablePath:require('electron'),args:[join(root,'out/main/index.js')],env})
  const page = await app.firstWindow()
  await page.waitForSelector('text=2 disponibles')
  if (await page.evaluate(()=>window.usageTest.calls.keys.length)!==0) throw Error('Canje automático inesperado')
  await page.getByRole('button',{name:'Usar un reinicio',exact:true}).click()
  await page.waitForSelector('text=Fallo de red simulado')
  await page.getByRole('button',{name:'Usar un reinicio',exact:true}).click()
  await page.waitForSelector('text=Este reinicio ya se había aplicado.',{exact:false})
  const keys = await page.evaluate(()=>window.usageTest.calls.keys)
  if(keys.length!==2 || keys[0]!==keys[1]) throw Error('El reintento cambió la clave de idempotencia')
  await page.waitForSelector('text=1 disponible')
  await page.getByRole('button',{name:'Abrir uso de Claude'}).click()
  if(await page.evaluate(()=>window.usageTest.calls.external)!=='https://claude.ai/settings/usage') throw Error('Destino Claude incorrecto')
  await page.screenshot({path:join(data,'usage-popup.png')})
  await page.evaluate(()=>window.usageTest.empty())
  await page.waitForFunction(()=>document.querySelector('.usage-resets button:not(:disabled)')?.textContent==='Abrir uso de Claude')
  if(!await page.getByRole('button',{name:'Usar un reinicio',exact:true}).isDisabled()) throw Error('Se permite canjear sin créditos')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[role="dialog"]',{state:'detached'})
  console.log('PASS: popup, créditos disponibles, reintento idempotente, enlace Claude y estado sin créditos. '+join(data,'usage-popup.png'))
} finally {
  await app?.close(); await server?.close(); rmSync(fixture,{force:true})
}
