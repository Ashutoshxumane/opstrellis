//! Inserting text into the focused app. Default is clipboard paste (fast and reliable for long or
//! Unicode text): save the clipboard, put our text on it, send the paste shortcut, restore.
//! Terminals on Linux paste with Ctrl+Shift+V. On Wayland, synthetic X11 key events don't reach
//! native apps, so we use `wtype` or `ydotool` when available.

use crate::context::AppContext;
use anyhow::{anyhow, Result};
use enigo::{Direction, Enigo, Key, Keyboard};
use std::process::Command;
use std::sync::Mutex;
use std::thread::sleep;
use std::time::Duration;

enum Saved {
    Text(String),
    Image(arboard::ImageData<'static>),
}

pub struct Inserter {
    // Kept alive for the app's lifetime: on X11 the clipboard owner must exist while apps read it.
    clipboard: Mutex<Option<arboard::Clipboard>>,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Combo {
    Paste,
    TerminalPaste,
    Copy,
    TerminalCopy,
    Enter,
}

/// Text on the clipboard that history managers skip (nspasteboard.org's concealed type on macOS,
/// Windows clipboard history exclusion, KDE's password-manager hint on Linux).
fn set_transient(c: &mut arboard::Clipboard, text: &str) -> Result<(), arboard::Error> {
    #[cfg(target_os = "macos")]
    use arboard::SetExtApple;
    #[cfg(target_os = "linux")]
    use arboard::SetExtLinux;
    #[cfg(target_os = "windows")]
    use arboard::SetExtWindows;
    c.set().exclude_from_history().text(text.to_string())
}

pub fn is_wayland() -> bool {
    cfg!(target_os = "linux") && std::env::var("XDG_SESSION_TYPE").map(|v| v == "wayland").unwrap_or(false)
}

fn has_tool(name: &str) -> bool {
    Command::new("sh").arg("-c").arg(format!("command -v {name}")).output().map(|o| o.status.success()).unwrap_or(false)
}

impl Inserter {
    pub fn new() -> Self {
        Inserter { clipboard: Mutex::new(arboard::Clipboard::new().map_err(|e| log::warn!("clipboard unavailable: {e}")).ok()) }
    }

    fn with_clipboard<T>(&self, f: impl FnOnce(&mut arboard::Clipboard) -> T) -> Result<T> {
        let mut g = self.clipboard.lock().unwrap_or_else(|e| e.into_inner());
        if g.is_none() {
            *g = arboard::Clipboard::new().ok();
        }
        g.as_mut().map(f).ok_or_else(|| anyhow!("Clipboard is not available"))
    }

    /// The user's clipboard (text or image) so it can be put back after we use it.
    fn save_clipboard(&self) -> Result<Option<Saved>> {
        self.with_clipboard(|c| match c.get_text() {
            Ok(t) => Some(Saved::Text(t)),
            Err(_) => c.get_image().ok().map(Saved::Image),
        })
    }

    fn restore_clipboard(&self, saved: Saved) {
        let _ = self.with_clipboard(|c| match saved {
            Saved::Text(t) => c.set_text(t),
            Saved::Image(i) => c.set_image(i),
        });
    }

    pub fn insert(&self, text: &str, ctx: &AppContext, method: &str, restore: bool, restore_delay_ms: u64) -> Result<()> {
        if text.is_empty() {
            return Ok(());
        }
        if method == "type" {
            return type_text(text);
        }
        // On Wayland we can't see the focused app, so a native terminal may ignore Ctrl+V. Leave
        // the text on the clipboard in that case so it is never lost.
        let restore = restore && !(is_wayland() && ctx.app_name.is_none());
        let saved = if restore { self.save_clipboard()? } else { None };
        if saved.is_some() {
            // Only there for the paste: keep it out of clipboard managers' history.
            self.with_clipboard(|c| set_transient(c, text))??;
        } else {
            self.with_clipboard(|c| c.set_text(text.to_string()))??;
        }
        sleep(Duration::from_millis(40));
        send(if ctx.is_terminal { Combo::TerminalPaste } else { Combo::Paste })?;
        if let Some(old) = saved {
            // Restoring too early makes slow apps paste the old content.
            sleep(Duration::from_millis(restore_delay_ms.max(100)));
            // Something the user copied in the meantime wins over what they had before.
            if self.with_clipboard(|c| c.get_text().ok())?.as_deref() == Some(text) {
                self.restore_clipboard(old);
            }
        }
        Ok(())
    }

    /// The clipboard's text, if it holds text.
    pub fn get_clipboard(&self) -> Option<String> {
        self.with_clipboard(|c| c.get_text().ok()).ok().flatten()
    }

    pub fn set_clipboard(&self, text: &str) -> Result<()> {
        self.with_clipboard(|c| c.set_text(text.to_string()))??;
        Ok(())
    }

    /// Copies the current selection of the focused app (command mode). Returns None when nothing
    /// is selected. The user's clipboard is restored afterwards.
    pub fn copy_selection(&self, ctx: &AppContext) -> Result<Option<String>> {
        const SENTINEL: &str = "\u{2063}opstrellis-no-selection\u{2063}";
        let saved = self.save_clipboard()?;
        self.with_clipboard(|c| c.set_text(SENTINEL.to_string()))??;
        sleep(Duration::from_millis(30));
        send(if ctx.is_terminal { Combo::TerminalCopy } else { Combo::Copy })?;
        let mut selection = None;
        for _ in 0..10 {
            sleep(Duration::from_millis(30));
            let now = self.with_clipboard(|c| c.get_text().ok())?;
            if let Some(t) = now.filter(|t| t != SENTINEL) {
                selection = Some(t);
                break;
            }
        }
        match saved {
            Some(old) => self.restore_clipboard(old),
            // Nothing we can restore (e.g. copied files): just don't leave our marker behind.
            None => {
                if self.with_clipboard(|c| c.get_text().ok())?.as_deref() == Some(SENTINEL) {
                    self.with_clipboard(|c| c.clear())?.ok();
                }
            }
        }
        Ok(selection.filter(|s| !s.trim().is_empty()))
    }

    pub fn press_enter(&self) -> Result<()> {
        sleep(Duration::from_millis(60));
        send(Combo::Enter)
    }
}

fn send(combo: Combo) -> Result<()> {
    wait_for_keys_released();
    if is_wayland() {
        if let Some(r) = send_wayland(combo) {
            return r;
        }
    }
    let mut e = Enigo::new(&enigo::Settings::default()).map_err(|e| anyhow!("Cannot simulate keys: {e}. {}", permission_hint()))?;
    let modifier = if cfg!(target_os = "macos") { Key::Meta } else { Key::Control };
    // On macOS, Key::Unicode looks up the keyboard layout (TIS), which aborts off the main
    // thread on macOS 14+; use virtual key codes (kVK_ANSI_V = 9, kVK_ANSI_C = 8) there.
    let (v, c) = if cfg!(target_os = "macos") { (Key::Other(9), Key::Other(8)) } else { (Key::Unicode('v'), Key::Unicode('c')) };
    let (mods, key): (Vec<Key>, Key) = match combo {
        Combo::Paste => (vec![modifier], v),
        Combo::Copy => (vec![modifier], c),
        Combo::TerminalPaste if cfg!(target_os = "macos") => (vec![modifier], v),
        Combo::TerminalCopy if cfg!(target_os = "macos") => (vec![modifier], c),
        Combo::TerminalPaste => (vec![Key::Control, Key::Shift], v),
        Combo::TerminalCopy => (vec![Key::Control, Key::Shift], c),
        Combo::Enter => (vec![], Key::Return),
    };
    for m in &mods {
        e.key(*m, Direction::Press)?;
    }
    let r = e.key(key, Direction::Click);
    for m in mods.iter().rev() {
        e.key(*m, Direction::Release)?;
    }
    r?;
    Ok(())
}

/// Returns None when no Wayland input tool is installed (falls back to enigo/XWayland).
fn send_wayland(combo: Combo) -> Option<Result<()>> {
    let run = |cmd: &str, args: &[&str]| -> Result<()> {
        let st = Command::new(cmd).args(args).status()?;
        if st.success() {
            Ok(())
        } else {
            Err(anyhow!("{cmd} failed ({st})"))
        }
    };
    if has_tool("wtype") {
        let args: &[&str] = match combo {
            Combo::Paste => &["-M", "ctrl", "-k", "v", "-m", "ctrl"],
            Combo::Copy => &["-M", "ctrl", "-k", "c", "-m", "ctrl"],
            Combo::TerminalPaste => &["-M", "ctrl", "-M", "shift", "-k", "v", "-m", "shift", "-m", "ctrl"],
            Combo::TerminalCopy => &["-M", "ctrl", "-M", "shift", "-k", "c", "-m", "shift", "-m", "ctrl"],
            Combo::Enter => &["-k", "Return"],
        };
        return Some(run("wtype", args));
    }
    if has_tool("ydotool") {
        // Linux input event codes: 29 LEFTCTRL, 42 LEFTSHIFT, 47 V, 46 C, 28 ENTER.
        let args: &[&str] = match combo {
            Combo::Paste => &["key", "29:1", "47:1", "47:0", "29:0"],
            Combo::Copy => &["key", "29:1", "46:1", "46:0", "29:0"],
            Combo::TerminalPaste => &["key", "29:1", "42:1", "47:1", "47:0", "42:0", "29:0"],
            Combo::TerminalCopy => &["key", "29:1", "42:1", "46:1", "46:0", "42:0", "29:0"],
            Combo::Enter => &["key", "28:1", "28:0"],
        };
        return Some(run("ydotool", args));
    }
    None
}

fn type_text(text: &str) -> Result<()> {
    wait_for_keys_released();
    if is_wayland() {
        if has_tool("wtype") {
            return run_ok(Command::new("wtype").arg("--").arg(text));
        }
        if has_tool("ydotool") {
            return run_ok(Command::new("ydotool").args(["type", "--", text]));
        }
    }
    let mut e = Enigo::new(&enigo::Settings::default()).map_err(|e| anyhow!("Cannot simulate keys: {e}. {}", permission_hint()))?;
    e.text(text)?;
    Ok(())
}

/// Synthetic keys combine with the keys the user is still holding. Stopping command mode with
/// ⌃⌥Space and then sending ⌘C while ⌥ and Space are still down is ⌥⌘Space, which opens a Finder
/// search window (it takes focus, so the selection is never copied or replaced). So first wait,
/// up to 1.5 s, for the keyboard to be let go. Returns whether any key was held.
#[cfg(target_os = "macos")]
pub fn wait_for_keys_released() -> bool {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceFlagsState(state: i32) -> u64;
        fn CGEventSourceKeyState(state: i32, key: u16) -> bool;
    }
    const HID_SYSTEM_STATE: i32 = 1;
    // Shift, Control, Option, Command and Fn (not Caps Lock, which stays on).
    const MODIFIERS: u64 = 0x0002_0000 | 0x0004_0000 | 0x0008_0000 | 0x0010_0000 | 0x0080_0000;
    // Modifier keys (key codes 54–63: ⌘ ⇧ ⇪ ⌥ ⌃ fn) are covered by the flags; Caps Lock may
    // read as held while it is on.
    let held = || unsafe {
        CGEventSourceFlagsState(HID_SYSTEM_STATE) & MODIFIERS != 0
            || (0..128).filter(|k| !(54..=63).contains(k)).any(|k| CGEventSourceKeyState(HID_SYSTEM_STATE, k))
    };
    if !held() {
        return false;
    }
    let deadline = std::time::Instant::now() + Duration::from_millis(1500);
    while held() && std::time::Instant::now() < deadline {
        sleep(Duration::from_millis(15));
    }
    if held() {
        log::warn!("keys still held after 1.5 s; sending anyway");
    }
    // Let the release reach the focused app first.
    sleep(Duration::from_millis(30));
    true
}

#[cfg(not(target_os = "macos"))]
pub fn wait_for_keys_released() -> bool {
    false
}

/// Runs a typing tool; a non-zero exit is an error so the caller's clipboard fallback runs.
fn run_ok(cmd: &mut Command) -> Result<()> {
    let st = cmd.status()?;
    anyhow::ensure!(st.success(), "{:?} failed ({st})", cmd.get_program());
    Ok(())
}

fn permission_hint() -> &'static str {
    if cfg!(target_os = "macos") {
        "Open OpsTrellis Settings → Permissions and click Grant access, even if System Settings already shows \
         OpsTrellis switched on (macOS drops the permission when OpsTrellis is updated)."
    } else if is_wayland() {
        "On Wayland install wtype (wlroots/KDE) or ydotool (GNOME)."
    } else {
        "Make sure an X11 display is available."
    }
}

#[cfg(target_os = "macos")]
pub fn accessibility_granted(prompt: bool) -> bool {
    if prompt {
        macos_accessibility_client::accessibility::application_is_trusted_with_prompt()
    } else {
        macos_accessibility_client::accessibility::application_is_trusted()
    }
}

#[cfg(not(target_os = "macos"))]
pub fn accessibility_granted(_prompt: bool) -> bool {
    true
}
