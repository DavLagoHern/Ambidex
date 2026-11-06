//! Isolated native WebKit children. Remote pages never receive an IPC capability.
use crate::native::str_arg;
use crate::{Backend, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder},
    LogicalPosition, LogicalSize, Manager,
};

#[derive(Clone)]
pub struct Page {
    pub label: String,
    pub owner: String,
    pub state: Value,
}
pub fn owned(state: &Backend, owner: &str, id: u64) -> Result<Page> {
    state
        .browsers
        .lock()
        .unwrap()
        .get(&id)
        .filter(|p| p.owner == owner)
        .cloned()
        .ok_or("La pestaña no pertenece a esta ventana".into())
}
fn page(state: &Backend, id: u64) -> Result<Page> {
    state
        .browsers
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or("La pestaña está cerrada".into())
}
fn web_url(raw: &str) -> Result<tauri::Url> {
    let u: tauri::Url = raw.parse().map_err(|_| "URL inválida")?;
    if ["http", "https"].contains(&u.scheme()) || raw == "about:blank" {
        Ok(u)
    } else {
        Err("Solo se permiten páginas http(s)".into())
    }
}
fn report(app: &tauri::AppHandle, id: u64, patch: Value) {
    let state = app.state::<Arc<Backend>>();
    let data = {
        let mut pages = state.browsers.lock().unwrap();
        let Some(p) = pages.get_mut(&id) else { return };
        if let Some(fields) = patch.as_object() {
            for (k, v) in fields {
                p.state[k] = v.clone();
            }
        }
        let mut data = p.state.clone();
        data["id"] = json!(id);
        data
    };
    crate::push(app, "browser:state", data.clone());
    if let Some(worker) = state.engine.current() {
        let worker = worker.clone();
        tauri::async_runtime::spawn(async move {
            let _ = worker.call("engine:browser", vec![data]).await;
        });
    }
}
const INIT: &str = r#"(() => {
 const send = data => { try { window.open('ambidex-event://report/?data='+encodeURIComponent(JSON.stringify(data)), '_blank'); } catch {} };
 const short = x => {try{return typeof x==='string'?x:JSON.stringify(x)}catch{return String(x)}};
 for(const level of ['error','warn']) {const old=console[level];console[level]=function(...args){send({issue:{kind:'console',level:level==='warn'?'warning':'error',text:args.map(short).join(' ').slice(0,2000),at:Date.now()}});old.apply(console,args)}};
 addEventListener('error',e=>send({issue:{kind:'console',level:'error',text:e.message||'Error de página',source:e.filename,at:Date.now()}}));
 addEventListener('unhandledrejection',e=>send({issue:{kind:'console',level:'error',text:short(e.reason).slice(0,2000),at:Date.now()}}));
 const fetch0=window.fetch;window.fetch=async function(...args){try{const r=await fetch0.apply(this,args);if(r.status>=400)send({issue:{kind:'network',level:'error',text:r.status+' '+r.url,at:Date.now()}});return r}catch(e){send({issue:{kind:'network',level:'error',text:short(e)+' '+short(args[0]),at:Date.now()}});throw e}};
 addEventListener('keydown',e=>{if(e.metaKey&&!e.altKey&&!e.ctrlKey&&['l','t','w','r','[',']','k','p','b','j','e'].includes(e.key.toLowerCase())){e.preventDefault();send({key:e.key.toLowerCase(),shift:e.shiftKey})}},true);
})()"#;
fn telemetry(app: &tauri::AppHandle, id: u64, url: &tauri::Url) {
    let Some(raw) = url
        .query_pairs()
        .find(|(k, _)| k == "data")
        .map(|(_, v)| v.into_owned())
    else {
        return;
    };
    if raw.len() > 10000 {
        return;
    }
    let Ok(data) = serde_json::from_str::<Value>(&raw) else {
        return;
    };
    if data["issue"].is_object() {
        let state = app.state::<Arc<Backend>>();
        let mut issues = {
            let pages = state.browsers.lock().unwrap();
            pages
                .get(&id)
                .and_then(|p| p.state["issues"].as_array().cloned())
                .unwrap_or_default()
        };
        // Bound logging even if a page continually reports errors.
        if issues.iter().rev().take(20).all(|i| {
            i["at"].as_u64().unwrap_or(0) / 1000 == data["issue"]["at"].as_u64().unwrap_or(0) / 1000
        }) && issues.len() >= 20
        {
            return;
        }
        issues.push(data["issue"].clone());
        if issues.len() > 100 {
            issues.remove(0);
        }
        report(app, id, json!({"issues":issues}));
        crate::push(app, "web:issue", json!({"from":id,"issue":data["issue"]}));
    } else if let Some(key) = data["key"].as_str() {
        if ["l", "t", "w", "r", "[", "]", "k", "p", "b", "j", "e"].contains(&key) {
            crate::push(
                app,
                "web:key",
                json!({"from":id,"key":key,"shift":data["shift"]}),
            );
        }
    }
}
pub async fn dispatch(
    app: &tauri::AppHandle,
    state: &Arc<Backend>,
    owner: &str,
    channel: &str,
    args: &[Value],
) -> Result<Value> {
    let id = args
        .first()
        .and_then(Value::as_u64)
        .ok_or("Pestaña inválida")?;
    if channel == "browser:create" {
        if id > 9_007_199_254_740_991 {
            return Err("Pestaña inválida".into());
        }
        if state.browsers.lock().unwrap().contains_key(&id) {
            return Err("La pestaña ya existe".into());
        }
        let url = web_url(str_arg(args, 1)?)?;
        let label = format!("guest-{id}");
        state.browsers.lock().unwrap().insert(id,Page{label:label.clone(),owner:owner.into(),state:json!({"url":url.as_str(),"loading":true,"back":false,"fwd":false,"issues":[]})});
        let nav_app = app.clone();
        let load_app = app.clone();
        let title_app = app.clone();
        let popup_app = app.clone();
        let builder = WebviewBuilder::new(&label, tauri::WebviewUrl::External(url))
            .initialization_script(INIT)
            .data_store_identifier(crate::paths::web_store(state, true))
            .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny)
            .on_navigation(move |url| {
                if url.scheme() == "ambidex-event" {
                    telemetry(&nav_app, id, url);
                    return false;
                }
                web_url(url.as_str()).is_ok()
            })
            .on_new_window(move |url, _| {
                if url.scheme() == "ambidex-event" {
                    telemetry(&popup_app, id, &url);
                } else if web_url(url.as_str()).is_ok() {
                    crate::push(
                        &popup_app,
                        "web:open",
                        json!({"url":url.as_str(),"from":id}),
                    );
                }
                NewWindowResponse::Deny
            })
            .on_page_load(move |view, event| {
                let loading = matches!(event.event(), PageLoadEvent::Started);
                report(
                    &load_app,
                    id,
                    json!({"url":event.url().as_str(),"loading":loading}),
                );
                if !loading {
                    let app = load_app.clone();
                    let _ = view.with_webview(move |platform| unsafe {
                        let wk = &*(platform.inner() as *const objc2_web_kit::WKWebView);
                        report(
                            &app,
                            id,
                            json!({"back":wk.canGoBack(),"fwd":wk.canGoForward()}),
                        );
                    });
                }
            })
            .on_document_title_changed(move |_, title| {
                report(&title_app, id, json!({"title":title}))
            });
        let parent = app.get_webview(owner).ok_or("Ventana cerrada")?.window();
        let result = parent.add_child(
            builder,
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1.0, 1.0),
        );
        match result {
            Ok(view) => {
                let _ = view.hide();
                report(app, id, json!({}));
                Ok(Value::Null)
            }
            Err(e) => {
                state.browsers.lock().unwrap().remove(&id);
                Err(e.to_string())
            }
        }
    } else {
        let p = owned(state, owner, id)?;
        let view = app.get_webview(&p.label).ok_or("Pestaña cerrada")?;
        match channel {
            "browser:bounds" => {
                let rect = args.get(1).ok_or("Faltan dimensiones")?;
                if rect["visible"] == true {
                    let n = |key: &str| {
                        rect[key]
                            .as_f64()
                            .filter(|v| v.is_finite())
                            .unwrap_or(0.0)
                            .max(0.0)
                    };
                    view.set_bounds(tauri::Rect {
                        position: LogicalPosition::new(n("x"), n("y")).into(),
                        size: LogicalSize::new(n("width").max(1.0), n("height").max(1.0)).into(),
                    })
                    .map_err(|e| e.to_string())?;
                    view.show().map_err(|e| e.to_string())?;
                } else {
                    view.hide().map_err(|e| e.to_string())?;
                }
                Ok(Value::Null)
            }
            "browser:close" => {
                view.close().map_err(|e| e.to_string())?;
                report(app, id, json!({"destroyed":true}));
                state.browsers.lock().unwrap().remove(&id);
                Ok(Value::Null)
            }
            "browser:navigate" => {
                view.navigate(web_url(str_arg(args, 1)?)?)
                    .map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }
            "browser:reload" => {
                view.eval("location.reload()").map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }
            "browser:back" => {
                view.eval("history.back()").map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }
            "browser:forward" => {
                view.eval("history.forward()").map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }
            "browser:stop" => {
                view.eval("window.stop()").map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }
            _ => Err("Commande de visor no permitida".into()),
        }
    }
}
pub async fn host(
    app: &tauri::AppHandle,
    state: &Arc<Backend>,
    channel: &str,
    args: &[Value],
) -> Result<Value> {
    let id = args
        .first()
        .and_then(Value::as_u64)
        .ok_or("Pestaña inválida")?;
    let p = page(state, id)?;
    let view = app.get_webview(&p.label).ok_or("Pestaña cerrada")?;
    // Wry queues scripts until the first load finishes and drops evaluation callbacks in that phase.
    // Wait here so browser tools receive a result instead of a closed reply channel.
    if channel == "browser:eval" || channel == "browser:screenshot" {
        let end = std::time::Instant::now() + Duration::from_secs(15);
        while page(state, id)?.state["loading"] == true {
            if std::time::Instant::now() > end {
                return Err("La página no ha terminado de cargar".into());
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }
    match channel {
        "browser:eval" => eval(&view, str_arg(args, 1)?).await,
        "browser:screenshot" => Ok(json!(STANDARD.encode(screenshot(app, state, id).await?))),
        "browser:input" => {
            input(&view, args.get(1).unwrap_or(&Value::Null))?;
            Ok(Value::Null)
        }
        "browser:insertText" => {
            let text = serde_json::to_string(str_arg(args, 1)?).map_err(|e| e.to_string())?;
            eval(
                &view,
                &format!("document.execCommand('insertText',false,{text})"),
            )
            .await
        }
        "browser:navigate" | "browser:back" => dispatch(app, state, &p.owner, channel, args).await,
        _ => Err("Servicio de visor no permitido".into()),
    }
}
async fn eval(view: &tauri::Webview, script: &str) -> Result<Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let tx = std::sync::Mutex::new(Some(tx));
    view.eval_with_callback(script.to_string(), move |result| {
        if let Some(tx) = tx.lock().unwrap().take() {
            let _ = tx.send(serde_json::from_str::<Value>(&result).unwrap_or(Value::Null));
        }
    })
    .map_err(|e| e.to_string())?;
    tokio::time::timeout(Duration::from_secs(15), rx)
        .await
        .map_err(|_| "La página no respondió")?
        .map_err(|e| e.to_string())
}
#[cfg(target_os = "macos")]
pub async fn screenshot(app: &tauri::AppHandle, state: &Arc<Backend>, id: u64) -> Result<Vec<u8>> {
    let p = page(state, id)?;
    let view = app.get_webview(&p.label).ok_or("Pestaña cerrada")?;
    snapshot(&view).await
}
#[cfg(target_os = "macos")]
pub async fn snapshot(view: &tauri::Webview) -> Result<Vec<u8>> {
    use objc2::{msg_send, ClassType};
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::WKWebView;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let tx = std::sync::Mutex::new(Some(tx));
    view.with_webview(move |platform| unsafe {
        let wk = &*(platform.inner() as *const WKWebView);
        let callback = block2::RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            let result = (|| -> Result<Vec<u8>> {
                if !error.is_null() || image.is_null() {
                    return Err("WebKit no pudo capturar la página".into());
                }
                let image = &*image;
                let data = image
                    .TIFFRepresentation()
                    .ok_or("La página no se ha dibujado")?;
                let allocated = msg_send![NSBitmapImageRep::class(), alloc];
                let bitmap =
                    NSBitmapImageRep::initWithData(allocated, &data).ok_or("Imagen no válida")?;
                let png = bitmap
                    .representationUsingType_properties(
                        NSBitmapImageFileType::PNG,
                        &NSDictionary::new(),
                    )
                    .ok_or("No se pudo convertir a PNG")?;
                Ok(png.to_vec())
            })();
            if let Some(tx) = tx.lock().unwrap().take() {
                let _ = tx.send(result);
            }
        });
        wk.takeSnapshotWithConfiguration_completionHandler(None, &callback);
    })
    .map_err(|e| e.to_string())?;
    tokio::time::timeout(Duration::from_secs(15), rx)
        .await
        .map_err(|_| "La captura tardó demasiado")?
        .map_err(|e| e.to_string())?
}
#[cfg(not(target_os = "macos"))]
pub async fn screenshot(_: &tauri::AppHandle, _: &Arc<Backend>, _: u64) -> Result<Vec<u8>> {
    Err("La captura nativa requiere macOS".into())
}
#[cfg(target_os = "macos")]
fn input(view: &tauri::Webview, event: &Value) -> Result<()> {
    use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType};
    use objc2_foundation::{NSPoint, NSString};
    use objc2_web_kit::WKWebView;
    let event = event.clone();
    view.with_webview(move|platform|unsafe{
        let wk=&*(platform.inner()as*const WKWebView);let Some(window)=wk.window()else{return};
        let kind=event["type"].as_str().unwrap_or_default();
        if kind=="mouseDown"||kind=="mouseUp"{
            let x=event["x"].as_f64().unwrap_or(0.0);let y=event["y"].as_f64().unwrap_or(0.0);
            let local=NSPoint::new(x,if wk.isFlipped(){y}else{wk.frame().size.height-y});let point=wk.convertPoint_toView(local,None);
            if let Some(e)=NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(if kind=="mouseDown"{NSEventType::LeftMouseDown}else{NSEventType::LeftMouseUp},point,NSEventModifierFlags::empty(),0.0,window.windowNumber(),None,0,1,1.0){window.sendEvent(&e);}
        }else if kind=="keyDown"||kind=="keyUp"{
            let code=event["keyCode"].as_str().unwrap_or_default();
            let(ch,key)=match code{"Enter"=>("\r",36),"Tab"=>("\t",48),"Escape"=>("\u{1b}",53),"Backspace"=>("\u{7f}",51),"Space"=>(" ",49),"Down"=>("\u{f701}",125),"Up"=>("\u{f700}",126),"Left"=>("\u{f702}",123),"Right"=>("\u{f703}",124),"Delete"=>("\u{f728}",117),"Home"=>("\u{f729}",115),"End"=>("\u{f72b}",119),"PageUp"=>("\u{f72c}",116),"PageDown"=>("\u{f72d}",121),_=>(code,0)};
            let chars=NSString::from_str(ch);
            if let Some(e)=NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(if kind=="keyDown"{NSEventType::KeyDown}else{NSEventType::KeyUp},NSPoint::new(0.0,0.0),NSEventModifierFlags::empty(),0.0,window.windowNumber(),None,&chars,&chars,false,key){window.sendEvent(&e);}
        }
    }).map_err(|e|e.to_string())
}
#[cfg(not(target_os = "macos"))]
fn input(_: &tauri::Webview, _: &Value) -> Result<()> {
    Err("La entrada nativa requiere macOS".into())
}

#[cfg(all(debug_assertions, target_os = "macos"))]
pub async fn visible(app: &tauri::AppHandle, state: &Backend, id: u64) -> Result<Value> {
    let p = page(state, id)?;
    let view = app.get_webview(&p.label).ok_or("Pestaña cerrada")?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    view.with_webview(move |platform| unsafe {
        let wk = &*(platform.inner() as *const objc2_web_kit::WKWebView);
        let _ = tx.send(!wk.isHidden());
    })
    .map_err(|e| e.to_string())?;
    Ok(json!(rx.await.map_err(|e| e.to_string())?))
}
