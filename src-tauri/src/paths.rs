use crate::{Backend, Result};
use std::path::{Component, Path, PathBuf};

pub fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
}
pub fn data_dir() -> std::io::Result<PathBuf> {
    if let Some(p) = std::env::var_os("AMBIDEX_USER_DATA") {
        return Ok(PathBuf::from(p));
    }
    let base = home().join("Library/Application Support");
    let current = base.join("Ambidex");
    let legacy = base.join("Code AI");
    Ok(if !current.exists() && legacy.exists() {
        legacy
    } else {
        current
    })
}
pub fn realish(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err("La ruta debe ser absoluta".into());
    }
    let mut normalized = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            _ => normalized.push(c),
        }
    }
    let mut existing = normalized.as_path();
    let mut suffix = Vec::new();
    while std::fs::symlink_metadata(existing).is_err() {
        if let Some(name) = existing.file_name() {
            suffix.push(name.to_os_string());
        }
        existing = existing.parent().ok_or("La ruta no existe")?;
    }
    let mut result = existing.canonicalize().map_err(|e| e.to_string())?;
    for name in suffix.iter().rev() {
        result.push(name);
    }
    Ok(result)
}
pub fn check_in(path: &str, roots: &[PathBuf]) -> Result<PathBuf> {
    let target = realish(Path::new(path))?;
    if roots
        .iter()
        .any(|root| realish(root).is_ok_and(|r| target.starts_with(r)))
    {
        Ok(target)
    } else {
        Err("La ruta está fuera de las carpetas permitidas".into())
    }
}
pub fn check(state: &Backend, path: &str) -> Result<PathBuf> {
    check_in(path, &state.roots.lock().unwrap())
}
pub fn extension(state: &Backend, path: &str) -> Result<PathBuf> {
    let mut roots = state.roots.lock().unwrap().clone();
    roots.extend([
        home().join(".claude"),
        home().join(".claude.json"),
        codex_home(),
    ]);
    check_in(path, &roots)
}
pub fn codex_home() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".codex"))
}
pub fn db_path(state: &Backend) -> PathBuf {
    let legacy = state.data_dir.join("code-ai.db");
    if legacy.exists() {
        legacy
    } else {
        state.data_dir.join("ambidex.db")
    }
}

// A distinct WebKit store per data directory prevents test and production localStorage/cookies from mixing.
pub fn web_store(state: &Backend, guest: bool) -> [u8; 16] {
    let name = format!(
        "{}:{}",
        state.data_dir.to_string_lossy(),
        if guest { "browser" } else { "workspace" }
    );
    *uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL, name.as_bytes()).as_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_relative_and_sibling_paths() {
        let root = std::env::temp_dir().join(format!("ambidex-guard-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        assert!(check_in("relative", std::slice::from_ref(&root)).is_err());
        assert!(check_in(
            root.join("new/sub.txt").to_str().unwrap(),
            std::slice::from_ref(&root)
        )
        .is_ok());
        assert!(check_in(
            root.with_extension("other").to_str().unwrap(),
            std::slice::from_ref(&root)
        )
        .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape_and_parent_traversal() {
        let root = std::env::temp_dir().join(format!("ambidex-link-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink("/etc", root.join("outside")).unwrap();
        assert!(check_in(
            root.join("outside/passwd").to_str().unwrap(),
            std::slice::from_ref(&root)
        )
        .is_err());
        assert!(check_in(
            root.join("../escape").to_str().unwrap(),
            std::slice::from_ref(&root)
        )
        .is_err());
        std::os::unix::fs::symlink("/nonexistent-ambidex-target", root.join("dangling")).unwrap();
        assert!(check_in(
            root.join("dangling/new.txt").to_str().unwrap(),
            std::slice::from_ref(&root)
        )
        .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
