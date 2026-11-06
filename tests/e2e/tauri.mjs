// Full native WebKit smoke test. Uses isolated SQLite data and fake CLI processes, never account quota.
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, symlinkSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createInterface } from 'node:readline'

const cwd = resolve(import.meta.dirname,'../..')
const dir = realpathSync(mkdtempSync(join(tmpdir(),'ambidex-native-e2e-')))
const root = join(dir,'native-e2e'); mkdirSync(root)
const data = join(dir,'data'); mkdirSync(data)
const g = (...args) => execFileSync('git',args,{cwd:root,stdio:'ignore'})
g('init','-q','-b','main');g('config','user.name','Native test');g('config','user.email','native@test')
writeFileSync(join(root,'README.md'),'# Native smoke\n')
const reviewPath='src/components/review/AgentPanel-with-a-long-file-name.tsx'
mkdirSync(join(root,'src/components/review'),{recursive:true})
const before=Array.from({length:100},(_,i)=>`const item${i} = "old value ${i}";`).join('\n')+'\n'
writeFileSync(join(root,reviewPath),before)
g('add','.');g('commit','-qm','initial')
symlinkSync('/etc',join(root,'escape'))
const quote = s => "'"+s.replaceAll("'","'\\''")+"'"
const fakeCli=join(dir,'fake-cli.mjs')
copyFileSync(join(cwd,'tests/fake-cli.mjs'),fakeCli)
const fixtures=join(dir,'fixtures');mkdirSync(fixtures)
for(const agent of ['claude','codex'])copyFileSync(join(cwd,'tests/fixtures/'+agent+'-stream.jsonl'),join(fixtures,agent+'-stream.jsonl'))
const engineCopy=join(dir,'engine.mjs');copyFileSync(join(cwd,'out/engine/index.mjs'),engineCopy)
const shell=join(dir,'shell');writeFileSync(shell,'#!/bin/sh\nexec /bin/zsh -f -i\n',{mode:0o755})
const fake = {}
for (const agent of ['claude','codex']) {
  const path = join(dir,agent)
  const version = agent==='claude'?'Claude 2.1.316':'codex-cli 0.155.1'
  const auth = agent==='claude'?'{"loggedIn":true,"authMethod":"claude.ai"}':'Logged in using ChatGPT'
  writeFileSync(path,`#!/bin/sh\nif [ "$1" = "debug" ]; then printf '%s\n' '{"models":[{"slug":"gpt-6.1-sol","visibility":"list","supported_reasoning_levels":["medium"]}]}'; exit 0; fi\nif [ "$1" = "--version" ]; then printf '%s\\n' ${quote(version)}; exit 0; fi\nif [ "$1" = "auth" ] || [ "$1" = "login" ]; then printf '%s\\n' ${quote(auth)}; exit 0; fi\nexport FAKE_FIXTURE=${quote(join(fixtures,agent+'-stream.jsonl'))}\nexec ${quote(process.execPath)} ${quote(fakeCli)} "$@"\n`,{mode:0o755})
  fake[agent+'Path']=path
}
const env = {...process.env,AMBIDEX_USER_DATA:data,AMBIDEX_TEST:'1',FAKE_HOLD_MS:'400',FAKE_MODE:'replay'}
// Seed with the same engine used by the desktop host, then close it before opening the app.
const engine=spawn(process.execPath,[join(cwd,'out/engine/index.mjs')],{cwd,env,stdio:['pipe','pipe','inherit']})
const pending=new Map();let n=0
const ready=new Promise(resolveReady=>{
  createInterface({input:engine.stdout}).on('line',line=>{
    const message=JSON.parse(line)
    if(message.ready)resolveReady()
    if(message.id&&pending.has(message.id)){const p=pending.get(message.id);pending.delete(message.id);message.error?p.reject(Error(message.error)):p.resolve(message.result)}
  })
})
const call=(channel,...args)=>new Promise((resolve,reject)=>{const id=String(++n);pending.set(id,{resolve,reject});engine.stdin.write(JSON.stringify({id,channel,args})+'\n')})
await ready
await call('settings:save',{...fake,setupComplete:true,autoUpdateClis:false,autoUpdateApp:false,notifications:false})
const project=await call('projects:open',root)
await call('settings:save',{activeProjectId:project.id})
await call('engine:shutdown')
await new Promise(resolveExit=>engine.on('exit',resolveExit))
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Native test</title><h1>Native WebKit</h1><input aria-label="Name"><button onclick="document.querySelector(\'h1\').textContent=\'Clicked\'">Click</button>')})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const report=join(dir,'report.json')
const context={root,reviewPath,url:`http://127.0.0.1:${server.address().port}`,png:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII='}
const binary=process.env.E2E_APP||join(cwd,'src-tauri/target/debug/ambidex')
assert(existsSync(binary),'Build first: npm run build:assets && cargo build --features tauri/custom-protocol --manifest-path src-tauri/Cargo.toml')
// Launch a proper .app through Launch Services. Unbundled macOS WebKit views can suspend timers
// when another test panel takes focus, which makes a long UI test wait indefinitely.
const bundle=join(dir,'Ambidex Native Test.app')
mkdirSync(join(bundle,'Contents/MacOS'),{recursive:true})
copyFileSync(binary,join(bundle,'Contents/MacOS/ambidex'))
writeFileSync(join(bundle,'Contents/Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.ambidex.native-test</string><key>CFBundleExecutable</key><string>ambidex</string><key>CFBundleName</key><string>Ambidex Native Test</string><key>CFBundlePackageType</key><string>APPL</string><key>NSHighResolutionCapable</key><true/><key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>`)
execFileSync('codesign',['--force','--sign','-',bundle],{stdio:'ignore'})
const log=join(dir,'native.log')
const launchEnv={AMBIDEX_USER_DATA:data,AMBIDEX_TEST:'1',FAKE_HOLD_MS:'400',FAKE_MODE:'replay',AMBIDEX_NODE_BIN:process.execPath,AMBIDEX_ENGINE_PATH:engineCopy,SHELL:shell,AMBIDEX_E2E_REPORT:report,AMBIDEX_E2E_CONTEXT:JSON.stringify(context)}
const openArgs=['-n','-W','--stdout',log,'--stderr',log]
for(const[key,value]of Object.entries(launchEnv))if(value!==undefined)openArgs.push('--env',key+'='+value)
openArgs.push(bundle)
let result,appPid
const app=spawn('/usr/bin/open',openArgs,{cwd,stdio:'ignore'})
const processTable=()=>execFileSync('ps',['-axo','pid=,command='],{encoding:'utf8'}).split('\n')
for(let i=0;i<100&&!appPid;i++){
  const line=processTable().find(line=>line.includes(join(bundle,'Contents/MacOS/ambidex')))
  if(line)appPid=Number(line.trim().split(/\s/)[0])
  else await new Promise(r=>setTimeout(r,100))
}
assert(appPid,'Native test application did not launch')
let logs=''
console.log('Native test data:',dir)
try {
  const deadline=Date.now()+120000
  while(!existsSync(report)&&Date.now()<deadline&&app.exitCode===null)await new Promise(r=>setTimeout(r,200))
  logs=existsSync(log)?readFileSync(log,'utf8'):''
  assert(existsSync(report),'Native test produced no report. '+(existsSync(report+'.progress')?readFileSync(report+'.progress','utf8'):'No progress')+logs+'\n'+(existsSync(join(data,'logs/engine.log'))?readFileSync(join(data,'logs/engine.log'),'utf8'):''))
  result=JSON.parse(readFileSync(report,'utf8'))
  for(const test of result.results)console.log(`${test.ok?'✓':'✗'} ${test.name}${test.ok?` (${test.ms} ms)`:'\n'+test.error}`)
  assert(result.results.length===17,'Not all native checks ran')
  assert(result.results.every(t=>t.ok),'Some native tests failed. '+logs)
  console.log('All native WebKit integration checks passed.')
} finally {
  try{process.kill(appPid,'SIGTERM')}catch{}
  server.close();app.kill('SIGTERM')
  await new Promise(r=>setTimeout(r,500))
  try{process.kill(appPid,0);process.kill(appPid,'SIGKILL')}catch{}
  rmSync(bundle,{recursive:true,force:true})
}

const db=new DatabaseSync(join(data,'ambidex.db'),{readOnly:true})
assert(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(result.sessionId).n>0)
assert.equal(db.prepare('SELECT title FROM threads WHERE id = ?').get(result.threadId).title,'Native thread')
assert.equal(JSON.parse(db.prepare('SELECT ui_state FROM projects WHERE id = ?').get(result.projectId).ui_state).nativeSmoke,true)
assert(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'file.write'").get().n>0)
db.close()
console.log('✓ SQLite history, threads and project state survive native host exit.')
