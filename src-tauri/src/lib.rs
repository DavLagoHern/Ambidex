mod browser;
mod engine;
mod native;
mod paths;
mod terminal;

use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager};

pub type Result<T> = std::result::Result<T, String>;
pub struct Backend {
    pub data_dir: PathBuf,
    pub roots: Mutex<Vec<PathBuf>>,
    pub engine: engine::Slot,
    pub terminals: terminal::Terminals,
    pub watchers: Mutex<HashMap<String, notify::RecommendedWatcher>>,
    pub browsers: Mutex<HashMap<u64, browser::Page>>,
    pub busy: std::sync::atomic::AtomicUsize,
    pub active_runs: Mutex<std::collections::HashSet<String>>,
    pub exiting: std::sync::atomic::AtomicBool,
    pub reopen_update: std::sync::atomic::AtomicBool,
    pub pending_open: Mutex<Vec<PathBuf>>,
    pub window_generation: std::sync::atomic::AtomicU64,
}

pub fn push(app: &tauri::AppHandle, channel: &str, payload: Value) {
    // Never broadcast privileged project data to guest webviews.
    for (label, view) in app.webviews() {
        if is_ui_label(&label) && trusted(&view) {
            let _ = app.emit_to(
                tauri::EventTarget::webview(label),
                "ambidex:push",
                json!({"channel": channel, "payload": payload}),
            );
        }
    }
}
fn is_ui_label(label: &str) -> bool {
    label == "main" || label.starts_with("panel-") || label.starts_with("web-window-")
}
pub(crate) fn trusted(view: &tauri::Webview) -> bool {
    if !is_ui_label(view.label()) {
        return false;
    }
    let Ok(url) = view.url() else {
        return false;
    };
    app_url(&url)
}
pub(crate) fn app_url(url: &tauri::Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
        || (cfg!(debug_assertions)
            && url.scheme() == "http"
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
            && url.port() == Some(5173))
}

#[tauri::command]
async fn dispatch(
    app: tauri::AppHandle,
    view: tauri::Webview,
    state: tauri::State<'_, Arc<Backend>>,
    channel: String,
    args: Vec<Value>,
) -> Result<Value> {
    if !trusted(&view) || channel.starts_with("engine:") {
        return Err("Origen o canal no permitido".into());
    }
    native::dispatch(&app, state.inner(), view.label(), &channel, &args).await
}

#[tauri::command]
async fn save_attachment(
    view: tauri::Webview,
    state: tauri::State<'_, Arc<Backend>>,
    request: tauri::ipc::Request<'_>,
) -> Result<PathBuf> {
    if !trusted(&view) {
        return Err("Origen no permitido".into());
    }
    let mime = request
        .headers()
        .get("x-ambidex-mime")
        .and_then(|h| h.to_str().ok())
        .ok_or("Falta el tipo de imagen")?
        .to_string();
    let data = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) if bytes.len() <= 8 * 1024 * 1024 => bytes.clone(),
        _ => return Err("Imagen no válida o superior a 8 MB".into()),
    };
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || native::save_image(&state, &data, &mime))
        .await
        .map_err(|e| e.to_string())?
}

pub fn run() {
    let mut builder = tauri::Builder::default();
    // An isolated debug smoke test must not focus or exit into the user's running application.
    if !(cfg!(debug_assertions)
        && std::env::var_os("AMBIDEX_E2E_REPORT").is_some()
        && std::env::var_os("AMBIDEX_TEST").is_some())
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![dispatch, save_attachment])
        .on_page_load(|view, event| {
            if cfg!(debug_assertions) && view.label() == "main" && std::env::var_os("AMBIDEX_E2E_REPORT").is_some() && matches!(event.event(), tauri::webview::PageLoadEvent::Finished) {
                let _ = view.eval(include_str!("test_driver.js"));
            }
        })
        .on_window_event(|window,event| {
            if window.label() == "main" {
                if matches!(event,tauri::WindowEvent::Resized(_)|tauri::WindowEvent::Moved(_)) && !window.is_fullscreen().unwrap_or(false) {
                    if let Some(state)=window.app_handle().try_state::<Arc<Backend>>() {
                        let scale=window.scale_factor().unwrap_or(1.0);
                        if let (Ok(size),Ok(position))=(window.inner_size(),window.outer_position()) {
                            let bounds=json!({"width":size.width as f64/scale,"height":size.height as f64/scale,"x":position.x as f64/scale,"y":position.y as f64/scale});
                            let state=state.inner().clone();
                            let generation=state.window_generation.fetch_add(1,std::sync::atomic::Ordering::SeqCst)+1;
                            tauri::async_runtime::spawn(async move {
                                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                                if generation==state.window_generation.load(std::sync::atomic::Ordering::SeqCst) {
                                    let temp=state.data_dir.join("window.json.tmp");
                                    if let Ok(bytes)=serde_json::to_vec(&bounds) {if std::fs::write(&temp,bytes).is_ok(){let _=std::fs::rename(temp,state.data_dir.join("window.json"));}}
                                }
                            });
                        }
                    }
                }
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close(); let _ = window.hide();
                }
            }
        })
        .on_webview_event(|view,event| {
            if !is_ui_label(view.label()) { return; }
            if let tauri::WebviewEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position }) = event {
                let app=view.app_handle().clone(); let state=app.state::<Arc<Backend>>().inner().clone();
                let paths=paths.clone(); let position=*position; let label=view.label().to_string();
                let scale=view.window().scale_factor().unwrap_or(1.0);
                tauri::async_runtime::spawn_blocking(move || {
                    let data=native::dropped_files(&state,&paths,position.x/scale,position.y/scale);
                    if let Some(view)=app.get_webview(&label) { if trusted(&view) { let _=app.emit_to(tauri::EventTarget::webview(label),"ambidex:push",json!({"channel":"native:drop","payload":data})); } }
                });
            }
        })
        .setup(|app| {
            let data_dir = paths::data_dir()?;
            std::fs::create_dir_all(data_dir.join("logs"))?;
            let state = Arc::new(Backend {
                data_dir, roots: Mutex::new(Vec::new()), engine: engine::Slot::default(),
                terminals: terminal::Terminals::default(), watchers: Mutex::new(HashMap::new()),
                browsers: Mutex::new(HashMap::new()), busy: 0.into(),active_runs: Mutex::new(Default::default()), exiting: false.into(), reopen_update: false.into(), pending_open: Mutex::new(Vec::new()),window_generation:0.into(),
            });
            app.manage(state.clone());
            let native_bounds:Option<Value>=std::fs::read(state.data_dir.join("window.json")).ok().and_then(|bytes|serde_json::from_slice(&bytes).ok());
            native::main_window(app)?;
            native::menu(app)?;
            engine::monitor(app.handle().clone(),Arc::downgrade(&state));
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = engine::get(&handle, &state).await {
                    use tauri_plugin_dialog::DialogExt;
                    handle.dialog().message(e).title("No se pudo iniciar Ambidex").show(|_| {});
                } else if let Some(worker)=state.engine.current() {
                    let bounds=match native_bounds {Some(bounds)=>bounds,None=>worker.call("engine:window",vec![]).await.unwrap_or(Value::Null)};
                    {
                        if let Some(w)=handle.get_window("main") {
                            if let (Some(width),Some(height))=(bounds["width"].as_f64(),bounds["height"].as_f64()) {let _=w.set_size(tauri::LogicalSize::new(width.max(640.0),height.max(480.0)));}
                            if let (Some(x),Some(y))=(bounds["x"].as_f64(),bounds["y"].as_f64()) {let _=w.set_position(tauri::LogicalPosition::new(x,y));}
                        }
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("No se pudo iniciar Ambidex")
        .run(|app, event| {
            if let tauri::RunEvent::Opened { urls } = &event {
                let state=app.state::<Arc<Backend>>();
                for url in urls {if let Ok(path)=url.to_file_path(){if path.is_dir(){state.pending_open.lock().unwrap().push(path.clone());crate::push(app,"open-path",json!({"path":path}));}}}
                if let Some(w)=app.get_window("main"){let _=w.show();let _=w.set_focus();}
            }
            if let tauri::RunEvent::Reopen { .. } = &event {
                if let Some(w)=app.get_window("main") { let _=w.show();let _=w.set_focus(); }
            }
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                let state = app.state::<Arc<Backend>>();
                if state.exiting.load(std::sync::atomic::Ordering::SeqCst) { return; }
                api.prevent_exit();
                let state = state.inner().clone();
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
                    if state.busy.load(std::sync::atomic::Ordering::SeqCst) > 0 {
                        let (tx, rx) = tokio::sync::oneshot::channel();
                        app.dialog().message("Hay agentes trabajando. Si sales, se detendrán. El historial queda guardado.")
                            .title("Salir de Ambidex").buttons(MessageDialogButtons::OkCancelCustom("Salir".into(), "Cancelar".into()))
                            .show(move |answer| { let _ = tx.send(answer); });
                        if !rx.await.unwrap_or(false) { return; }
                    }
                    if state.exiting.swap(true, std::sync::atomic::Ordering::SeqCst) { return; }
                    state.terminals.kill_all();
                    state.watchers.lock().unwrap().clear();
                    if let Some(worker) = state.engine.current() {
                        let result=tokio::time::timeout(std::time::Duration::from_secs(6), worker.call("engine:shutdown", vec![])).await;
                        worker.stop().await;
                        if let Ok(Ok(update))=result {
                            let reopen=state.reopen_update.load(std::sync::atomic::Ordering::SeqCst);
                            if update["autoInstall"]==true || reopen { if let Some(source)=update["update"].as_str() {native::install_update(&state,source,reopen);} }
                        }
                    }
                    app.exit(0);
                });
            }
        });
}
