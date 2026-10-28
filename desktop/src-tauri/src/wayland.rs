//! Global shortcuts on Wayland, where apps can't grab keys themselves (the X11 grab that
//! `hotkeys` makes only sees keys while an XWayland window is focused).
//!
//! - The XDG GlobalShortcuts portal (GNOME 48+, KDE Plasma, Hyprland): the desktop asks the user
//!   to approve the shortcuts once and then reports presses and releases, so hold-to-talk works.
//! - Otherwise on GNOME: custom keyboard shortcuts that run `opstrellis --toggle` and friends,
//!   added with gsettings on request. They only see presses, so they toggle.

// The portal and gsettings parts are Linux only; elsewhere just the conversions are built (tests).
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use crate::settings::Settings;
use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoundShortcut {
    pub id: String,
    /// How the desktop describes the keys ("Ctrl+Shift+Space"); empty if none is assigned.
    pub trigger: String,
}

/// The GlobalShortcuts portal session.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum PortalState {
    /// Not Wayland, or the desktop has no GlobalShortcuts portal.
    Unavailable,
    /// Waiting for the desktop (and the user, who is asked to approve the shortcuts).
    Binding,
    Bound { shortcuts: Vec<BoundShortcut> },
    Failed { error: String },
}

/// What the app needs from the desktop for shortcuts and insertion on Wayland, for Settings.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub portal: PortalState,
    pub gnome: bool,
    /// OpsTrellis's GNOME custom shortcuts are set up.
    pub gnome_shortcuts: bool,
}

/// Shortcut ids shared by the portal and the GNOME custom shortcuts, with the CLI flag each runs.
const SHORTCUTS: [(&str, &str, &str); 3] = [
    ("dictate", "OpsTrellis: dictate", "--toggle"),
    ("command", "OpsTrellis: command mode", "--command"),
    ("paste-last", "OpsTrellis: paste last transcript", "--paste-last"),
];

fn configured(s: &Settings, id: &str) -> String {
    match id {
        "dictate" => s.hotkeys.dictate.clone(),
        "command" => s.hotkeys.command.clone(),
        _ => s.hotkeys.paste_last.clone(),
    }
}

pub fn is_gnome() -> bool {
    std::env::var("XDG_CURRENT_DESKTOP").map(|d| d.split(':').any(|p| p.eq_ignore_ascii_case("GNOME"))).unwrap_or(false)
}

/// An accelerator as stored in settings ("Ctrl+Shift+Space") split into modifiers and an XKB
/// keysym name ("space"). None for single keys (Fn, Right ⌥) and keys with no keysym.
fn split(accel: &str) -> Option<(Vec<&'static str>, String)> {
    let parts: Vec<&str> = accel.split('+').filter(|p| !p.is_empty()).collect();
    let (key, mods) = parts.split_last()?;
    let mods = mods
        .iter()
        .map(|m| match m.to_ascii_lowercase().as_str() {
            "ctrl" | "control" | "commandorcontrol" | "cmdorctrl" => Some("CTRL"),
            "alt" | "option" => Some("ALT"),
            "shift" => Some("SHIFT"),
            "super" | "cmd" | "command" | "meta" => Some("LOGO"),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    let named = match *key {
        "Space" => "space",
        "Enter" | "Return" => "Return",
        "Tab" => "Tab",
        "Backspace" => "BackSpace",
        "Delete" => "Delete",
        "Insert" => "Insert",
        "Home" => "Home",
        "End" => "End",
        "PageUp" => "Page_Up",
        "PageDown" => "Page_Down",
        "Escape" => "Escape",
        "Up" | "Down" | "Left" | "Right" => key,
        "Minus" => "minus",
        "Equal" => "equal",
        "BracketLeft" => "bracketleft",
        "BracketRight" => "bracketright",
        "Backslash" => "backslash",
        "Semicolon" => "semicolon",
        "Quote" => "apostrophe",
        "Comma" => "comma",
        "Period" => "period",
        "Slash" => "slash",
        "Backquote" => "grave",
        k if k.len() == 1 && k.chars().all(|c| c.is_ascii_alphanumeric()) => return Some((mods, k.to_ascii_lowercase())),
        k if k.len() <= 3 && k.starts_with('F') && k[1..].parse::<u8>().is_ok_and(|n| (1..=24).contains(&n)) => k,
        _ => return None,
    };
    Some((mods, named.to_string()))
}

/// The XDG shortcuts format the portal takes as a preferred trigger: "CTRL+SHIFT+space".
pub fn portal_trigger(accel: &str) -> Option<String> {
    let (mods, key) = split(accel)?;
    Some(mods.into_iter().map(str::to_string).chain([key]).collect::<Vec<_>>().join("+"))
}

/// The GTK accelerator GNOME's custom shortcuts take: "<Control><Shift>space".
pub fn gtk_accel(accel: &str) -> Option<String> {
    let (mods, key) = split(accel)?;
    let gtk = |m: &str| match m {
        "CTRL" => "<Control>",
        "ALT" => "<Alt>",
        "SHIFT" => "<Shift>",
        _ => "<Super>",
    };
    Some(mods.into_iter().map(gtk).collect::<String>() + &key)
}

/// GNOME describes a trigger as "Press <Shift><Control>space"; show it as "Shift+Ctrl+Space".
/// Other desktops' descriptions are already readable.
fn readable_trigger(desc: &str) -> String {
    let desc = desc.trim();
    let Some(start) = desc.find('<') else { return desc.to_string() };
    let accel = &desc[start..];
    let mut parts: Vec<String> = Vec::new();
    let mut rest = accel;
    while let Some(r) = rest.strip_prefix('<') {
        let Some((m, after)) = r.split_once('>') else { return desc.to_string() };
        parts.push(match m.to_ascii_lowercase().as_str() {
            "control" | "primary" | "ctrl" => "Ctrl".into(),
            "super" | "meta" => "Super".into(),
            "alt" | "mod1" => "Alt".into(),
            "shift" => "Shift".into(),
            _ => m.to_string(),
        });
        rest = after;
    }
    let mut key = rest.chars();
    parts.push(key.next().map(|c| c.to_uppercase().chain(key).collect()).unwrap_or_default());
    parts.join("+")
}

/// The strings of a GVariant string array printed by gsettings (`['a', 'b']` or `@as []`).
fn parse_strv(s: &str) -> Vec<String> {
    let re = regex::Regex::new(r"'((?:[^'\\]|\\.)*)'").expect("valid");
    re.captures_iter(s).map(|c| c[1].to_string()).collect()
}

/// A GVariant string literal: gsettings parses values as GVariant text.
fn gvariant_str(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn format_strv(items: &[String]) -> String {
    format!("[{}]", items.iter().map(|i| gvariant_str(i)).collect::<Vec<_>>().join(", "))
}

/// A path as one shell word, for the command GNOME runs (it splits it like a shell).
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

#[cfg(target_os = "linux")]
pub use linux::*;

#[cfg(not(target_os = "linux"))]
mod other {
    use super::*;
    use std::sync::Arc;
    pub fn start(_app: &Arc<crate::App>) {}
    pub fn rebind(_app: &Arc<crate::App>) -> anyhow::Result<()> {
        anyhow::bail!("Only needed on Wayland")
    }
    pub fn add_gnome_shortcuts(_s: &Settings) -> anyhow::Result<()> {
        anyhow::bail!("Only needed on GNOME")
    }
    pub fn status() -> Status {
        Status { portal: PortalState::Unavailable, gnome: false, gnome_shortcuts: false }
    }
}
#[cfg(not(target_os = "linux"))]
pub use other::*;

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use crate::pipeline::Mode;
    use crate::App;
    use anyhow::{anyhow, bail, Context, Result};
    use std::collections::HashMap;
    use std::process::Command;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};
    use zbus::blocking::{Connection, Proxy};
    use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value};

    const DEST: &str = "org.freedesktop.portal.Desktop";
    const PATH: &str = "/org/freedesktop/portal/desktop";
    const IFACE: &str = "org.freedesktop.portal.GlobalShortcuts";

    struct Portal {
        conn: Connection,
        /// The current session; presses from older ones are ignored.
        session: Mutex<Option<OwnedObjectPath>>,
        /// Rebinding is serialized: each one waits for the user to answer the desktop's dialog.
        bind_lock: Mutex<()>,
    }

    static PORTAL: OnceLock<Option<Portal>> = OnceLock::new();
    static STATE: Mutex<PortalState> = Mutex::new(PortalState::Unavailable);

    fn set_state(app: &App, state: PortalState) {
        *STATE.lock().unwrap_or_else(|e| e.into_inner()) = state;
        crate::emit_permissions_changed(app);
    }

    fn portal() -> Option<&'static Portal> {
        PORTAL
            .get_or_init(|| {
                let conn = Connection::session().map_err(|e| log::info!("no session bus: {e}")).ok()?;
                register_app_id(&conn);
                let proxy = Proxy::new(&conn, DEST, PATH, IFACE).ok()?;
                // A desktop without this portal has no such property.
                let version = proxy.get_property::<u32>("version").map_err(|e| log::info!("no GlobalShortcuts portal: {e}")).ok()?;
                log::info!("GlobalShortcuts portal version {version}");
                Some(Portal { conn, session: Mutex::new(None), bind_lock: Mutex::new(()) })
            })
            .as_ref()
    }

    /// GNOME's portal refuses apps it can't identify ("An app id is required"). An app that isn't
    /// sandboxed names itself, which the portal accepts if a matching .desktop file is installed:
    /// install.sh adds opstrellis.desktop, the .deb OpsTrellis.desktop. Must precede other portal calls.
    fn register_app_id(conn: &Connection) {
        let Ok(registry) = Proxy::new(conn, DEST, PATH, "org.freedesktop.host.portal.Registry") else { return };
        for id in ["opstrellis", "OpsTrellis"] {
            let opts: HashMap<&str, Value> = HashMap::new();
            match registry.call_method("Register", &(id, opts)) {
                Ok(_) => return log::info!("portal app id: {id}"),
                Err(e) => log::debug!("portal app id {id}: {e}"),
            }
        }
    }

    /// Binds the shortcuts through the portal, if the desktop has one, and listens for them.
    pub fn start(app: &Arc<App>) {
        if !crate::insert::is_wayland() {
            return;
        }
        // Until the portal answers, so the UI doesn't report shortcuts missing in the meantime.
        *STATE.lock().unwrap_or_else(|e| e.into_inner()) = PortalState::Binding;
        let app = app.clone();
        std::thread::spawn(move || {
            let Some(p) = portal() else { return set_state(&app, PortalState::Unavailable) };
            let listener = app.clone();
            std::thread::spawn(move || listen(p, &listener));
            if let Err(e) = bind(p, &app) {
                log::warn!("GlobalShortcuts: {e:#}");
            }
        });
    }

    /// Asks the desktop again, e.g. after the user dismissed its dialog.
    pub fn rebind(app: &Arc<App>) -> Result<()> {
        let p = portal().ok_or_else(|| anyhow!("This desktop has no global shortcuts portal"))?;
        let app = app.clone();
        std::thread::spawn(move || {
            if let Err(e) = bind(p, &app) {
                log::warn!("GlobalShortcuts: {e:#}");
            }
        });
        Ok(())
    }

    pub fn status() -> Status {
        let wayland = crate::insert::is_wayland();
        Status {
            portal: if wayland { STATE.lock().unwrap_or_else(|e| e.into_inner()).clone() } else { PortalState::Unavailable },
            gnome: is_gnome(),
            gnome_shortcuts: wayland && is_gnome() && gnome_shortcuts_installed(),
        }
    }

    /// Calls a portal method that answers with a Request's Response signal, and waits for it.
    fn request<B>(p: &Portal, method: &str, body: &B, token: &str) -> Result<HashMap<String, OwnedValue>>
    where
        B: serde::Serialize + zbus::zvariant::DynamicType,
    {
        let sender = p.conn.unique_name().ok_or_else(|| anyhow!("no bus name"))?.trim_start_matches(':').replace('.', "_");
        let path = format!("{PATH}/request/{sender}/{token}");
        let request = Proxy::new(&p.conn, DEST, path, "org.freedesktop.portal.Request")?;
        // Subscribed before the call, so a fast answer isn't missed.
        let mut responses = request.receive_signal("Response")?;
        Proxy::new(&p.conn, DEST, PATH, IFACE)?.call_method(method, body).with_context(|| format!("{method} failed"))?;
        // The user may leave the dialog open; a desktop that never answers mustn't block rebinding.
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(responses.next());
        });
        let msg = rx
            .recv_timeout(std::time::Duration::from_secs(300))
            .ok()
            .flatten()
            .ok_or_else(|| anyhow!("{method}: the desktop didn't answer"))?;
        let (code, results): (u32, HashMap<String, OwnedValue>) = msg.body().deserialize()?;
        match code {
            0 => Ok(results),
            1 => bail!("You dismissed the shortcut request"),
            _ => bail!("The desktop refused the shortcuts"),
        }
    }

    fn token() -> String {
        static N: AtomicU32 = AtomicU32::new(0);
        format!("opstrellis_{}_{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst))
    }

    fn bind(p: &Portal, app: &Arc<App>) -> Result<()> {
        let _serial = p.bind_lock.lock().unwrap_or_else(|e| e.into_inner());
        set_state(app, PortalState::Binding);
        let result = (|| -> Result<Vec<BoundShortcut>> {
            if let Some(old) = p.session.lock().unwrap().take() {
                if let Ok(s) = Proxy::new(&p.conn, DEST, old, "org.freedesktop.portal.Session") {
                    let _ = s.call_method("Close", &());
                }
            }
            let (t, st) = (token(), token());
            let opts: HashMap<&str, Value> = HashMap::from([("handle_token", Value::from(t.as_str())), ("session_handle_token", Value::from(st.as_str()))]);
            let created = request(p, "CreateSession", &(opts,), &t)?;
            // A string per the spec; some portals send an object path.
            let handle = created.get("session_handle").ok_or_else(|| anyhow!("CreateSession: no session"))?;
            let session = match String::try_from(handle.try_clone()?) {
                Ok(s) => OwnedObjectPath::try_from(s)?,
                Err(_) => OwnedObjectPath::try_from(handle.try_clone()?)?,
            };
            *p.session.lock().unwrap() = Some(session.clone());

            let settings = app.settings();
            let triggers: Vec<(String, String)> = SHORTCUTS.iter().map(|(id, _, _)| (id.to_string(), configured(&settings, id))).collect();
            let shortcuts: Vec<(&str, HashMap<&str, Value>)> = SHORTCUTS
                .iter()
                .zip(&triggers)
                .map(|((id, name, _), (_, accel))| {
                    let description = name.trim_start_matches("OpsTrellis: ");
                    let mut o = HashMap::from([("description", Value::from(capitalize(description)))]);
                    if let Some(t) = portal_trigger(accel) {
                        o.insert("preferred_trigger", Value::from(t));
                    }
                    (*id, o)
                })
                .collect();
            let t = token();
            let opts: HashMap<&str, Value> = HashMap::from([("handle_token", Value::from(t.as_str()))]);
            let bound = request(p, "BindShortcuts", &(ObjectPath::from(&session), shortcuts, "", opts), &t)?;
            Ok(bound.get("shortcuts").map(|v| parse_shortcuts(v)).unwrap_or_default())
        })();
        match result {
            Ok(shortcuts) => {
                log::info!("GlobalShortcuts bound: {shortcuts:?}");
                // Custom shortcuts added while the portal was unavailable would fire too (and toggle).
                if is_gnome() && gnome_shortcuts_installed() {
                    if let Err(e) = remove_gnome_shortcuts() {
                        log::warn!("removing GNOME custom shortcuts: {e:#}");
                    }
                }
                set_state(app, PortalState::Bound { shortcuts });
                Ok(())
            }
            Err(e) => {
                set_state(app, PortalState::Failed { error: format!("{e:#}") });
                Err(e)
            }
        }
    }

    fn capitalize(s: &str) -> String {
        let mut c = s.chars();
        c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
    }

    /// `a(sa{sv})`: each shortcut's id and how the desktop describes its trigger.
    fn parse_shortcuts(v: &Value) -> Vec<BoundShortcut> {
        v.try_clone().ok().and_then(|v| <Vec<(String, HashMap<String, OwnedValue>)>>::try_from(v).ok()).map(to_bound).unwrap_or_default()
    }

    fn to_bound(list: Vec<(String, HashMap<String, OwnedValue>)>) -> Vec<BoundShortcut> {
        list.into_iter()
            .map(|(id, props)| BoundShortcut {
                id,
                trigger: props.get("trigger_description").and_then(|t| String::try_from(t.clone()).ok()).map(|t| readable_trigger(&t)).unwrap_or_default(),
            })
            .collect()
    }

    /// Dispatches presses and releases of the current session's shortcuts, like `hotkeys::handle`.
    fn listen(p: &'static Portal, app: &Arc<App>) {
        let signals = match Proxy::new(&p.conn, DEST, PATH, IFACE).and_then(|proxy| proxy.receive_all_signals()) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("GlobalShortcuts: can't listen: {e}");
                return;
            }
        };
        // The desktop repeats Activated while a key is held (key repeat); only the first is a press.
        let mut held = std::collections::HashSet::new();
        let mut held_session = None;
        for msg in signals {
            let header = msg.header();
            let Some(member) = header.member().map(|m| m.to_string()) else { continue };
            let current = p.session.lock().unwrap().clone();
            // A closed session never sends its releases.
            if held_session != current {
                held.clear();
                held_session = current.clone();
            }
            if member == "ShortcutsChanged" {
                if let Ok((session, list)) = msg.body().deserialize::<(OwnedObjectPath, Vec<(String, HashMap<String, OwnedValue>)>)>() {
                    if Some(&session) == current.as_ref() {
                        set_state(app, PortalState::Bound { shortcuts: to_bound(list) });
                    }
                }
                continue;
            }
            let pressed = match member.as_str() {
                "Activated" => true,
                "Deactivated" => false,
                _ => continue,
            };
            let Ok((session, id, _ts, _opts)) = msg.body().deserialize::<(OwnedObjectPath, String, u64, HashMap<String, OwnedValue>)>() else { continue };
            if Some(&session) != current.as_ref() || (pressed && !held.insert(id.clone())) {
                continue;
            }
            if !pressed {
                held.remove(&id);
            }
            log::debug!("portal shortcut {id} {}", if pressed { "pressed" } else { "released" });
            let app = app.clone();
            let _ = app.handle.clone().run_on_main_thread(move || match (id.as_str(), pressed) {
                ("dictate", true) => app.on_press(Mode::Dictate),
                ("command", true) => app.on_press(Mode::Command),
                ("dictate" | "command", false) => app.on_release(),
                ("paste-last", true) => {
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = app.paste_last().await {
                            app.report_error(&format!("{e:#}"));
                        }
                    });
                }
                _ => {}
            });
        }
    }

    #[cfg(test)]
    #[test]
    fn shortcuts_changed_signal_decodes() {
        // The portal's ShortcutsChanged signal has the signature `oa(sa{sv})`.
        let list = vec![("dictate", HashMap::from([("description", Value::from("Dictate")), ("trigger_description", Value::from("Press <Super>e"))]))];
        let msg = zbus::message::Message::signal(PATH, IFACE, "ShortcutsChanged").unwrap().build(&(ObjectPath::try_from("/s/1").unwrap(), list)).unwrap();
        let (session, list) = msg.body().deserialize::<(OwnedObjectPath, Vec<(String, HashMap<String, OwnedValue>)>)>().unwrap();
        assert_eq!(session.as_str(), "/s/1");
        assert_eq!(to_bound(list), vec![BoundShortcut { id: "dictate".into(), trigger: "Super+E".into() }]);
    }

    // ---------- GNOME custom shortcuts ----------

    const MEDIA_KEYS: &str = "org.gnome.settings-daemon.plugins.media-keys";
    const BASE: &str = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings";

    /// gsettings for the host's settings. The AppImage points GIO at its own modules, which would
    /// make gsettings write to a throwaway in-memory backend instead of dconf.
    fn gsettings(args: &[&str]) -> Result<String> {
        let out = Command::new("gsettings")
            .args(args)
            .env_remove("GIO_MODULE_DIR")
            .env_remove("GIO_EXTRA_MODULES")
            .env_remove("GSETTINGS_SCHEMA_DIR")
            .env_remove("GSETTINGS_BACKEND")
            .output()
            .context("gsettings is not installed")?;
        anyhow::ensure!(out.status.success(), "gsettings {}: {}", args.first().unwrap_or(&""), String::from_utf8_lossy(&out.stderr).trim());
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    fn path(id: &str) -> String {
        format!("{BASE}/opstrellis-{id}/")
    }

    fn gnome_shortcuts_installed() -> bool {
        gsettings(&["get", MEDIA_KEYS, "custom-keybindings"]).map(|l| parse_strv(&l).contains(&path("dictate"))).unwrap_or(false)
    }

    fn remove_gnome_shortcuts() -> Result<()> {
        let ours: Vec<String> = SHORTCUTS.iter().map(|(id, _, _)| path(id)).collect();
        let paths: Vec<String> = parse_strv(&gsettings(&["get", MEDIA_KEYS, "custom-keybindings"])?).into_iter().filter(|p| !ours.contains(p)).collect();
        gsettings(&["set", MEDIA_KEYS, "custom-keybindings", &format_strv(&paths)])?;
        for p in &ours {
            let _ = gsettings(&["reset-recursively", &format!("{MEDIA_KEYS}.custom-keybinding:{p}")]);
        }
        Ok(())
    }

    /// What GNOME should run: the AppImage (whose path the runtime passes in) or this binary.
    fn launcher() -> Result<String> {
        if let Ok(p) = std::env::var("APPIMAGE") {
            return Ok(p);
        }
        Ok(std::env::current_exe()?.to_string_lossy().into_owned())
    }

    /// Adds (or updates) GNOME custom shortcuts that run `opstrellis --toggle` and friends with
    /// the configured keys, keeping the user's other custom shortcuts.
    pub fn add_gnome_shortcuts(s: &Settings) -> Result<()> {
        anyhow::ensure!(is_gnome(), "This isn't a GNOME desktop: add the shortcuts in your desktop's keyboard settings");
        let exe = shell_quote(&launcher()?);
        let mut paths = parse_strv(&gsettings(&["get", MEDIA_KEYS, "custom-keybindings"])?);
        for (id, name, flag) in SHORTCUTS {
            let accel = configured(s, id);
            let binding = gtk_accel(&accel).ok_or_else(|| anyhow!("{accel} can't be a GNOME shortcut; choose a key combination"))?;
            let p = path(id);
            let schema = format!("{MEDIA_KEYS}.custom-keybinding:{p}");
            gsettings(&["set", &schema, "name", &gvariant_str(name)])?;
            gsettings(&["set", &schema, "command", &gvariant_str(&format!("{exe} {flag}"))])?;
            gsettings(&["set", &schema, "binding", &gvariant_str(&binding)])?;
            if !paths.contains(&p) {
                paths.push(p);
            }
        }
        gsettings(&["set", MEDIA_KEYS, "custom-keybindings", &format_strv(&paths)])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn triggers() {
        assert_eq!(portal_trigger("Ctrl+Shift+Space").as_deref(), Some("CTRL+SHIFT+space"));
        assert_eq!(portal_trigger("Super+K").as_deref(), Some("LOGO+k"));
        assert_eq!(portal_trigger("Ctrl+Alt+BracketLeft").as_deref(), Some("CTRL+ALT+bracketleft"));
        assert_eq!(portal_trigger("Alt+F5").as_deref(), Some("ALT+F5"));
        assert_eq!(portal_trigger("Fn"), None);
        assert_eq!(portal_trigger("RightOption"), None);
        assert_eq!(portal_trigger("Hyper+X"), None);
        assert_eq!(gtk_accel("Ctrl+Shift+Space").as_deref(), Some("<Control><Shift>space"));
        assert_eq!(gtk_accel("Ctrl+Alt+V").as_deref(), Some("<Control><Alt>v"));
        assert_eq!(gtk_accel("Super+PageUp").as_deref(), Some("<Super>Page_Up"));
        assert_eq!(readable_trigger("Press <Shift><Control>space"), "Shift+Ctrl+Space");
        assert_eq!(readable_trigger("<Super>k"), "Super+K");
        assert_eq!(readable_trigger("Ctrl+Shift+Space"), "Ctrl+Shift+Space");
        assert_eq!(readable_trigger(""), "");
    }

    #[test]
    fn gsettings_lists() {
        assert!(parse_strv("@as []").is_empty());
        let l = parse_strv("['/a/custom0/', '/a/opstrellis-dictate/']");
        assert_eq!(l, vec!["/a/custom0/", "/a/opstrellis-dictate/"]);
        assert_eq!(format_strv(&l), "['/a/custom0/', '/a/opstrellis-dictate/']");
        assert_eq!(format_strv(&[]), "[]");
        assert_eq!(gvariant_str(r"'/a b/x' --toggle"), r"'\'/a b/x\' --toggle'");
        assert_eq!(shell_quote("/home/o'neil/OpsTrellis.AppImage"), r"'/home/o'\''neil/OpsTrellis.AppImage'");
    }
}
