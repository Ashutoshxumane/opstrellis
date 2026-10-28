//! Global shortcuts with press/release events (hold = push-to-talk, tap = hands-free). Single-key
//! shortcuts on macOS (Fn, Right ⌥, …) are handled by `fnkey` instead (hold = push-to-talk,
//! double-tap = hands-free).
//! Esc is grabbed only while recording so it keeps working everywhere else.

use crate::fnkey;
use crate::pipeline::Mode;
use crate::App;
use anyhow::{anyhow, Result};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Action {
    Dictate,
    Command,
    PasteLast,
    Cancel,
    /// `FALLBACK`: each press starts or finishes a hands-free dictation.
    Fallback,
}

/// Always registered for dictation, so there is a way to dictate even when the configured
/// shortcut fails (a single key without its permission, a combination another app took).
pub const FALLBACK: &str = "Ctrl+Shift+Space";

fn parse(s: &str) -> Result<Shortcut> {
    s.parse::<Shortcut>().map_err(|e| anyhow!("Invalid shortcut \"{s}\": {e}"))
}

/// (Re-)registers the configured shortcuts. On failure the previous ones are restored. A
/// single-key shortcut (macOS) isn't a global shortcut: it is handed to `fnkey`.
/// `startup`: the first registration, with nothing to roll back to.
pub fn register(app: &Arc<App>, startup: bool) -> Result<()> {
    let s = app.settings();
    let all = [(&s.hotkeys.dictate, Action::Dictate), (&s.hotkeys.command, Action::Command), (&s.hotkeys.paste_last, Action::PasteLast)];
    let mut single = single_key(&all)?;
    let mut unsupported = None;
    // Only macOS can watch a single key. One stored elsewhere (settings copied from a Mac or edited
    // by hand) is skipped, so the other shortcuts and the fallback keep working.
    if let Some((key, _)) = single.filter(|_| !cfg!(target_os = "macos")) {
        unsupported = Some(format!("{} can't be a shortcut on this system, so {FALLBACK} is used instead. Choose a key combination in Settings → Shortcuts.", key.name()));
        single = None;
    }
    let wanted = all.iter().filter(|(k, _)| fnkey::Key::parse(k).is_none()).map(|(k, a)| Ok((parse(k)?, *a))).collect::<Result<Vec<_>>>()?;
    let mut ids: Vec<u32> = wanted.iter().map(|(sc, _)| sc.id()).collect();
    ids.sort_unstable();
    ids.dedup();
    if ids.len() != wanted.len() {
        return Err(anyhow!("Each shortcut must be different"));
    }
    // The shortcut recorder is open: checked, and applied when it closes (`resume`).
    if SUSPENDED.load(Ordering::SeqCst) {
        return Ok(());
    }
    let gs = app.handle.global_shortcut();
    // Esc, grabbed while a dictation runs, stays as it is.
    let (cancel, previous): (Vec<_>, Vec<_>) = std::mem::take(&mut *app.shortcuts.lock().unwrap()).into_iter().partition(|(_, a)| *a == Action::Cancel);
    // unregister_multiple, not unregister_all: the latter holds the plugin's lock across a
    // main-thread round-trip and can deadlock with a key event being dispatched.
    let _ = gs.unregister_multiple(previous.iter().map(|(s, _)| *s).collect::<Vec<_>>());
    let binding = single.map(|(key, a)| (key, if a == Action::Command { Mode::Command } else { Mode::Dictate }));
    // Nothing to roll back to at startup: a combination another app owns mustn't also disable Fn.
    let mut registered: Vec<(Shortcut, Action)> = Vec::new();
    for (sc, action) in &wanted {
        if let Err(e) = gs.register(*sc) {
            let _ = gs.unregister_multiple(registered.iter().map(|(s, _)| *s).collect::<Vec<_>>());
            for (p, _) in &previous {
                let _ = gs.register(*p);
            }
            let mut kept = previous;
            add_fallback(gs, &mut kept);
            *app.shortcuts.lock().unwrap() = kept.into_iter().chain(cancel).collect();
            if startup {
                fnkey::set(app, binding);
            }
            return Err(anyhow!("Could not register {sc}: {e} (is another app using it?)"));
        }
        registered.push((*sc, *action));
    }
    add_fallback(gs, &mut registered);
    registered.extend(cancel);
    *app.shortcuts.lock().unwrap() = registered;
    *app.hotkey_error.lock().unwrap() = None;
    if !fnkey::set(app, binding) {
        // Not fatal: Fn starts working by itself once the permission is granted (and then clears
        // this error, so set it first and recheck in case that just happened).
        *app.hotkey_error.lock().unwrap() = Some(fnkey::permission_error());
        if fnkey::active() == Some(true) {
            *app.hotkey_error.lock().unwrap() = None;
        } else {
            app.report_error(&fnkey::permission_error());
        }
    }
    if let Some(msg) = unsupported {
        *app.hotkey_error.lock().unwrap() = Some(msg.clone());
        app.report_error(&msg);
    }
    Ok(())
}

/// Registers `FALLBACK` unless `list` has it already, or a configured shortcut uses the same
/// combination (that one wins). Failing to get it is not an error: it is only a fallback.
fn add_fallback<R: tauri::Runtime>(gs: &tauri_plugin_global_shortcut::GlobalShortcut<R>, list: &mut Vec<(Shortcut, Action)>) {
    let fallback = parse(FALLBACK).expect("valid");
    if list.iter().any(|(s, _)| s.id() == fallback.id()) {
        return;
    }
    match gs.register(fallback) {
        Ok(()) => list.push((fallback, Action::Fallback)),
        Err(e) => log::warn!("fallback shortcut {FALLBACK} unavailable: {e}"),
    }
}

/// The single-key shortcut, if any, and its action.
fn single_key(all: &[(&String, Action)]) -> Result<Option<(fnkey::Key, Action)>> {
    let mut singles = all.iter().filter_map(|(k, a)| fnkey::Key::parse(k).map(|key| (key, *a)));
    let first = singles.next();
    if singles.next().is_some() {
        return Err(anyhow!("Only one shortcut can be a single key like Fn or Right Option"));
    }
    if matches!(first, Some((_, Action::PasteLast))) {
        return Err(anyhow!("Paste last needs a key combination, not a single key"));
    }
    Ok(first)
}

/// The shortcut recorder in Settings is open. Pressing a shortcut there must record it, not
/// trigger it, so they are unregistered (and single keys are captured, see `fnkey`) until
/// `resume`. They stay listed, so `resume` can put them back if the new ones can't be registered.
static SUSPENDED: AtomicBool = AtomicBool::new(false);

pub fn suspend(app: &Arc<App>) {
    if SUSPENDED.swap(true, Ordering::SeqCst) {
        return;
    }
    fnkey::set_recording(true);
    let list: Vec<Shortcut> = app.shortcuts.lock().unwrap().iter().filter(|(_, a)| *a != Action::Cancel).map(|(s, _)| *s).collect();
    let _ = app.handle.global_shortcut().unregister_multiple(list);
}

/// The recorder closed: registers the shortcuts as they are now saved. A no-op unless suspended,
/// so the window losing focus or the page reloading can call it to be safe.
pub fn resume(app: &Arc<App>) {
    if !SUSPENDED.swap(false, Ordering::SeqCst) {
        return;
    }
    fnkey::set_recording(false);
    if let Err(e) = register(app, false) {
        let msg = format!("{e:#}");
        *app.hotkey_error.lock().unwrap() = Some(msg.clone());
        app.report_error(&msg);
    }
}

/// Grabs Esc while recording. Runs on its own thread: (un)registering from inside a shortcut
/// callback deadlocks the X11 hotkey thread. It re-reads the recording state when it runs, so
/// out-of-order calls still converge to the right state.
/// Grabs Esc while recording. Runs on its own thread because (un)registering waits for the main
/// thread, which may be inside a shortcut callback. It re-reads the recording state when it runs,
/// so out-of-order calls still converge. The shortcut list lock is never held while registering
/// (the shortcut handler on the main thread needs it).
pub fn set_cancel_key(app: &Arc<App>, _on: bool) {
    static SERIAL: Mutex<()> = Mutex::new(());
    let app = app.clone();
    std::thread::spawn(move || {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let esc: Shortcut = "Escape".parse().expect("valid");
        let gs = app.handle.global_shortcut();
        let on = app.is_recording();
        let has = app.shortcuts.lock().unwrap().iter().any(|(_, a)| *a == Action::Cancel);
        if on && !has && gs.register(esc).is_ok() {
            app.shortcuts.lock().unwrap().push((esc, Action::Cancel));
        } else if !on && has {
            app.shortcuts.lock().unwrap().retain(|(_, a)| *a != Action::Cancel);
            let _ = gs.unregister(esc);
        }
    });
}

pub fn handle(handle: &tauri::AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    let Some(app) = handle.try_state::<Arc<App>>() else { return };
    let app = app.inner().clone();
    let action = app.shortcuts.lock().unwrap().iter().find(|(s, _)| s.id() == shortcut.id()).map(|(_, a)| *a);
    log::debug!("shortcut {shortcut} {:?} -> {action:?}", event.state());
    let Some(action) = action else { return };
    // Shortcut callbacks run on the event loop; never block it.
    match (action, event.state()) {
        (Action::Dictate, ShortcutState::Pressed) => app.on_press(Mode::Dictate),
        (Action::Command, ShortcutState::Pressed) => app.on_press(Mode::Command),
        (Action::Dictate | Action::Command, ShortcutState::Released) => app.on_release(),
        (Action::Cancel, ShortcutState::Pressed) => app.cancel(),
        (Action::Fallback, ShortcutState::Pressed) => app.toggle(Mode::Dictate),
        (Action::PasteLast, ShortcutState::Pressed) => {
            tauri::async_runtime::spawn(async move {
                if let Err(e) = app.paste_last().await {
                    app.report_error(&format!("{e:#}"));
                }
            });
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fnkey::Key;

    fn bind(dictate: &str, command: &str, paste_last: &str) -> Result<Option<(Key, Action)>> {
        let (d, c, p) = (dictate.to_string(), command.to_string(), paste_last.to_string());
        single_key(&[(&d, Action::Dictate), (&c, Action::Command), (&p, Action::PasteLast)])
    }

    #[test]
    fn single_key_binding() {
        assert_eq!(bind("Ctrl+Shift+Space", "Ctrl+Alt+Space", "Ctrl+Alt+V").unwrap(), None);
        assert!(bind("Fn", "Fn", "Ctrl+Alt+V").is_err(), "Fn bound twice");
        assert!(bind("Fn", "RightOption", "Ctrl+Alt+V").is_err(), "two single-key shortcuts");
        assert!(bind("Ctrl+Shift+Space", "Ctrl+Alt+Space", "Fn").is_err(), "paste last can't be a single key");
        // Off macOS, `register` skips them.
        assert_eq!(bind("Fn", "Ctrl+Alt+Space", "Ctrl+Alt+V").unwrap(), Some((Key::Fn, Action::Dictate)));
        assert_eq!(bind("Ctrl+Shift+Space", "RightOption", "Ctrl+Alt+V").unwrap(), Some((Key::RightOption, Action::Command)));
        // Single keys are never parsed as regular global shortcuts.
        for k in ["Fn", "RightCommand", "RightOption", "RightControl", "RightShift"] {
            assert!(parse(k).is_err(), "{k}");
        }
    }
}
