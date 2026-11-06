(async () => {
  if (window.__ambidexNativeTest) return;
  window.__ambidexNativeTest = true;
  const logError=value=>window.__TAURI_INTERNALS__.invoke('dispatch',{channel:'test:jsError',args:[String(value)]});
  const oldError=console.error;console.error=(...args)=>{logError(args.map(String).join(' '));oldError.apply(console,args)};
  addEventListener('error',e=>logError(e.message+' '+e.error?.stack));
  addEventListener('unhandledrejection',e=>logError(String(e.reason)+' '+e.reason?.stack));
  const sleep = ms => new Promise(r => setTimeout(r,ms));
  const until = async (fn, ms=15000) => {const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await sleep(40)}throw Error('Tiempo de espera agotado')};
  const results=[];
  const progress=value=>window.__TAURI_INTERNALS__.invoke('dispatch',{channel:'test:progress',args:[value]});
  const check=async(name,fn)=>{await progress({name,phase:'start',hidden:document.hidden,focused:document.hasFocus(),text:document.body.innerText.slice(0,500),results});const start=performance.now();try{await fn();results.push({name,ok:true,ms:Math.round(performance.now()-start)})}catch(e){results.push({name,ok:false,error:String(e)+'\n'+String(e.stack||'')})}await progress({name,phase:'done',results})};
  const assert=(v,message='Comprobación fallida')=>{if(!v)throw Error(message)};
  await until(()=>window.bridge);
  const invoke=(channel,...args)=>window.bridge.invoke(channel,...args);
  const context=await invoke('test:context');
  const {root,url}=context;
  let project,session,thread;
  await check('React renders inside WebKit',async()=>{await until(()=>document.querySelector('.tabbar'));await until(()=>document.body.innerText.includes('native-e2e'));});
  await check('Native runtime and existing SQLite projects',async()=>{const info=await invoke('app:info');assert(info.runtime.includes('Rust'));const projects=await invoke('projects:list');project=projects.find(p=>p.path===root);assert(project&&project.isOpen);});
  await check('Rust files, symlink containment and image attachments',async()=>{
    await invoke('fs:write',root+'/native.txt','escrito desde Rust 🦀');
    assert((await invoke('fs:read',root+'/native.txt')).content==='escrito desde Rust 🦀');
    assert((await invoke('fs:list',root)).some(e=>e.name==='native.txt'));
    let blocked=false;try{await invoke('fs:read',root+'/escape/passwd')}catch{blocked=true}assert(blocked,'Symlink escape was allowed');
    const bytes=Array.from(Uint8Array.from(atob(context.png),c=>c.charCodeAt(0)));
    const path=await invoke('attachments:save',bytes,'image/png');assert((await invoke('attachments:read',path)).startsWith('data:image/png;base64,'));
  });
  await check('Rust watcher reports actual changes',async()=>{
    let changed=false;const off=window.bridge.on('fs:changed',p=>{if(p.projectId===project.id&&p.paths.some(path=>path.endsWith('/watch.txt')))changed=true});
    await invoke('fs:watch',project.id,root);await invoke('fs:write',root+'/watch.txt','watch');await until(()=>changed);off();await invoke('fs:unwatch',project.id);
  });
  await check('Native PTY, Unicode, resize and shared scrollback',async()=>{
    let output='';const off=window.bridge.on('term:data',p=>{if(p.id==='e2e')output+=p.data});
    await invoke('term:create','e2e',{cwd:root});await invoke('term:resize','e2e',110,32);
    await invoke('term:write','e2e',"printf '\\n%s_%s\\n' 'NATIVE' 'PTY_🦀'\r");await until(()=>output.includes('NATIVE_PTY_🦀'));
    assert((await invoke('term:create','e2e',{cwd:root})).buffer.includes('NATIVE_PTY_🦀'));await invoke('term:kill','e2e');off();
  });
  await check('Git staging, commits, branches and history',async()=>{
    assert((await invoke('git:status',root)).isRepo);await invoke('git:stage',root,['native.txt','watch.txt']);await invoke('git:commit',root,'native integration',false);
    assert((await invoke('git:log',root,10,0,false))[0].subject==='native integration');assert((await invoke('git:branches',root)).some(b=>b.current));
  });
  for(const agent of ['claude','codex'])await check(agent+' streaming persists and reaches the UI event bridge',async()=>{
    session=await invoke('sessions:create',project.id,{agent,title:'Native '+agent});let received=false;
    const off=window.bridge.on('session:items',p=>{if(p.sessionId===session.id)received=true});
    const started=await invoke('sessions:send',session.id,'Di HOLA');assert(started.runId);
    await until(async()=>{const runs=await invoke('runs:recent',project.id,10);return runs.find(r=>r.id===started.runId&&r.status!=='running')});
    const messages=await invoke('sessions:messages',session.id);assert(received);assert(messages.some(m=>m.type==='assistant'&&m.text.includes('HOLA')),JSON.stringify(messages));off();
  });
  await check('Threads, queue and project layout persist',async()=>{
    thread=await invoke('threads:create',project.id);await invoke('threads:rename',thread.id,'Native thread');
    const queued=await invoke('queue:add',{projectId:project.id,threadId:thread.id,prompt:'En cola'});
    assert((await invoke('queue:list',project.id)).some(q=>q.id===queued.id));await invoke('queue:update',queued.id,'Editado');await invoke('queue:remove',queued.id);
    await invoke('projects:saveUi',project.id,{nativeSmoke:true});assert((await invoke('projects:getUi',project.id)).nativeSmoke);
  });
  await check('Cancellation crosses native IPC and terminates the run',async()=>{
    const canceled=await invoke('sessions:create',project.id,{agent:'claude',title:'Cancel'});
    const run=await invoke('sessions:send',canceled.id,'Cancelar este turno');
    assert(await invoke('test:park')===false,'An active agent was parked');
    await invoke('sessions:cancel',canceled.id);
    const final=await until(async()=>(await invoke('runs:recent',project.id,20)).find(r=>r.id===run.runId&&r.status!=='running'));
    assert(final.status==='cancelled',final.status);
  });
  await check('React WebPanel creates and controls a native child view',async()=>{
    await invoke('panel:openWeb',project.id,url);
    const page=await until(()=>{const p=document.querySelector('.web-page.on');return p&&typeof p.getWebContentsId==='function'?p:null});
    await until(async()=>{try{return await invoke('test:browserEval',page.getWebContentsId(),'document.title')==='Native test'}catch{return false}});
    await page.loadURL(url+'/?native-navigation=1');
    await until(()=>page.getURL().includes('native-navigation=1'));
    await until(()=>page.canGoBack());page.goBack();await until(()=>!page.getURL().includes('native-navigation=1'));
    await until(()=>page.canGoForward());page.goForward();await until(()=>page.getURL().includes('native-navigation=1'));
    await until(async()=>await invoke('test:browserVisible',page.getWebContentsId()));
    document.querySelector('.web-tabs button[title="Pestaña nueva (⌘T)"]').click();
    await until(()=>document.querySelector('.web-page.on')!==page);
    await until(async()=>!(await invoke('test:browserVisible',page.getWebContentsId())));
    const blank=await until(()=>{const p=document.querySelector('.web-page.on');return p&&typeof p.getWebContentsId==='function'?p:null});
    await until(async()=>{try{return !(await invoke('test:browserVisible',blank.getWebContentsId()))}catch{return false}});
    document.querySelector('.web-tab').click();
    await until(async()=>await invoke('test:browserVisible',page.getWebContentsId()));
  });
  const id=750001; let browserStage='create';
  await check('Isolated native browser navigates, captures and denies app IPC',async()=>{
    try { await invoke('browser:create',id,url);browserStage='bounds';await invoke('browser:bounds',id,{x:200,y:200,width:650,height:350,visible:true});
    browserStage='read';await until(async()=>await invoke('test:browserEval',id,"document.querySelector('h1')?.textContent")==='Native WebKit');
    assert(await invoke('test:browserEval',id,'typeof window.bridge')==='undefined');
    await invoke('test:browserEval',id,"window.__ipcDenied=false;window.__TAURI_INTERNALS__?.invoke('dispatch',{channel:'settings:get',args:[]}).then(()=>window.__ipcDenied=false,()=>window.__ipcDenied=true);true");
    const noIPC=await invoke('test:browserEval',id,"typeof window.__TAURI_INTERNALS__==='undefined'");
    if(!noIPC)await until(async()=>await invoke('test:browserEval',id,'window.__ipcDenied'));
    browserStage='screenshot';const capture=await invoke('web:capture',id);assert(capture.url.startsWith('data:image/png;base64,'));
    const typed=await invoke('test:browserEval',id,"document.querySelector('input').focus();document.execCommand('insertText',false,'Rust');document.querySelector('input').value");assert(typed==='Rust');
    await invoke('browser:close',id); } catch(e) { throw new Error(browserStage+': '+String(e)) }
  });
  await check('Panel windows open and synchronize',async()=>{await invoke('panel:open',project.id,'activity');let synced=false;const off=window.bridge.on('panel:sync',p=>{if(p.origin==='e2e')synced=true});await invoke('panel:sync',project.id,'e2e',{terminal:'shared'});await until(()=>synced);off();});
  await check('Idle engine releases its process and concurrent calls wake it safely',async()=>{
    assert(await invoke('test:park')===true);
    assert(await invoke('test:engineRunning')===false);
    let terminal='';const off=window.bridge.on('term:data',p=>{if(p.id==='sleep-terminal')terminal+=p.data});
    await invoke('term:create','sleep-terminal',{cwd:root});
    await invoke('term:write','sleep-terminal',"printf '%s_%s\\n' 'IDLE' 'TERMINAL'\r");
    await until(()=>terminal.includes('IDLE_TERMINAL'));off();await invoke('term:kill','sleep-terminal');
    assert(await invoke('test:engineRunning')===false,'The native terminal woke Node');
    const [settings,projects,messages]=await Promise.all([invoke('settings:get'),invoke('projects:list'),invoke('sessions:messages',session.id)]);
    assert(settings.setupComplete&&projects.some(p=>p.id===project.id));
    assert(messages.some(m=>m.type==='assistant'&&m.text.includes('HOLA')));
    assert(await invoke('test:engineRunning')===true);
  });
  await check('Empty editor defers Monaco; opening a file loads the editor',async()=>{
    const commands=[];const off=window.bridge.on('menu',p=>commands.push(p));
    try{
      await invoke('test:command','toggle-layout');
      try{await until(()=>document.querySelector('.editor-welcome'));}catch(e){await progress({name:'Monaco failure',commands,text:document.body.innerText});throw e}
      assert(commands.length===1,'A native command was delivered more than once across windows');
    }finally{off()}
    const monacoLoaded=()=>[...document.querySelectorAll('link[href]')].some(el=>/\/monaco-[^/]+\.(js|css)/.test(el.href));
    assert(!monacoLoaded(),'Monaco loaded for an empty editor');
    await progress({name:'Monaco',phase:'quick-open'});
    await invoke('test:command','quick-open');
    const row=await until(()=>[...document.querySelectorAll('.palette-item')].find(el=>el.textContent.includes('native.txt')));
    row.click();
    await progress({name:'Monaco',phase:'loading-file'});
    try{await until(()=>document.querySelector('.monaco-editor .view-lines')?.textContent.includes('escrito'),30000);}catch(e){await progress({name:'Monaco failure',text:document.body.innerText,html:document.querySelector('.editor-area')?.outerHTML,links:[...document.querySelectorAll('link')].map(el=>el.href)});throw e}
    assert(monacoLoaded(),'The file editor did not load its Monaco assets');
  });
  await check('Native title bar restores on double click and supports a narrow movable window',async()=>{
    await invoke('test:window',{width:900,height:700,x:180,y:140});
    await until(()=>innerWidth===900&&innerHeight===700);
    assert((await invoke('test:window',{})).resizable,'The main window is not resizable');
    const bar=document.querySelector('.tabbar-drag');
    const doubleClick=()=>{
      bar.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,detail:2,clientX:30,clientY:30}));
      bar.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0,detail:2,clientX:30,clientY:30}));
    };
    doubleClick();await until(async()=>(await invoke('test:window',{})).maximized);
    doubleClick();await until(async()=>!(await invoke('test:window',{})).maximized);
    await until(()=>innerWidth===900&&innerHeight===700);
    const moved=await invoke('test:window',{x:220,y:160});
    assert(Math.abs(moved.x-220)<2&&Math.abs(moved.y-160)<2,'Native window movement failed');
    assert(document.querySelector('.ptab').getAttribute('data-tauri-drag-region')==='false','Project tabs must remain draggable independently of the window');
  });
  await check('Review tabs, diffs and Git rows remain contained while resizing the window',async()=>{
    const rel=context.reviewPath;
    const before=(await invoke('fs:read',root+'/'+rel)).content;
    await invoke('fs:write',root+'/'+rel,before.replace('old value 27','new value 27').replace('old value 72','new value 72')+'const veryLongLine = "'+('long value '.repeat(100))+'";\n');
    const tabs=Array.from({length:12},(_,i)=>({id:'native-review-'+i,kind:'diff',cwd:root,rel,mode:'unstaged',title:'AgentPanel-review-'+i+' (cambios)'}));
    await invoke('panel:sync',project.id,'e2e',{tabs,activeTab:tabs.at(-1).id,layout:'code',sidebar:'git',panels:{sidebar:true,right:false,activity:false,bottom:false},web:{open:false,tabs:[],active:null},popped:[]});
    await invoke('test:command','git-refresh');
    await until(()=>document.querySelector('.diff-editor-host .monaco-diff-editor'));
    await until(()=>document.querySelector('.diff-editor-host[aria-busy="false"]'));
    await until(()=>document.querySelector('.diff-editor-host .view-lines')?.textContent.includes('value'));
    const contained=async(width,height)=>{
      await invoke('test:window',{width,height});await until(()=>innerWidth===width&&innerHeight===height);
      await sleep(100);
      assert(document.documentElement.scrollWidth<=innerWidth+1,'The document overflows horizontally');
      for(const selector of ['.tabbar','.editor-area','.editor-tabs','.diff-bar','.diff-editor-host']){
        const el=document.querySelector(selector);assert(el,selector+' missing');
        assert(el.scrollWidth<=el.clientWidth+1,selector+' overflows its panel');
      }
      const host=document.querySelector('.diff-editor-host').getBoundingClientRect();
      const editor=document.querySelector('.monaco-diff-editor').getBoundingClientRect();
      assert(Math.abs(host.width-editor.width)<3,'The diff did not resize with its panel');
      assert(editor.height>100&&editor.height<=host.height+1,'The diff height escaped its viewport');
      const strip=document.querySelector('.editor-tabs .tabs');
      const selected=strip.querySelector('[aria-selected="true"]').getBoundingClientRect();
      const frame=strip.getBoundingClientRect();
      assert(selected.left>=frame.left-1&&selected.right<=frame.right+1,'The selected review tab is lost outside the tab strip');
    };
    await contained(1200,800);await invoke('test:capture','wide');
    await contained(640,640);
    const strip=document.querySelector('.editor-tabs .tabs'),initial=strip.scrollLeft;
    document.querySelector('button[title="Desplazar pestañas a la izquierda"]').click();
    await until(()=>strip.scrollLeft<initial);
    strip.querySelector('[role="tab"]').click();
    await until(()=>strip.querySelector('[aria-selected="true"]')===strip.firstElementChild);
    await until(()=>document.querySelector('.diff-editor-host[aria-busy="false"]'));
    assert(strip.scrollLeft<2,'Switching tabs did not reveal the selected file');
    const row=await until(()=>document.querySelector('.git-body .file-row[title="'+rel+'"]'));
    assert(row.scrollWidth<=row.clientWidth+1,'Git file rows overflow');
    assert(![...document.querySelectorAll('.file-stats .add,.file-stats .del')].some(el=>/^[+−]0$/.test(el.textContent)),'Empty change counters clutter the Git rows');
    await invoke('test:capture','narrow');
  });
  await invoke('projects:saveUi',project.id,{nativeSmoke:true});
  await invoke('test:report',{results,projectId:project?.id,sessionId:session?.id,threadId:thread?.id});
})().catch(async error=>{try{await window.__TAURI_INTERNALS__.invoke('dispatch',{channel:'test:report',args:[{results:[{name:'driver',ok:false,error:String(error)+'\n'+String(error.stack||'')}]}]})}catch{}});
