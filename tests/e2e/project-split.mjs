// Dos proyectos completos en Electron aislado, sin lanzar tareas de agentes.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { _electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const fixture = join(root, 'tests/.project-split-fixture.tsx')
const data = mkdtempSync(join(tmpdir(), 'ambidex-project-split-'))
const require = createRequire(import.meta.url)
let app, server
try {
  const paths = ['Alpha', 'Beta', 'Gamma'].map(n => { const path = join(data, n); mkdirSync(path); return path })
  writeFileSync(fixture, `import React from 'react'; import {createRoot} from 'react-dom/client';
import App from '../src/renderer/src/App';
import {api} from '../src/renderer/src/lib/api';
import * as store from '../src/renderer/src/lib/app-store';
import '../src/renderer/src/styles.css';
await api.saveSettings({setupComplete:true});
(window as any).splitTest=store;
createRoot(document.getElementById('root')).render(<App/>);`)
  server = await createServer({configFile:false,root,resolve:{alias:{'@shared':join(root,'src/shared')}},plugins:[react(),{name:'fixture',configureServer(s){s.middlewares.use(async(req,res,next)=>{if(req.url!=='/')return next();res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/', '<div id="root"></div><script type="module" src="/tests/.project-split-fixture.tsx"></script>'))})}}],server:{host:'127.0.0.1',port:0}})
  await server.listen()
  const env = {...process.env,AMBIDEX_USER_DATA:data,ELECTRON_RENDERER_URL:`http://127.0.0.1:${server.httpServer.address().port}`};delete env.ELECTRON_RUN_AS_NODE
  app = await _electron.launch({executablePath:require('electron'),args:[join(root,'out/main/index.js')],env})
  const page = await app.firstWindow()
  await page.waitForFunction(()=>window.splitTest?.getApp().ready)
  for (const path of paths) await page.evaluate(p=>window.splitTest.openProjectPath(p),path)
  const ids = await page.evaluate(()=>window.splitTest.getApp().openIds)
  await page.evaluate(async ids=>{
    await window.splitTest.updateProject(ids[0],{color:'#e8825f'})
    await window.splitTest.updateProject(ids[1],{color:'#8bd17c'})
    await window.splitTest.updateProject(ids[2],{color:'#5fb3e8'})
  },ids)
  await page.evaluate(id=>window.splitTest.activate(id),ids[0])
  await page.getByRole('button',{name:'Dividir entre dos proyectos',exact:true}).click()
  await page.waitForFunction(()=>document.querySelectorAll('.project-space.visible .workspace.active').length===2)
  for (const id of ids.slice(0,2)) {
    const side = page.locator(`[data-project-space="${id}"]`)
    if(await side.locator('.activitybar').count()!==1 || await side.locator('.statusbar').count()!==1 || await side.locator('.project-space-head .layout-ctl').count()!==1) throw Error('Faltan menús propios')
  }
  // Cada mitad tiene pestañas reales y su color; no hay una línea global que invada la otra.
  if(await page.locator('.tabbar').evaluate(el=>getComputedStyle(el,'::after').display)!=='none') throw Error('La línea global invade las mitades')
  const leftTabs = page.getByRole('tablist',{name:'Proyectos del lado izquierdo'})
  const rightTabs = page.getByRole('tablist',{name:'Proyectos del lado derecho'})
  if(await leftTabs.getByRole('tab',{name:'Alpha',selected:true}).count()!==1 || await rightTabs.getByRole('tab',{name:'Beta',selected:true}).count()!==1) throw Error('No se distingue la pestaña seleccionada de cada lado')
  const colors = await page.locator('.project-space.visible .project-space-head').evaluateAll(heads=>heads.map(el=>getComputedStyle(el).borderTopColor))
  if(colors[0]!=='rgb(232, 130, 95)' || colors[1]!=='rgb(139, 209, 124)') throw Error('Cada lado debe mostrar su propio color')
  await page.locator(`[data-project-space="${ids[1]}"] .ab-btn`).first().click()
  if(await page.evaluate(()=>window.splitTest.getApp().activeId)!==ids[1]) throw Error('Foco de proyecto incorrecto')
  // La navegación local elige el lado aunque el foco estuviera en el contrario.
  await leftTabs.getByRole('tab',{name:'Gamma',exact:true}).click()
  await page.waitForFunction(ids=>JSON.stringify(window.splitTest.getApp().projectSplit)===JSON.stringify([ids[2],ids[1]]),ids)
  await leftTabs.getByRole('tab',{name:'Alpha',exact:true}).click()
  await page.waitForFunction(ids=>JSON.stringify(window.splitTest.getApp().projectSplit)===JSON.stringify([ids[0],ids[1]]),ids)
  // Elegir una pestaña de la derecha conserva la izquierda.
  await rightTabs.getByRole('tab',{name:'Gamma',exact:true}).click()
  await page.waitForFunction(id=>document.querySelector(`[data-project-space="${id}"]`)?.classList.contains('visible'),ids[2])
  if(!await page.locator(`[data-project-space="${ids[0]}"]`).isVisible()) throw Error('El lado izquierdo desapareció')
  const rightColor = await page.locator(`[data-project-space="${ids[2]}"] .project-space-head`).evaluate(el=>getComputedStyle(el).borderTopColor)
  if(rightColor!=='rgb(95, 179, 232)') throw Error('La derecha conserva el color del proyecto anterior')
  await rightTabs.getByRole('tab',{name:'Gamma',selected:true}).focus()
  await page.keyboard.press('Home')
  await page.waitForFunction(ids=>window.splitTest.getApp().projectSplit[1]===ids[1],ids)
  if(!await rightTabs.getByRole('tab',{name:'Beta',selected:true}).evaluate(el=>el===document.activeElement)) throw Error('Se pierde el foco al cambiar pestaña con teclado')
  await page.keyboard.press('End')
  await page.waitForFunction(ids=>window.splitTest.getApp().projectSplit[1]===ids[2],ids)
  const divider = page.getByRole('separator',{name:'Ancho de los proyectos'})
  await divider.focus(); await page.keyboard.press('ArrowRight')
  if(await divider.getAttribute('aria-valuenow')!=='55') throw Error('No ajusta el ancho con teclado')
  await divider.dblclick()
  await page.waitForFunction(()=>document.querySelector('.project-divider').getAttribute('aria-valuenow')==='50')
  // Estado de cada proyecto independiente.
  await page.evaluate(id=>window.splitTest.projectStore(id).set({sidebar:'explorer'}),ids[0])
  await page.evaluate(id=>window.splitTest.projectStore(id).set({sidebar:'git'}),ids[2])
  const leftView = await page.locator(`[data-project-space="${ids[0]}"] .ab-btn.on`).getAttribute('title')
  const rightView = await page.locator(`[data-project-space="${ids[2]}"] .ab-btn.on`).getAttribute('title')
  if(leftView===rightView) throw Error('Las barras laterales comparten estado')
  const box = await divider.boundingBox()
  await page.mouse.move(box.x+box.width/2, box.y+100)
  await page.mouse.down(); await page.mouse.move(box.x+100, box.y+100); await page.mouse.up()
  if(Number(await divider.getAttribute('aria-valuenow'))<=50) throw Error('No ajusta el ancho al arrastrar')
  await divider.dblclick()
  const leftDraft = page.locator(`[data-project-space="${ids[0]}"] textarea`).last()
  const rightDraft = page.locator(`[data-project-space="${ids[2]}"] textarea`).last()
  await leftDraft.fill('Borrador de Alpha')
  await rightDraft.fill('Borrador de Gamma')
  if(await leftDraft.inputValue()!=='Borrador de Alpha') throw Error('El borrador cruza entre proyectos')
  await page.screenshot({path:join(data,'split.png')})
  await page.setViewportSize({width:1000,height:800})
  const overflow = await page.locator('.project-space.visible .project-space-head').evaluateAll(heads=>heads.some(head=>head.scrollWidth>head.clientWidth))
  if(overflow) throw Error('Las pestañas desplazan los controles fuera del panel estrecho')
  await page.screenshot({path:join(data,'split-narrow.png')})
  // Cerrar uno de los dos proyectos mantiene el otro visible sin huecos.
  await page.evaluate(id=>window.splitTest.closeProject(id),ids[2])
  await page.waitForFunction(()=>!window.splitTest.getApp().projectSplit && document.querySelectorAll('.project-space.visible').length===1)
  if(await page.locator('.tabbar').evaluate(el=>getComputedStyle(el,'::after').display)==='none') throw Error('No vuelve la línea de color en vista individual')
  if(!await page.locator(`[data-project-space="${ids[0]}"]`).isVisible()) throw Error('No conserva el otro proyecto al cerrar')
  if(await leftDraft.inputValue()!=='Borrador de Alpha') throw Error('Se pierde el borrador al salir de la división')
  await page.getByRole('button',{name:'Dividir entre dos proyectos',exact:true}).click()
  await page.getByRole('button',{name:'Ver solo Beta',exact:true}).click()
  await page.waitForFunction(()=>!window.splitTest.getApp().projectSplit)
  console.log('PASS: pestañas locales, colores independientes, dos espacios completos, foco, ancho, paneles independientes y cierre. '+join(data,'split.png'))

} finally {
  await app?.close(); await server?.close(); rmSync(fixture,{force:true})
}
