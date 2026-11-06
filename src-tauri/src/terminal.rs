//! Native PTYs. No node-pty addon, Electron ABI rebuild, or fallback pipe terminal.
use crate::{Backend, Result};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
};

struct Term {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    buffer: String,
    generation: String,
    pid: Option<u32>,
}
#[derive(Default)]
pub struct Terminals(Mutex<HashMap<String, Term>>);
fn trim_buffer(buffer: &mut String) {
    if buffer.len() > 200_000 {
        let mut start = buffer.len() - 200_000;
        while !buffer.is_char_boundary(start) {
            start += 1;
        }
        buffer.drain(..start);
    }
}
impl Terminals {
    pub fn write(&self, id: &str, text: &str) -> Result<()> {
        if let Some(t) = self.0.lock().unwrap().get_mut(id) {
            t.writer
                .write_all(text.as_bytes())
                .map_err(|e| e.to_string())?;
            t.writer.flush().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        if let Some(t) = self.0.lock().unwrap().get(id) {
            t.master
                .resize(PtySize {
                    rows: rows.max(2),
                    cols: cols.max(2),
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    pub fn kill(&self, id: &str) {
        if let Some(mut t) = self.0.lock().unwrap().remove(id) {
            if let Some(pid) = t.pid {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGHUP);
                }
            }
            let _ = t.killer.kill();
        }
    }
    pub fn kill_all(&self) {
        let ids: Vec<_> = self.0.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.kill(&id);
        }
    }
}
pub async fn create(
    app: &tauri::AppHandle,
    state: &Arc<Backend>,
    id: &str,
    opts: &Value,
) -> Result<Value> {
    if id.is_empty() || id.len() > 200 {
        return Err("Identificador de terminal inválido".into());
    }
    if opts["login"].is_null() {
        if let Some(t) = state.terminals.0.lock().unwrap().get(id) {
            return Ok(json!({"buffer":t.buffer}));
        }
    }
    state.terminals.kill(id);
    let login = opts["login"].as_str();
    let cwd = if login.is_some() {
        crate::paths::home()
    } else {
        crate::paths::check(
            state,
            opts["cwd"].as_str().ok_or("Falta carpeta de terminal")?,
        )?
    };
    let mut cmd = if let Some(agent) = login {
        let command = crate::engine::get(app, state)
            .await?
            .call("engine:login", vec![json!(agent)])
            .await?;
        let mut c = CommandBuilder::new(command["file"].as_str().ok_or("CLI no encontrado")?);
        for arg in command["args"].as_array().unwrap() {
            c.arg(arg.as_str().unwrap_or_default());
        }
        c
    } else {
        let mut c =
            CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()));
        c.arg("-l");
        c
    };
    cmd.cwd(cwd);
    for (key, _) in std::env::vars() {
        if key == "CLAUDECODE"
            || key == "CLAUDE_PID"
            || key.starts_with("CLAUDE_CODE_SESSION")
            || key.starts_with("CLAUDE_CODE_MESSAGING_")
            || key == "CODEX_THREAD_ID"
            || key.starts_with("CODEX_SANDBOX")
            || key == "ELECTRON_RUN_AS_NODE"
            || (login.is_some()
                && [
                    "ANTHROPIC_API_KEY",
                    "ANTHROPIC_AUTH_TOKEN",
                    "OPENAI_API_KEY",
                    "CODEX_API_KEY",
                ]
                .contains(&key.as_str()))
        {
            cmd.env_remove(key);
        }
    }
    let path = format!(
        "/opt/homebrew/bin:/usr/local/bin:{}",
        std::env::var("PATH").unwrap_or_default()
    );
    cmd.env("PATH", path);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Ambidex");
    let dev = if let Some(name) = opts["dev"].as_str() {
        if login.is_some() {
            return Err("El login no admite scripts de desarrollo".into());
        }
        let scripts = crate::engine::get(app, state)
            .await?
            .call("project:devScripts", vec![opts["cwd"].clone()])
            .await?;
        Some(
            scripts
                .as_array()
                .and_then(|s| s.iter().find(|s| s["name"] == name))
                .and_then(|s| s["command"].as_str())
                .ok_or("Script no encontrado")?
                .to_string(),
        )
    } else {
        None
    };
    let pty = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    let mut child = pty.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pty.slave);
    let mut reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pty.master.take_writer().map_err(|e| e.to_string())?;
    let generation = uuid::Uuid::new_v4().to_string();
    state.terminals.0.lock().unwrap().insert(
        id.to_string(),
        Term {
            master: pty.master,
            writer,
            killer: child.clone_killer(),
            buffer: String::new(),
            generation: generation.clone(),
            pid: child.process_id(),
        },
    );
    let id = id.to_string();
    let state_read = state.clone();
    let app_read = app.clone();
    let read_id = id.clone();
    let read_gen = generation.clone();
    std::thread::spawn(move || {
        let mut bytes = [0u8; 16384];
        let mut pending = Vec::new();
        let mut dev = dev;
        loop {
            let n = match reader.read(&mut bytes) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            pending.extend_from_slice(&bytes[..n]);
            // Keep incomplete UTF-8 sequences for the next read.
            let valid = match std::str::from_utf8(&pending) {
                Ok(_) => pending.len(),
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                Err(_) => pending.len(),
            };
            if valid == 0 {
                continue;
            }
            let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            {
                let mut terms = state_read.terminals.0.lock().unwrap();
                let Some(t) = terms.get_mut(&read_id).filter(|t| t.generation == read_gen) else {
                    break;
                };
                t.buffer.push_str(&text);
                trim_buffer(&mut t.buffer);
            }
            crate::push(&app_read, "term:data", json!({"id":read_id,"data":text}));
            if let Some(command) = dev.take() {
                let _ = state_read.terminals.write(&read_id, &(command + "\r"));
            }
        }
    });
    let state_exit = state.clone();
    let app_exit = app.clone();
    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
        let mut terms = state_exit.terminals.0.lock().unwrap();
        if terms.get(&id).is_some_and(|t| t.generation == generation) {
            terms.remove(&id);
            drop(terms);
            crate::push(&app_exit, "term:exit", json!({"id":id,"code":code}));
        }
    });
    Ok(json!({}))
}
#[cfg(test)]
mod tests {
    #[test]
    fn buffer_keeps_valid_unicode() {
        let mut s = "🦀".repeat(60000);
        super::trim_buffer(&mut s);
        assert!(s.len() <= 200000);
        assert!(s.ends_with('🦀'));
    }
}
