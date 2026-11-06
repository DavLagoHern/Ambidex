//! JSON lines IPC to the existing, tested agent engine. The packaged app contains no Electron runtime.
use crate::{Backend, Result};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, Weak,
    },
    time::{Duration, Instant},
};
use tauri::Manager;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex as AsyncMutex, Notify, RwLock},
};

fn trace(_message: &str) {
    #[cfg(debug_assertions)]
    if let Ok(path) = std::env::var("AMBIDEX_E2E_REPORT") {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path + ".boot")
        {
            let _ = writeln!(f, "{}", _message);
        }
    }
}

#[derive(Default)]
pub struct Slot {
    worker: Mutex<Option<Arc<Worker>>>,
    gate: RwLock<()>,
    startup: AsyncMutex<()>,
}
impl Slot {
    pub fn current(&self) -> Option<Arc<Worker>> {
        self.worker.lock().unwrap().clone()
    }
}
type Reply = oneshot::Sender<Result<Value>>;
pub struct Worker {
    input: AsyncMutex<ChildStdin>,
    child: AsyncMutex<Child>,
    pending: Mutex<HashMap<String, Reply>>,
    ready: Notify,
    status: Mutex<Option<Result<()>>>,
    backend: Weak<Backend>,
    app: tauri::AppHandle,
    last_use: Mutex<Instant>,
    expected_exit: AtomicBool,
}
pub fn node() -> Result<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(p) = std::env::var_os("AMBIDEX_NODE_BIN") {
        candidates.push(PathBuf::from(p));
    }
    let home = crate::paths::home();
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        candidates.push(dir.join("node"));
    }
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        home.join(".local/share/mise/shims/node"),
        home.join(".volta/bin/node"),
    ]);
    if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
        let mut versions: Vec<_> = entries
            .flatten()
            .map(|e| e.path().join("bin/node"))
            .collect();
        versions.sort();
        versions.reverse();
        candidates.extend(versions);
    }
    for candidate in candidates {
        if !candidate.is_file() {
            continue;
        }
        if let Ok(out) = std::process::Command::new(&candidate)
            .arg("--version")
            .output()
        {
            let version = String::from_utf8_lossy(&out.stdout);
            let major = version
                .trim_start_matches('v')
                .split('.')
                .next()
                .and_then(|n| n.parse::<u32>().ok())
                .unwrap_or(0);
            if out.status.success() && major >= 24 {
                return Ok(candidate);
            }
        }
    }
    Err("Se necesita Node.js 24 o posterior para el motor de agentes. Instálalo con Homebrew o indica AMBIDEX_NODE_BIN.".into())
}
pub fn get<'a>(
    app: &'a tauri::AppHandle,
    state: &'a Arc<Backend>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Arc<Worker>>> + Send + 'a>> {
    Box::pin(async move {
        let _lease = state.engine.gate.read().await;
        let _startup = state.engine.startup.lock().await;
        if let Some(worker) = state.engine.current() {
            worker.wait_ready().await?;
            return Ok(worker);
        }
        let worker = async {
        trace("starting engine");
        let script = if cfg!(debug_assertions) {
            std::env::var_os("AMBIDEX_ENGINE_PATH").filter(|_|std::env::var_os("AMBIDEX_TEST").is_some()).map(PathBuf::from)
                .unwrap_or_else(||PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../out/engine/index.mjs"))
        } else { app.path().resource_dir().map_err(|e| e.to_string())?.join("engine/index.mjs") };
        if !script.exists() { return Err::<Arc<Worker>, String>("Falta el motor de agentes. Ejecuta npm run build:assets.".into()); }
        if std::env::var_os("AMBIDEX_USER_DATA").is_none() {
            if let Ok(out)=std::process::Command::new("ps").args(["-axo","comm="]).output() {
                let old=String::from_utf8_lossy(&out.stdout);
                if old.lines().any(|line|line.ends_with("/Contents/MacOS/Ambidex")||line.ends_with("/Contents/MacOS/Code AI")) {
                    return Err("Cierra la versión Electron de Ambidex y vuelve a abrir esta versión. Las dos no deben usar el mismo historial simultáneamente.".to_string());
                }
            }
        }
        let node_path=node()?;
        let mut cmd = Command::new(&node_path);
        if !cfg!(debug_assertions) && std::env::var_os("AMBIDEX_TEST").is_none() {
            cmd.env("AMBIDEX_SOURCE",PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap());
        }
        cmd.arg("--disable-warning=ExperimentalWarning").arg(script)
            .env("AMBIDEX_USER_DATA", &state.data_dir)
            .env("NODE_ENV", if cfg!(debug_assertions) { "development" } else { "production" })
            .env_remove("ELECTRON_RUN_AS_NODE")
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
        let mut path = vec![node_path.parent().unwrap().to_path_buf(), PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")];
        path.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()));
        cmd.env("PATH", std::env::join_paths(path).map_err(|e| e.to_string())?);
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        trace(&format!("spawned engine {:?}",child.id()));
        let input = child.stdin.take().ok_or("No se pudo conectar con el motor")?;
        let output = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let worker = Arc::new(Worker { input: AsyncMutex::new(input), child: AsyncMutex::new(child), pending: Mutex::new(HashMap::new()), ready: Notify::new(), status: Mutex::new(None), backend: Arc::downgrade(state), app: app.clone(), last_use: Mutex::new(Instant::now()), expected_exit: false.into() });
        let reader = worker.clone(); let handle = app.clone(); let weak_state = Arc::downgrade(state);
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(output).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(message) = serde_json::from_str::<Value>(&line) else { continue; };
                if message["ready"] == true { trace("engine emitted ready"); *reader.status.lock().unwrap() = Some(Ok(())); reader.ready.notify_waiters(); continue; }
                if let Some(channel) = message["event"].as_str() {
                    if let Some(state) = weak_state.upgrade() {
                        match channel {
                            "native:roots" => {
                                *state.roots.lock().unwrap() = message["payload"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(PathBuf::from).collect()).unwrap_or_default();
                            },
                            "native:busy" => { state.busy.store(message["payload"].as_u64().unwrap_or(0) as usize, std::sync::atomic::Ordering::SeqCst); },
                            "run:status" => {
                                let n={let mut runs=state.active_runs.lock().unwrap();if let Some(id)=message["payload"]["id"].as_str(){if message["payload"]["status"]=="running" {runs.insert(id.to_string());}else{runs.remove(id);}}runs.len()};
                                state.busy.store(n,Ordering::SeqCst);
                                if let Some(w)=handle.get_window("main"){let _=w.set_badge_count(if n==0{None}else{Some(n as i64)});}
                                crate::push(&handle,channel,message["payload"].clone());
                            },
                            "native:finished" => {
                                let app=handle.clone();let data=message["payload"].clone();let state=state.clone();
                                tauri::async_runtime::spawn(async move{crate::native::finished(&app,&state,data).await;});
                            },
                            _ => crate::push(&handle, channel, message["payload"].clone()),
                        }
                    }
                } else if let Some(channel) = message["host"].as_str() {
                    if let Some(state) = weak_state.upgrade() {
                        let worker = reader.clone(); let app = handle.clone(); let channel = channel.to_string();
                        tauri::async_runtime::spawn(async move {
                            let args = message["args"].as_array().cloned().unwrap_or_default();
                            let answer = crate::native::host(&app, &state, &channel, &args).await;
                            let response = match answer { Ok(result) => json!({"id":message["id"], "hostResult":true, "result":result}), Err(error) => json!({"id":message["id"], "hostResult":true, "error":error}) };
                            let _ = worker.write(&response).await;
                        });
                    }
                } else if let Some(id) = message["id"].as_str() {
                    if let Some(tx) = reader.pending.lock().unwrap().remove(id) {
                        let _ = tx.send(if let Some(e) = message["error"].as_str() { Err(e.to_string()) } else { Ok(message["result"].clone()) });
                    }
                }
            }
            let error = "El motor de agentes se ha detenido. Reinicia Ambidex; el historial permanece guardado.".to_string();
            *reader.status.lock().unwrap() = Some(Err(error.clone())); reader.ready.notify_waiters();
            for (_, tx) in reader.pending.lock().unwrap().drain() { let _ = tx.send(Err(error.clone())); }
            if let Some(state) = weak_state.upgrade() { state.busy.store(0, std::sync::atomic::Ordering::SeqCst); }
            if !reader.expected_exit.load(Ordering::SeqCst) { crate::push(&handle, "native:error", json!(error)); }
        });
        let log = state.data_dir.join("logs/engine.log");
        tauri::async_runtime::spawn(async move {
            use std::io::Write;
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if std::fs::metadata(&log).is_ok_and(|m| m.len() > 5 * 1024 * 1024) { let _ = std::fs::rename(&log, log.with_extension("log.1")); }
                if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&log) { let _ = writeln!(file, "{line}"); }
            }
        });
        Ok(worker)
    }.await?;
        trace("waiting for engine readiness");
        if let Err(error) = worker.wait_ready().await {
            worker.stop().await;
            return Err(error);
        }
        trace("engine ready, installing slot");
        *state.engine.worker.lock().unwrap() = Some(worker.clone());
        // A sleeping engine has no browser state in memory. Restore the native active views before agent tools run.
        let pages: Vec<Value> = state
            .browsers
            .lock()
            .unwrap()
            .iter()
            .map(|(id, p)| {
                let mut value = p.state.clone();
                value["id"] = json!(id);
                value
            })
            .collect();
        for page in pages {
            let _ = worker.call_raw("engine:browser", vec![page]).await;
        }
        Ok(worker)
    })
}
impl Worker {
    async fn write(&self, value: &Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        self.input
            .lock()
            .await
            .write_all(&bytes)
            .await
            .map_err(|e| e.to_string())
    }
    async fn wait_ready(&self) -> Result<()> {
        loop {
            let ready = self.ready.notified();
            tokio::pin!(ready);
            ready.as_mut().enable();
            if let Some(result) = self.status.lock().unwrap().clone() {
                return result;
            }
            tokio::time::timeout(Duration::from_secs(30), ready)
                .await
                .map_err(|_| "El motor de agentes no ha arrancado".to_string())?;
        }
    }
    pub async fn call(&self, channel: &str, args: Vec<Value>) -> Result<Value> {
        let state = self
            .backend
            .upgrade()
            .ok_or("La aplicación se está cerrando")?;
        let lease = state.engine.gate.read().await;
        let current = state.engine.current();
        if !current
            .as_ref()
            .is_some_and(|worker| std::ptr::eq(worker.as_ref(), self))
        {
            // No request has been sent: safely acquire the replacement after an idle shutdown.
            drop(lease);
            let worker = get(&self.app, &state).await?;
            return Box::pin(worker.call(channel, args)).await;
        }
        *self.last_use.lock().unwrap() = Instant::now();
        let result = self.call_raw(channel, args).await;
        *self.last_use.lock().unwrap() = Instant::now();
        result
    }
    async fn call_raw(&self, channel: &str, args: Vec<Value>) -> Result<Value> {
        self.wait_ready().await?;
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        if let Err(e) = self
            .write(&json!({"id": id,"channel": channel,"args": args}))
            .await
        {
            self.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        let seconds = if channel == "jev:install"
            || channel.starts_with("cli:")
            || channel.starts_with("self:")
        {
            1800
        } else {
            180
        };
        let result = tokio::time::timeout(Duration::from_secs(seconds), rx).await;
        self.pending.lock().unwrap().remove(&id);
        result
            .map_err(|_| format!("Tiempo de espera agotado: {channel}"))?
            .map_err(|_| "Se cerró el motor de agentes".to_string())?
    }
    pub async fn stop(&self) {
        self.expected_exit.store(true, Ordering::SeqCst);
        let mut child = self.child.lock().await;
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
}

/// The write lease excludes all in-flight calls, including long installs and one-shot jobs.
/// Streaming turns and orchestration phases are checked by the engine before it can be parked.
pub async fn park(state: &Arc<Backend>, force: bool) -> Result<bool> {
    let _exclusive = state.engine.gate.write().await;
    if state.exiting.load(Ordering::SeqCst) {
        return Ok(false);
    }
    let Some(worker) = state.engine.current() else {
        return Ok(true);
    };
    if !force && worker.last_use.lock().unwrap().elapsed() < Duration::from_secs(30) {
        return Ok(false);
    }
    if worker.call_raw("engine:canSleep", vec![]).await? != true {
        return Ok(false);
    }
    worker.expected_exit.store(true, Ordering::SeqCst);
    worker.call_raw("engine:park", vec![]).await?;
    *state.engine.worker.lock().unwrap() = None;
    worker.stop().await;
    Ok(true)
}
pub fn monitor(app: tauri::AppHandle, state: Weak<Backend>) {
    tauri::async_runtime::spawn(async move {
        let mut background = Instant::now();
        let mut interval = Duration::from_secs(60);
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let Some(state) = state.upgrade() else {
                break;
            };
            if state.exiting.load(Ordering::SeqCst) {
                break;
            }
            if state.engine.current().is_some() {
                let _ = park(&state, false).await;
            }
            // Preserve account refresh and update checks while the compatibility process sleeps.
            if background.elapsed() >= interval && std::env::var_os("AMBIDEX_TEST").is_none() {
                background = Instant::now();
                interval = Duration::from_secs(30 * 60);
                if let Ok(worker) = get(&app, &state).await {
                    let _ = worker.call("agents:limits", vec![json!(true)]).await;
                    if std::env::var_os("AMBIDEX_TEST").is_none() {
                        let _ = worker.call("engine:background", vec![]).await;
                    }
                }
            }
        }
    });
}
