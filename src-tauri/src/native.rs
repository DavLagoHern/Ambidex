use crate::{engine, paths, Backend, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};
use tauri::{
    menu::{CheckMenuItem, ContextMenu, Menu, MenuItem, PredefinedMenuItem, Submenu},
    Manager,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;

pub fn str_arg(args: &[Value], i: usize) -> Result<&str> {
    args.get(i)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Argumento {i} no válido"))
}
fn arg(args: &[Value], i: usize) -> &Value {
    args.get(i).unwrap_or(&Value::Null)
}
async fn confirm(app: &tauri::AppHandle, args: &[Value]) -> Result<Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let text = format!(
        "{}\n\n{}",
        str_arg(args, 0)?,
        arg(args, 1).as_str().unwrap_or_default()
    );
    app.dialog()
        .message(text)
        .title("Ambidex")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Aceptar".into(),
            "Cancelar".into(),
        ))
        .show(move |ok| {
            let _ = tx.send(ok);
        });
    Ok(json!(rx.await.unwrap_or(false)))
}
async fn folder(app: &tauri::AppHandle) -> Result<Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Abrir carpeta")
        .pick_folder(move |path| {
            let _ = tx.send(path.and_then(|p| p.into_path().ok()));
        });
    Ok(json!(rx.await.map_err(|e| e.to_string())?))
}
pub async fn host(
    app: &tauri::AppHandle,
    state: &Arc<Backend>,
    channel: &str,
    args: &[Value],
) -> Result<Value> {
    match channel {
        "app:confirm" => confirm(app, args).await,
        "browser:openProject" => {
            crate::push(
                app,
                "web:agent-open",
                json!({"projectId":arg(args,0),"url":arg(args,1)}),
            );
            Ok(Value::Null)
        }
        _ if channel.starts_with("browser:") => {
            crate::browser::host(app, state, channel, args).await
        }
        _ => Err("Servicio interno no permitido".into()),
    }
}
pub async fn dispatch(
    app: &tauri::AppHandle,
    state: &Arc<Backend>,
    owner: &str,
    channel: &str,
    args: &[Value],
) -> Result<Value> {
    #[cfg(debug_assertions)]
    if channel.starts_with("test:")
        && std::env::var_os("AMBIDEX_E2E_REPORT").is_some()
        && std::env::var_os("AMBIDEX_TEST").is_some()
    {
        match channel {
            "test:window" => {
                let w = app.get_window(owner).ok_or("Ventana cerrada")?;
                let data = arg(args, 0);
                if let (Some(width), Some(height)) =
                    (data["width"].as_f64(), data["height"].as_f64())
                {
                    w.set_size(tauri::LogicalSize::new(width, height))
                        .map_err(|e| e.to_string())?;
                }
                if let (Some(x), Some(y)) = (data["x"].as_f64(), data["y"].as_f64()) {
                    w.set_position(tauri::LogicalPosition::new(x, y))
                        .map_err(|e| e.to_string())?;
                }
                let scale = w.scale_factor().map_err(|e| e.to_string())?;
                let size = w
                    .inner_size()
                    .map_err(|e| e.to_string())?
                    .to_logical::<f64>(scale);
                let pos = w
                    .outer_position()
                    .map_err(|e| e.to_string())?
                    .to_logical::<f64>(scale);
                return Ok(
                    json!({"width":size.width,"height":size.height,"x":pos.x,"y":pos.y,"maximized":w.is_maximized().unwrap_or(false),"resizable":w.is_resizable().unwrap_or(false)}),
                );
            }
            "test:capture" => {
                let view = app.get_webview(owner).ok_or("Ventana cerrada")?;
                let bytes = crate::browser::snapshot(&view).await?;
                let suffix = if arg(args, 0).as_str() == Some("wide") {
                    ".wide.png"
                } else {
                    ".narrow.png"
                };
                std::fs::write(std::env::var("AMBIDEX_E2E_REPORT").unwrap() + suffix, bytes)
                    .map_err(|e| e.to_string())?;
                return Ok(Value::Null);
            }
            "test:jsError" => {
                use std::io::Write;
                let path = std::env::var("AMBIDEX_E2E_REPORT").unwrap() + ".errors";
                if let Ok(mut f) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(path)
                {
                    let _ = writeln!(f, "{}", arg(args, 0));
                }
                return Ok(Value::Null);
            }
            "test:progress" => {
                let path = std::env::var("AMBIDEX_E2E_REPORT").unwrap() + ".progress";
                {
                    use std::io::Write;
                    if let Ok(mut f) = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(path.clone() + ".trace")
                    {
                        let _ = writeln!(f, "{}", arg(args, 0));
                    }
                }
                std::fs::write(path, serde_json::to_vec_pretty(arg(args, 0)).unwrap())
                    .map_err(|e| e.to_string())?;
                return Ok(Value::Null);
            }
            "test:command" => {
                if let Some(w) = app.get_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                crate::push(app, "menu", json!({"command":arg(args,0)}));
                return Ok(Value::Null);
            }
            "test:park" => return Ok(json!(engine::park(state, true).await?)),
            "test:engineRunning" => return Ok(json!(state.engine.current().is_some())),
            "test:context" => {
                return serde_json::from_str(
                    &std::env::var("AMBIDEX_E2E_CONTEXT").map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())
            }
            "test:browserVisible" => {
                return crate::browser::visible(
                    app,
                    state,
                    arg(args, 0).as_u64().ok_or("Pestaña inválida")?,
                )
                .await
            }
            "test:browserEval" => {
                return crate::browser::host(app, state, "browser:eval", args).await
            }
            "test:report" => {
                let path = std::env::var_os("AMBIDEX_E2E_REPORT").ok_or("Falta informe")?;
                std::fs::write(
                    path,
                    serde_json::to_vec_pretty(arg(args, 0)).map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
                app.exit(0);
                return Ok(Value::Null);
            }
            _ => return Err("Prueba desconocida".into()),
        }
    }
    match channel {
        "app:ready" => {
            let paths: Vec<_> = state.pending_open.lock().unwrap().drain(..).collect();
            for path in paths {
                crate::push(app, "open-path", json!({"path":path}));
            }
            Ok(Value::Null)
        }
        "window:close" => {
            app.get_webview(owner)
                .ok_or("Ventana cerrada")?
                .window()
                .close()
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "app:pickFolder" | "git:addRepo" => folder(app).await,
        "app:confirm" => confirm(app, args).await,
        "app:info" => {
            let db = paths::db_path(state);
            Ok(
                json!({"version":env!("CARGO_PKG_VERSION"),"runtime":"Tauri 2 · Rust", "webview":"WebKit", "dataDir":state.data_dir,"dbPath":db,"dbSize":std::fs::metadata(db).map(|m|m.len()).unwrap_or(0)}),
            )
        }
        "app:openExternal" => {
            let url: tauri::Url = str_arg(args, 0)?.parse().map_err(|_| "URL inválida")?;
            if !matches!(url.scheme(), "http" | "https" | "mailto") {
                return Err("Protocolo no permitido".into());
            }
            app.opener()
                .open_url(url.as_str(), None::<&str>)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "app:revealData" => {
            app.opener()
                .reveal_item_in_dir(paths::db_path(state))
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "app:reveal" | "extensions:reveal" | "app:openInVSCode" => {
            engine::get(app, state).await?;
            let path = if channel == "extensions:reveal" {
                paths::extension(state, str_arg(args, 0)?)?
            } else {
                paths::check(state, str_arg(args, 0)?)?
            };
            if channel == "app:openInVSCode" {
                let output = tokio::process::Command::new("open")
                    .args(["-a", "Visual Studio Code"])
                    .arg(path)
                    .output()
                    .await
                    .map_err(|e| e.to_string())?;
                if !output.status.success() {
                    return Err("No se pudo abrir VS Code".into());
                }
            } else {
                app.opener()
                    .reveal_item_in_dir(path)
                    .map_err(|e| e.to_string())?;
            }
            Ok(Value::Null)
        }
        "app:contextMenu" => context_menu(app, owner, arg(args, 0)).await,
        "term:create" => crate::terminal::create(app, state, str_arg(args, 0)?, arg(args, 1)).await,
        "term:write" => {
            state
                .terminals
                .write(str_arg(args, 0)?, str_arg(args, 1)?)?;
            Ok(Value::Null)
        }
        "term:resize" => {
            state.terminals.resize(
                str_arg(args, 0)?,
                arg(args, 1).as_u64().unwrap_or(100).clamp(2, 1000) as u16,
                arg(args, 2).as_u64().unwrap_or(30).clamp(2, 1000) as u16,
            )?;
            Ok(Value::Null)
        }
        "term:kill" => {
            state.terminals.kill(str_arg(args, 0)?);
            Ok(Value::Null)
        }
        "fs:list" | "fs:read" | "fs:write" | "fs:image" | "extensions:read"
        | "attachments:read" | "attachments:save" => {
            if state.roots.lock().unwrap().is_empty() {
                engine::get(app, state).await?;
            }
            let file_state = state.clone();
            let file_channel = channel.to_string();
            let file_args = args.to_vec();
            let result = tauri::async_runtime::spawn_blocking(move || {
                files(&file_state, &file_channel, &file_args)
            })
            .await
            .map_err(|e| e.to_string())??;
            if channel == "fs:write" {
                engine::get(app, state)
                    .await?
                    .call(
                        "engine:auditFile",
                        vec![arg(args, 0).clone(), json!(str_arg(args, 1)?.len())],
                    )
                    .await?;
            }
            Ok(result)
        }
        "fs:watch" => {
            engine::get(app, state).await?;
            let dir = paths::check(state, str_arg(args, 1)?)?;
            watch(app, state, str_arg(args, 0)?, dir)?;
            Ok(Value::Null)
        }
        "fs:unwatch" => {
            state.watchers.lock().unwrap().remove(str_arg(args, 0)?);
            Ok(Value::Null)
        }
        "git:clone" => {
            let dir = folder(app).await?;
            if dir.is_null() {
                return Ok(Value::Null);
            }
            engine::get(app, state)
                .await?
                .call("engine:cloneInto", vec![arg(args, 0).clone(), dir])
                .await
        }
        "panel:open" => {
            let project = str_arg(args, 0)?;
            let panel = str_arg(args, 1)?;
            if !["chat", "terminal", "editor", "agents", "activity"].contains(&panel) {
                return Err("Panel inválido".into());
            }
            if uuid::Uuid::parse_str(project).is_err() {
                return Err("Proyecto inválido".into());
            }
            let label = format!("panel-{project}-{panel}");
            let url = format!("index.html#panel={panel}&project={project}");
            window(
                app,
                &label,
                &url,
                if panel == "agents" || panel == "activity" {
                    420.0
                } else {
                    980.0
                },
            )?;
            Ok(Value::Null)
        }
        "panel:sync" => {
            crate::push(
                app,
                "panel:sync",
                json!({"projectId":arg(args,0),"origin":arg(args,1),"patch":arg(args,2)}),
            );
            Ok(Value::Null)
        }
        "panel:openWeb" => {
            crate::push(
                app,
                "web:agent-open",
                json!({"projectId":arg(args,0),"url":arg(args,1)}),
            );
            Ok(Value::Null)
        }
        "web:popout" => {
            let url = str_arg(args, 0)?;
            let label = format!("web-window-{}", uuid::Uuid::new_v4());
            let hash = tauri::Url::parse_with_params("https://localhost/", [("web", url)])
                .map_err(|e| e.to_string())?;
            window(
                app,
                &label,
                &format!("index.html#{}", hash.query().unwrap_or_default()),
                1100.0,
            )?;
            Ok(Value::Null)
        }
        "web:setOnTop" => {
            app.get_webview(owner)
                .ok_or("Ventana cerrada")?
                .window()
                .set_always_on_top(arg(args, 0).as_bool().unwrap_or(false))
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "web:favicon" => Ok(Value::Null),
        "web:active" => {
            let id = arg(args, 1).as_u64();
            if let Some(id) = id {
                crate::browser::owned(state, owner, id)?;
            }
            {
                let mut pages = state.browsers.lock().unwrap();
                for (key, page) in pages.iter_mut() {
                    if page.state["projectId"] == arg(args, 0).clone() {
                        page.state.as_object_mut().unwrap().remove("projectId");
                    }
                    if Some(*key) == id {
                        page.state["projectId"] = arg(args, 0).clone();
                    }
                }
            }
            engine::get(app, state)
                .await?
                .call(
                    "engine:browser",
                    vec![json!({"projectId":arg(args,0),"id":id})],
                )
                .await?;
            Ok(Value::Null)
        }
        "web:revokeAgent" => {
            engine::get(app, state)
                .await?
                .call("engine:revokeWeb", args.to_vec())
                .await
        }
        "web:capture" => {
            let id = arg(args, 0).as_u64().ok_or("Pestaña inválida")?;
            crate::browser::owned(state, owner, id)?;
            let image = crate::browser::screenshot(app, state, id).await?;
            let path = save_image(state, &image, "image/png")?;
            Ok(
                json!({"path":path,"url":format!("data:image/png;base64,{}",STANDARD.encode(image))}),
            )
        }
        "self:restart" => {
            let status = engine::get(app, state)
                .await?
                .call("self:status", vec![])
                .await?;
            if status["state"] != "ready" {
                return Err("No hay una versión nueva lista".into());
            }
            state
                .reopen_update
                .store(true, std::sync::atomic::Ordering::SeqCst);
            app.exit(0);
            Ok(Value::Null)
        }
        _ if channel.starts_with("browser:") => {
            crate::browser::dispatch(app, state, owner, channel, args).await
        }
        _ => {
            let value = engine::get(app, state)
                .await?
                .call(channel, args.to_vec())
                .await?;
            if channel == "projects:close" || channel == "projects:forget" {
                if let Some(id) = arg(args, 0).as_str() {
                    state.watchers.lock().unwrap().remove(id);
                }
            }
            Ok(value)
        }
    }
}
fn window(app: &tauri::AppHandle, label: &str, url: &str, width: f64) -> Result<()> {
    if let Some(w) = app.get_window(label) {
        w.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let w = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App(url.into()))
        .title("Ambidex")
        .inner_size(width, 680.0)
        .min_inner_size(360.0, 260.0)
        .data_store_identifier(paths::web_store(app.state::<Arc<Backend>>().inner(), false))
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .on_navigation(crate::app_url)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()
        .map_err(|e| e.to_string())?;
    let app_closed = app.clone();
    let label = label.to_string();
    w.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) && label.starts_with("panel-") {
            let rest = label.trim_start_matches("panel-");
            if let Some((project, panel)) = rest.rsplit_once('-') {
                crate::push(
                    &app_closed,
                    "panel:closed",
                    json!({"projectId":project,"panel":panel}),
                );
            }
        }
    });
    Ok(())
}
const MAX_IMAGE: u64 = 8 * 1024 * 1024;
fn mime(path: &std::path::Path) -> Result<&'static str> {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Ok("image/png"),
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "gif" => Ok("image/gif"),
        "webp" => Ok("image/webp"),
        _ => Err("Tipo de imagen no admitido".into()),
    }
}
pub(crate) fn save_image(state: &Backend, bytes: &[u8], mime: &str) -> Result<PathBuf> {
    let ext = match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => return Err("Tipo de imagen no admitido".into()),
    };
    if bytes.len() as u64 > MAX_IMAGE {
        return Err("La imagen supera 8 MB".into());
    }
    let dir = state.data_dir.join("attachments");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.{}", uuid::Uuid::new_v4(), ext));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path)
}
fn files(state: &Backend, channel: &str, args: &[Value]) -> Result<Value> {
    if channel == "attachments:save" {
        let array = arg(args, 0).as_array().ok_or("Imagen inválida")?;
        if array.len() as u64 > MAX_IMAGE {
            return Err("La imagen supera 8 MB".into());
        }
        let bytes: Vec<u8> = array
            .iter()
            .map(|v| {
                v.as_u64()
                    .filter(|n| *n < 256)
                    .map(|n| n as u8)
                    .ok_or("Byte inválido".to_string())
            })
            .collect::<Result<_>>()?;
        return Ok(json!(save_image(state, &bytes, str_arg(args, 1)?)?));
    }
    let raw = str_arg(args, 0)?;
    let path = if channel == "attachments:read" {
        paths::check_in(raw, &[state.data_dir.join("attachments")])?
    } else if channel == "extensions:read" {
        paths::extension(state, raw)?
    } else if channel == "fs:image" {
        let mut roots = state.roots.lock().unwrap().clone();
        roots.extend([
            state.data_dir.join("attachments"),
            paths::codex_home().join("generated_images"),
            std::env::temp_dir(),
            PathBuf::from("/tmp"),
        ]);
        paths::check_in(raw, &roots)?
    } else {
        paths::check(state, raw)?
    };
    match channel {
        "fs:list" => {
            let mut list = Vec::new();
            for entry in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
                let e = entry.map_err(|e| e.to_string())?;
                let name = e.file_name().to_string_lossy().to_string();
                if [".git", ".DS_Store"].contains(&name.as_str()) {
                    continue;
                }
                list.push(json!({"name":name,"path":e.path(),"isDir":e.file_type().map(|t|t.is_dir()).unwrap_or(false)}));
            }
            list.sort_by(|a, b| {
                b["isDir"]
                    .as_bool()
                    .cmp(&a["isDir"].as_bool())
                    .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
            });
            Ok(json!(list))
        }
        "fs:read" | "extensions:read" => {
            if channel == "extensions:read" && path.extension().is_none_or(|x| x != "md") {
                return Err("Solo se pueden leer extensiones .md".into());
            }
            let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
            if size > 8 * 1024 * 1024 {
                return if channel == "fs:read" {
                    Ok(json!({"content":"","binary":false,"tooLarge":true}))
                } else {
                    Err("El documento es demasiado grande".into())
                };
            }
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            if channel == "extensions:read" {
                return Ok(json!(String::from_utf8_lossy(&bytes)
                    .chars()
                    .take(200000)
                    .collect::<String>()));
            }
            let binary = bytes.iter().take(8000).any(|b| *b == 0);
            Ok(
                json!({"content":if binary{String::new()}else{String::from_utf8_lossy(&bytes).into_owned()},"binary":binary,"tooLarge":false}),
            )
        }
        "fs:write" => {
            std::fs::write(path, str_arg(args, 1)?).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "fs:image" | "attachments:read" => {
            let kind = mime(&path)?;
            if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > MAX_IMAGE {
                return Err("La imagen supera 8 MB".into());
            }
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            Ok(json!(format!(
                "data:{kind};base64,{}",
                STANDARD.encode(bytes)
            )))
        }
        _ => Err("Operación de archivo desconocida".into()),
    }
}
fn watch(app: &tauri::AppHandle, state: &Backend, id: &str, dir: PathBuf) -> Result<()> {
    use notify::Watcher;
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = notify::recommended_watcher(
        move |event: std::result::Result<notify::Event, notify::Error>| {
            if let Ok(e) = event {
                let _ = tx.send(e.paths);
            }
        },
    )
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&dir, notify::RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    state
        .watchers
        .lock()
        .unwrap()
        .insert(id.to_string(), watcher);
    let app = app.clone();
    let id = id.to_string();
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut paths: std::collections::HashSet<_> = first.into_iter().collect();
            while let Ok(more) = rx.recv_timeout(std::time::Duration::from_millis(250)) {
                paths.extend(more);
                if paths.len() > 5000 {
                    break;
                }
            }
            let paths: Vec<_> = paths
                .into_iter()
                .filter(|p| {
                    !p.components().any(|c| {
                        [
                            "node_modules",
                            ".next",
                            "dist",
                            "out",
                            "build",
                            "target",
                            ".venv",
                            "venv",
                            "__pycache__",
                            "objects",
                            "logs",
                        ]
                        .contains(&c.as_os_str().to_str().unwrap_or_default())
                    })
                })
                .collect();
            if !paths.is_empty() {
                crate::push(&app, "fs:changed", json!({"projectId":id,"paths":paths}));
            }
        }
    });
    Ok(())
}

// macOS's context menu popup blocks until dismissal. One application listener records the selected item.
static CONTEXT: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Value>>> =
    std::sync::OnceLock::new();
async fn context_menu(app: &tauri::AppHandle, owner: &str, items: &Value) -> Result<Value> {
    fn append(
        app: &tauri::AppHandle,
        menu: &Menu<tauri::Wry>,
        items: &[Value],
        prefix: &str,
    ) -> Result<()> {
        for (i, item) in items.iter().enumerate() {
            if item["type"] == "separator" {
                menu.append(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
                continue;
            }
            let label = item["label"].as_str().unwrap_or_default();
            let enabled = item["enabled"] != false;
            if let Some(children) = item["submenu"].as_array() {
                let nested = Menu::new(app).map_err(|e| e.to_string())?;
                append(app, &nested, children, &format!("{prefix}-{i}"))?;
                let sub = Submenu::new(app, label, enabled).map_err(|e| e.to_string())?;
                for entry in nested.items().map_err(|e| e.to_string())? {
                    sub.append(&entry).map_err(|e| e.to_string())?;
                }
                menu.append(&sub).map_err(|e| e.to_string())?;
            } else {
                let id = format!("{prefix}|{}", item["id"].as_str().unwrap_or_default());
                if item["type"] == "checkbox" {
                    menu.append(
                        &CheckMenuItem::with_id(
                            app,
                            id,
                            label,
                            enabled,
                            item["checked"] == true,
                            None::<&str>,
                        )
                        .map_err(|e| e.to_string())?,
                    )
                    .map_err(|e| e.to_string())?;
                } else {
                    menu.append(
                        &MenuItem::with_id(app, id, label, enabled, None::<&str>)
                            .map_err(|e| e.to_string())?,
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    }
    let request = format!("ctx-{}", uuid::Uuid::new_v4());
    let menu = Menu::new(app).map_err(|e| e.to_string())?;
    append(
        app,
        &menu,
        items.as_array().ok_or("Menú inválido")?,
        &request,
    )?;
    let w = app.get_webview(owner).ok_or("Ventana cerrada")?.window();
    menu.popup(w).map_err(|e| e.to_string())?;
    // Queue the result after the menu selection event, rather than guessing a delay after dismissal.
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let selected = CONTEXT
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .remove(&request)
            .unwrap_or(Value::Null);
        let _ = tx.send(selected);
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())
}
pub fn menu(app: &tauri::App) -> tauri::Result<()> {
    let handle = app.handle();
    let menu = Menu::new(handle)?;
    let app_menu = Submenu::with_items(
        handle,
        "Ambidex",
        true,
        &[
            &PredefinedMenuItem::about(handle, Some("Acerca de Ambidex"), None)?,
            &MenuItem::with_id(handle, "settings", "Ajustes…", true, Some("CmdOrCtrl+,"))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::services(handle, Some("Servicios"))?,
            &PredefinedMenuItem::hide(handle, Some("Ocultar Ambidex"))?,
            &PredefinedMenuItem::hide_others(handle, Some("Ocultar otros"))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::quit(handle, Some("Salir de Ambidex"))?,
        ],
    )?;
    menu.append(&app_menu)?;
    let file = Submenu::new(handle, "Archivo", true)?;
    for (id, label, key) in [
        ("open-project", "Abrir proyecto…", Some("CmdOrCtrl+O")),
        ("projects", "Proyectos…", Some("CmdOrCtrl+Shift+O")),
        ("new-chat", "Nueva conversación", Some("CmdOrCtrl+N")),
        ("new-terminal", "Nueva terminal", Some("CmdOrCtrl+Shift+T")),
        (
            "close-project",
            "Cerrar pestaña de proyecto",
            Some("CmdOrCtrl+Shift+W"),
        ),
    ] {
        file.append(&MenuItem::with_id(handle, id, label, true, key)?)?;
    }
    menu.append(&file)?;
    let edit = Submenu::with_items(
        handle,
        "Edición",
        true,
        &[
            &PredefinedMenuItem::undo(handle, Some("Deshacer"))?,
            &PredefinedMenuItem::redo(handle, Some("Rehacer"))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, Some("Cortar"))?,
            &PredefinedMenuItem::copy(handle, Some("Copiar"))?,
            &PredefinedMenuItem::paste(handle, Some("Pegar"))?,
            &PredefinedMenuItem::select_all(handle, Some("Seleccionar todo"))?,
        ],
    )?;
    menu.append(&edit)?;
    let view = Submenu::new(handle, "Ver", true)?;
    for (id, label) in [
        ("palette", "Paleta de comandos   ⌘K"),
        ("quick-open", "Ir a fichero   ⌘P"),
        ("toggle-sidebar", "Barra lateral"),
        ("toggle-right", "Agentes"),
        ("toggle-activity", "Actividad"),
        ("toggle-bottom", "Terminal"),
        ("reset-layout", "Restablecer diseño"),
        ("toggle-layout", "Alternar chat / código"),
    ] {
        view.append(&MenuItem::with_id(handle, id, label, true, None::<&str>)?)?;
    }
    view.append(&PredefinedMenuItem::fullscreen(
        handle,
        Some("Pantalla completa"),
    )?)?;
    menu.append(&view)?;
    let windows = Submenu::with_items(
        handle,
        "Ventana",
        true,
        &[
            &MenuItem::with_id(
                handle,
                "next-project",
                "Proyecto siguiente",
                true,
                Some("CmdOrCtrl+Shift+]"),
            )?,
            &MenuItem::with_id(
                handle,
                "prev-project",
                "Proyecto anterior",
                true,
                Some("CmdOrCtrl+Shift+["),
            )?,
            &PredefinedMenuItem::minimize(handle, Some("Minimizar"))?,
            &PredefinedMenuItem::maximize(handle, Some("Zoom"))?,
        ],
    )?;
    menu.append(&windows)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if let Some((key, value)) = id
            .split_once('|')
            .filter(|(key, _)| key.starts_with("ctx-"))
        {
            let request = key.get(..40).unwrap_or(key); // ctx- + UUID, followed by optional submenu indices
            CONTEXT
                .get_or_init(Default::default)
                .lock()
                .unwrap()
                .insert(request.to_string(), json!(value));
        } else {
            crate::push(app, "menu", json!({"command":id}));
        }
    });
    Ok(())
}

pub fn dropped_files(state: &Backend, paths: &[PathBuf], x: f64, y: f64) -> Value {
    let mut images = Vec::new();
    let mut files = Vec::new();
    for path in paths.iter().take(30) {
        if let Ok(kind) = mime(path) {
            if let Ok(meta) = std::fs::metadata(path) {
                if meta.len() <= MAX_IMAGE {
                    if let Ok(bytes) = std::fs::read(path) {
                        if let Ok(saved) = save_image(state, &bytes, kind) {
                            images.push(json!({"path":saved,"url":format!("data:{kind};base64,{}",STANDARD.encode(bytes))}));
                            continue;
                        }
                    }
                }
            }
        }
        files.push(json!({"path":path,"isDir":path.is_dir()}));
    }
    json!({"files":files,"images":images,"x":x,"y":y})
}

pub fn main_window(app: &tauri::App) -> tauri::Result<()> {
    let mut builder = tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
        .data_store_identifier(paths::web_store(app.state::<Arc<Backend>>().inner(), false))
        .on_navigation(crate::app_url)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
    if cfg!(debug_assertions) && std::env::var_os("AMBIDEX_E2E_REPORT").is_some() {
        builder = builder
            .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled);
    }
    let window = builder.build()?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}
pub fn install_update(state: &Backend, source: &str, reopen: bool) {
    use std::os::unix::process::CommandExt;
    let Ok(node) = engine::node() else {
        return;
    };
    let Ok(log) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(state.data_dir.join("logs/update.log"))
    else {
        return;
    };
    let Ok(err) = log.try_clone() else {
        return;
    };
    let _ = std::process::Command::new(node)
        .arg("scripts/install-app.mjs")
        .current_dir(source)
        .env("AMBIDEX_NO_OPEN", if reopen { "" } else { "1" })
        .stdin(std::process::Stdio::null())
        .stdout(log)
        .stderr(err)
        .process_group(0)
        .spawn();
}

pub async fn finished(app: &tauri::AppHandle, state: &Arc<Backend>, run: Value) {
    use tauri_plugin_notification::NotificationExt;
    let Some(worker) = state.engine.current() else {
        return;
    };
    let Ok(settings) = worker.call("settings:get", vec![]).await else {
        return;
    };
    if settings["notifications"] == false {
        return;
    }
    if app
        .get_window("main")
        .is_some_and(|w| w.is_focused().unwrap_or(false))
        && settings["activeProjectId"] == run["projectId"]
    {
        return;
    }
    let agent = if run["agent"] == "claude" {
        "Claude Code"
    } else {
        "Codex"
    };
    let verb = match run["status"].as_str() {
        Some("completed") => "ha terminado",
        Some("cancelled") => "se ha detenido",
        _ => "ha fallado",
    };
    let _ = app
        .notification()
        .builder()
        .title(format!("{agent} {verb}"))
        .body(run["sessionTitle"].as_str().unwrap_or("Ambidex"))
        .show();
}
