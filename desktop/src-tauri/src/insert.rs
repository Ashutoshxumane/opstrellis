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
        return run_wayland(|tool| combo_args(tool, combo).iter().map(|a| a.to_string()).collect());
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

/// Tools that send keys on Wayland, in the order they're tried. wtype needs the compositor's
/// virtual-keyboard protocol, which GNOME lacks; ydotool works everywhere but needs its daemon.
const WAYLAND_TOOLS: [&str; 2] = ["wtype", "ydotool"];

fn combo_args(tool: &str, combo: Combo) -> &'static [&'static str] {
    match (tool, combo) {
        ("wtype", Combo::Paste) => &["-M", "ctrl", "-k", "v", "-m", "ctrl"],
        ("wtype", Combo::Copy) => &["-M", "ctrl", "-k", "c", "-m", "ctrl"],
        ("wtype", Combo::TerminalPaste) => &["-M", "ctrl", "-M", "shift", "-k", "v", "-m", "shift", "-m", "ctrl"],
        ("wtype", Combo::TerminalCopy) => &["-M", "ctrl", "-M", "shift", "-k", "c", "-m", "shift", "-m", "ctrl"],
        ("wtype", Combo::Enter) => &["-k", "Return"],
        // Linux input event codes: 29 LEFTCTRL, 42 LEFTSHIFT, 47 V, 46 C, 28 ENTER.
        (_, Combo::Paste) => &["key", "29:1", "47:1", "47:0", "29:0"],
        (_, Combo::Copy) => &["key", "29:1", "46:1", "46:0", "29:0"],
        (_, Combo::TerminalPaste) => &["key", "29:1", "42:1", "47:1", "47:0", "42:0", "29:0"],
        (_, Combo::TerminalCopy) => &["key", "29:1", "42:1", "46:1", "46:0", "42:0", "29:0"],
        (_, Combo::Enter) => &["key", "28:1", "28:0"],
    }
}

/// Runs the first installed Wayland key tool that works. Synthetic X11 keys only reach XWayland
/// apps, so without a working tool this is an error rather than a paste that silently goes nowhere.
fn run_wayland(args: impl Fn(&str) -> Vec<String>) -> Result<()> {
    let mut failures = Vec::new();
    for tool in WAYLAND_TOOLS.into_iter().filter(|t| has_tool(t)) {
        match run_tool(tool, &args(tool)) {
            Ok(()) => return Ok(()),
            Err(e) => failures.push(format!("{e:#}")),
        }
    }
    let why = if failures.is_empty() { "No tool to send keys is installed".to_string() } else { failures.join("; ") };
    Err(anyhow!("{why}. {}", wayland_tools_status().fix.unwrap_or_else(|| permission_hint().to_string())))
}

/// Runs a key tool; a non-zero exit is an error (with its message) so the caller's fallback runs.
fn run_tool(tool: &str, args: &[String]) -> Result<()> {
    let out = Command::new(tool).args(args).output()?;
    // ydotool reports on stdout, wtype on stderr.
    let output = format!("{}\n{}", String::from_utf8_lossy(&out.stderr), String::from_utf8_lossy(&out.stdout));
    let msg = output.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    anyhow::ensure!(out.status.success(), "{tool} failed ({}){}", out.status, if msg.is_empty() { String::new() } else { format!(": {msg}") });
    Ok(())
}

fn type_text(text: &str) -> Result<()> {
    wait_for_keys_released();
    if is_wayland() {
        return run_wayland(|tool| {
            let lead = if tool == "wtype" { vec![] } else { vec!["type".to_string()] };
            lead.into_iter().chain(["--".to_string(), text.to_string()]).collect()
        });
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

/// Whether text can be pasted on Wayland, and if not, what the user has to do.
#[derive(serde::Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolsStatus {
    /// The tool that works: "wtype" or "ydotool".
    pub ready: Option<&'static str>,
    pub problem: Option<String>,
    pub fix: Option<String>,
}

const RESTART: &str = "then restart your computer (logging out isn't enough, because the user session keeps running)";

pub fn wayland_tools_status() -> ToolsStatus {
    let gnome = crate::wayland::is_gnome();
    // Typing nothing still needs the compositor's virtual-keyboard protocol, so this checks it
    // without sending a key.
    let wtype = has_tool("wtype").then(|| run_tool("wtype", &[String::new()]));
    if matches!(wtype, Some(Ok(()))) {
        return ToolsStatus { ready: Some("wtype"), ..Default::default() };
    }
    let wtype_note = match &wtype {
        Some(Err(_)) if gnome => "GNOME doesn't support wtype. ",
        Some(Err(_)) => "wtype doesn't work with this desktop. ",
        _ => "",
    };
    if !has_tool("ydotool") {
        let (problem, fix) = if gnome || wtype.is_some() {
            ("ydotool isn't installed", format!("{wtype_note}Install ydotool (sudo apt install ydotool), add yourself to the input group (sudo usermod -aG input $USER), {RESTART}."))
        } else {
            ("No tool to send keys is installed", "Install wtype (sudo apt install wtype), or ydotool on GNOME.".to_string())
        };
        return ToolsStatus { ready: None, problem: Some(problem.into()), fix: Some(fix) };
    }
    if ydotool_daemon_running() {
        return ToolsStatus { ready: Some("ydotool"), ..Default::default() };
    }
    let (problem, fix) = match uinput_access() {
        Uinput::Ok => (
            "The ydotool service isn't running".to_string(),
            "Start it: systemctl --user enable --now ydotool".to_string(),
        ),
        Uinput::NeedsRestart => (
            "You're in the input group, but this session started before you were added".to_string(),
            "Restart your computer (logging out isn't enough, because the user session keeps running).".to_string(),
        ),
        Uinput::NotInGroup => (
            "ydotool can't create its virtual keyboard (/dev/uinput)".to_string(),
            format!("Add yourself to the input group (sudo usermod -aG input $USER), {RESTART}."),
        ),
    };
    ToolsStatus { ready: None, problem: Some(problem), fix: Some(fix) }
}

/// ydotoold listens on a datagram socket, at the path the ydotool client uses.
fn ydotool_daemon_running() -> bool {
    #[cfg(unix)]
    {
        let path = std::env::var("YDOTOOL_SOCKET")
            .map(std::path::PathBuf::from)
            .or_else(|_| std::env::var("XDG_RUNTIME_DIR").map(|d| std::path::Path::new(&d).join(".ydotool_socket")))
            .unwrap_or_else(|_| "/tmp/.ydotool_socket".into());
        std::os::unix::net::UnixDatagram::unbound().and_then(|s| s.connect(path)).is_ok()
    }
    #[cfg(not(unix))]
    false
}

enum Uinput {
    Ok,
    /// The input group lists the user, but this login session doesn't have it yet.
    NeedsRestart,
    NotInGroup,
}

fn uinput_access() -> Uinput {
    if std::fs::OpenOptions::new().write(true).open("/dev/uinput").is_ok() {
        return Uinput::Ok;
    }
    let groups = std::fs::read_to_string("/etc/group").unwrap_or_default();
    let user = std::env::var("USER").unwrap_or_default();
    let input = groups.lines().find(|l| l.starts_with("input:")).map(|l| l.split(':').collect::<Vec<_>>());
    let listed = input.as_ref().is_some_and(|f| f.get(3).is_some_and(|m| m.split(',').any(|u| u == user)));
    let gid = input.as_ref().and_then(|f| f.get(2).map(|g| g.to_string()));
    let has = std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("Groups:")).map(|l| l.split_whitespace().skip(1).any(|g| Some(g.to_string()) == gid)))
        .unwrap_or(false);
    if listed && !has {
        Uinput::NeedsRestart
    } else {
        Uinput::NotInGroup
    }
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
