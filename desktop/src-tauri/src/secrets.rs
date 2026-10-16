//! API keys live in the OS keychain (macOS Keychain / Linux Secret Service). When no keychain is
//! available (e.g. a headless Linux session without a Secret Service daemon) we fall back to a
//! 0600 JSON file in the app data dir and log a warning.

use anyhow::Result;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

const SERVICE: &str = "app.opstrellis.desktop";

pub struct Secrets {
    fallback_path: PathBuf,
    lock: Mutex<()>,
}

impl Secrets {
    pub fn new(data_dir: &std::path::Path) -> Self {
        Secrets { fallback_path: data_dir.join("secrets.json"), lock: Mutex::new(()) }
    }

    pub fn get(&self, id: &str) -> Option<String> {
        if let Ok(v) = keyring::Entry::new(SERVICE, id).and_then(|e| e.get_password()) {
            return Some(v);
        }
        self.read_file().remove(id)
    }

    pub fn set(&self, id: &str, value: &str) -> Result<()> {
        let value = value.trim();
        match keyring::Entry::new(SERVICE, id).and_then(|e| e.set_password(value)) {
            Ok(()) => {
                // Make sure no stale fallback copy remains.
                self.update_file(|m| {
                    m.remove(id);
                })
            }
            Err(e) => {
                log::warn!("keychain unavailable ({e}); storing secret in a 0600 file");
                self.update_file(|m| {
                    m.insert(id.to_string(), value.to_string());
                })
            }
        }
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        if let Ok(e) = keyring::Entry::new(SERVICE, id) {
            let _ = e.delete_credential();
        }
        self.update_file(|m| {
            m.remove(id);
        })
    }

    pub fn has(&self, id: &str) -> bool {
        self.get(id).is_some()
    }

    fn read_file(&self) -> HashMap<String, String> {
        std::fs::read(&self.fallback_path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn update_file(&self, f: impl FnOnce(&mut HashMap<String, String>)) -> Result<()> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut map = self.read_file();
        let before = map.len();
        f(&mut map);
        if map.is_empty() && before == 0 {
            return Ok(());
        }
        write_private(&self.fallback_path, &serde_json::to_vec(&map)?)
    }
}

fn write_private(path: &PathBuf, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(bytes)?;
    Ok(())
}
