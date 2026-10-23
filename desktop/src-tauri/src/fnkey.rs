//! Single keys as dictation shortcuts on macOS: Fn (🌐), Right ⌘, Right ⌥, Right ⌃ or Right ⇧.
//!
//! The global-shortcut plugin can't do this: it registers Carbon hot keys, which need a regular
//! key, and macOS reports these keys only as modifier (flags-changed) events. So they are watched
//! with a listen-only Quartz event tap, which sees keys whichever app is focused (OpsTrellis
//! included). Creating the tap needs the Input Monitoring permission. The same tap lets the
//! shortcut recorder in Settings capture such a key, which the webview never sees.
//!
//! Hold the key to talk; release to finish. Double-tap for hands-free; the next press finishes.
//! Recording starts on the first press, so nothing is lost while a tap is told apart from a hold. A
//! single tap is discarded, and so is the key used with another key (Fn+Delete, ⌥+letter).
//!
//! macOS also runs its own 🌐 action (emoji picker, input source, Apple Dictation) on every Fn
//! press, from the WindowServer ahead of any event tap, so it can't be swallowed. While Fn is a
//! shortcut, `globe` sets that action to "Do Nothing" and puts the user's choice back afterwards.

// Only the macOS event tap feeds key events in; elsewhere just the logic is built (tests).
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use crate::pipeline::Mode;
use crate::App;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;

/// A press at least this long is a hold (push-to-talk); a shorter one is a tap.
const HOLD: Duration = Duration::from_millis(300);
/// After a tap, how long the second tap of a double-tap may take to start.
const DOUBLE_TAP: Duration = Duration::from_millis(400);

/// A key that can be a shortcut on its own. Stored in settings by `name()`.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Key {
    Fn,
    RightCommand,
    RightOption,
    RightControl,
    RightShift,
}

// Modifier flags (CGEventFlags): the generic one for each key, and the device-specific bit that
// tells the right-hand key from the left.
const SHIFT: u64 = 0x0002_0000;
const CONTROL: u64 = 0x0004_0000;
const OPTION: u64 = 0x0008_0000;
const COMMAND: u64 = 0x0010_0000;
const SECONDARY_FN: u64 = 0x0080_0000;
const MODIFIERS: u64 = SHIFT | CONTROL | OPTION | COMMAND | SECONDARY_FN;

impl Key {
    const ALL: [Key; 5] = [Key::Fn, Key::RightCommand, Key::RightOption, Key::RightControl, Key::RightShift];

    pub fn name(self) -> &'static str {
        match self {
            Key::Fn => "Fn",
            Key::RightCommand => "RightCommand",
            Key::RightOption => "RightOption",
            Key::RightControl => "RightControl",
            Key::RightShift => "RightShift",
        }
    }

    pub fn parse(s: &str) -> Option<Key> {
        Key::ALL.into_iter().find(|k| k.name() == s)
    }

    /// macOS virtual key code (kVK_Function, kVK_RightCommand, …).
    fn code(self) -> i64 {
        match self {
            Key::Fn => 63,
            Key::RightCommand => 54,
            Key::RightOption => 61,
            Key::RightControl => 62,
            Key::RightShift => 60,
        }
    }

    fn from_code(code: i64) -> Option<Key> {
        Key::ALL.into_iter().find(|k| k.code() == code)
    }

    /// The flag bit that is set while this very key is down.
    fn down_flag(self) -> u64 {
        match self {
            Key::Fn => SECONDARY_FN,
            Key::RightCommand => 0x10,
            Key::RightOption => 0x40,
            Key::RightControl => 0x2000,
            Key::RightShift => 0x04,
        }
    }

    /// The device bit of the same modifier on the left-hand side (none for Fn).
    fn left_flag(self) -> u64 {
        match self {
            Key::Fn => 0,
            Key::RightCommand => 0x08,
            Key::RightOption => 0x20,
            Key::RightControl => 0x01,
            Key::RightShift => 0x02,
        }
    }

    fn generic_flag(self) -> u64 {
        match self {
            Key::Fn => SECONDARY_FN,
            Key::RightCommand => COMMAND,
            Key::RightOption => OPTION,
            Key::RightControl => CONTROL,
            Key::RightShift => SHIFT,
        }
    }
}

/// What the tap saw: a modifier key changed (`key` when it is one of ours; `alone` when no other
/// modifier is held), or another key or a mouse button went down.
#[derive(Clone, Copy, PartialEq, Debug)]
enum TapEvent {
    Modifier { key: Option<Key>, down: bool, alone: bool },
    KeyDown,
}

impl TapEvent {
    fn from_flags(code: i64, flags: u64) -> TapEvent {
        match Key::from_code(code) {
            Some(k) => TapEvent::Modifier {
                key: Some(k),
                down: flags & k.down_flag() != 0,
                alone: flags & MODIFIERS & !k.generic_flag() == 0 && flags & k.left_flag() == 0,
            },
            None => TapEvent::Modifier { key: None, down: flags & MODIFIERS != 0, alone: false },
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Event {
    Down,
    Up,
    /// Another key was pressed.
    OtherKey,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Action {
    None,
    Start,
    /// Finish the recording and insert the text.
    Stop,
    /// Discard the recording.
    Cancel,
    HandsFree,
    /// A tap: call `expire` with this instant after `DOUBLE_TAP` unless a second tap comes first.
    AwaitSecondTap(Instant),
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum State {
    Idle,
    /// The key is down since this instant, recording.
    Held(Instant),
    /// The key was tapped (released at this instant); still recording until we know if a second tap follows.
    Tapped(Instant),
    /// Recording without holding the key; `down` while the second tap of the double-tap is still held.
    HandsFree { down: bool },
    /// The key is down but does nothing until released (it stopped a recording, or was used with another key).
    Ignore,
}

/// Tells holds, taps and double-taps apart. Pure, so it can be tested without a keyboard.
#[derive(Debug)]
struct Machine {
    state: State,
}

impl Machine {
    const fn new() -> Self {
        Machine { state: State::Idle }
    }

    /// `recording`: whether a dictation is in progress right now.
    fn on_event(&mut self, ev: Event, now: Instant, recording: bool) -> Action {
        use State::*;
        // The recording ended some other way (Esc, the tray, a microphone error) or never started
        // (still processing the last one): wait for the key to be up, then start over.
        if !recording {
            self.state = match self.state {
                Held(_) | HandsFree { down: true } => Ignore,
                Tapped(_) | HandsFree { down: false } => Idle,
                s => s,
            };
        }
        let (state, action) = match (self.state, ev) {
            // Hands-free started elsewhere (tray, CLI): the key finishes it.
            (Idle, Event::Down) if recording => (Ignore, Action::Stop),
            (Idle, Event::Down) => (Held(now), Action::Start),
            (Held(at), Event::Up) if now.duration_since(at) >= HOLD => (Idle, Action::Stop),
            (Held(_), Event::Up) => (Tapped(now), Action::AwaitSecondTap(now)),
            (Held(_), Event::OtherKey) => (Ignore, Action::Cancel),
            (Tapped(_), Event::OtherKey) => (Idle, Action::Cancel),
            (Tapped(_), Event::Down) => (HandsFree { down: true }, Action::HandsFree),
            (HandsFree { down: true }, Event::Up) => (HandsFree { down: false }, Action::None),
            (HandsFree { down: false }, Event::Down) => (Ignore, Action::Stop),
            (Ignore, Event::Up) => (Idle, Action::None),
            // Repeated or out-of-order events (a missed Up, typing while hands-free): no change.
            (s, _) => (s, Action::None),
        };
        self.state = state;
        action
    }

    /// The double-tap window after the tap at `tapped_at` is over: it was a single tap.
    fn expire(&mut self, tapped_at: Instant) -> Action {
        if self.state == State::Tapped(tapped_at) {
            self.state = State::Idle;
            return Action::Cancel;
        }
        Action::None
    }
}

/// The shortcut recorder in Settings: a key pressed and released on its own is the new shortcut.
#[derive(Debug, Default)]
struct Capture(Option<Key>);

impl Capture {
    fn on(&mut self, ev: TapEvent) -> Option<Key> {
        match ev {
            TapEvent::Modifier { key: Some(k), down: true, alone: true } => {
                self.0 = Some(k);
                None
            }
            TapEvent::Modifier { key: Some(k), down: false, .. } if self.0 == Some(k) => self.0.take(),
            // Anything else in between (another key, another modifier) makes it a combination.
            _ => {
                self.0 = None;
                None
            }
        }
    }
}

/// The single-key shortcut and what it starts (None: no single-key shortcut), and its state.
static BINDING: Mutex<Option<(Key, Mode)>> = Mutex::new(None);
static MACHINE: Mutex<Machine> = Mutex::new(Machine::new());
static RECORDING: AtomicBool = AtomicBool::new(false);
static CAPTURE: Mutex<Capture> = Mutex::new(Capture(None));
static APP: std::sync::OnceLock<Arc<App>> = std::sync::OnceLock::new();

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn permission_error() -> String {
    "Single-key shortcuts like Fn need Input Monitoring permission: open OpsTrellis Settings → Permissions and \
     click Grant access (reopen OpsTrellis if the key still doesn't respond after allowing it)."
        .into()
}

/// At startup, before the shortcuts are registered: puts back a 🌐 setting a crashed run left
/// changed. `data_dir` keeps the backup of the user's own setting.
pub fn init(app: &Arc<App>, data_dir: &std::path::Path) {
    let _ = APP.set(app.clone());
    globe::recover(data_dir.join("globe-key-backup.json"));
}

/// Makes `binding` the single-key shortcut (or none). Returns false while the Input Monitoring
/// permission is missing; the key starts working on its own once it is granted.
pub fn set(app: &Arc<App>, binding: Option<(Key, Mode)>) -> bool {
    let _ = APP.set(app.clone());
    *lock(&BINDING) = binding;
    *lock(&MACHINE) = Machine::new();
    let fn_bound = matches!(binding, Some((Key::Fn, _)));
    on_main_thread(app, move || if fn_bound { globe::hold() } else { globe::release() });
    binding.is_none() || (tap::start(true) && permission_granted())
}

/// Whether Fn itself is the single-key shortcut.
pub fn fn_bound() -> bool {
    matches!(*lock(&BINDING), Some((Key::Fn, _)))
}

/// Whether a single-key shortcut is set and works in every app (None: none set).
pub fn active() -> Option<bool> {
    lock(&BINDING).map(|_| tap::running() && permission_granted())
}

/// While the shortcut recorder is open: single-key shortcuts don't dictate, and a key pressed on
/// its own is reported as `shortcut-captured`. The tap is started without asking for permission.
/// Pressing 🌐 there would also open the emoji picker and take focus from the recorder, so its
/// action is held at "Do Nothing" until the shortcuts are registered again (which settles it).
pub fn set_recording(on: bool) {
    *lock(&CAPTURE) = Capture::default();
    RECORDING.store(on, Ordering::SeqCst);
    let Some(app) = APP.get() else { return };
    if on && cfg!(target_os = "macos") {
        tap::start(false);
        on_main_thread(app, globe::hold);
    } else if !on && !fn_bound() {
        // Registering the shortcuts again settles it too, but may fail before getting there.
        on_main_thread(app, globe::release);
    }
}

/// Puts the user's 🌐 setting back (on quit).
pub fn release_system_action() {
    globe::release();
}

/// Whether macOS grants Input Monitoring to this build. A running tap doesn't prove it: with a
/// grant left over from an earlier (differently signed) build the tap starts but only sees keys
/// while OpsTrellis is frontmost, and Accessibility being trusted doesn't change that.
pub fn permission_granted() -> bool {
    tap::preflight()
}

/// Called from the event tap thread, in event order.
fn on_tap_event(ev: TapEvent) {
    let Some(app) = APP.get() else { return };
    if RECORDING.load(Ordering::SeqCst) {
        if let Some(k) = lock(&CAPTURE).on(ev) {
            let _ = app.handle.emit("shortcut-captured", k.name());
        }
        return;
    }
    let Some((key, mode)) = *lock(&BINDING) else { return };
    let ev = match ev {
        TapEvent::Modifier { key: Some(k), down, .. } if k == key => if down { Event::Down } else { Event::Up },
        // Other modifiers (Shift while holding the key) are fine.
        TapEvent::Modifier { .. } => return,
        TapEvent::KeyDown => Event::OtherKey,
    };
    // Held while acting, so a double-tap timeout and a key event can't interleave.
    let mut m = lock(&MACHINE);
    let action = m.on_event(ev, Instant::now(), app.is_recording());
    // Not every key and click typed in other apps: that would log the user's typing rhythm.
    if !(ev == Event::OtherKey && action == Action::None) {
        log::debug!("{} {ev:?} -> {action:?}", key.name());
    }
    apply(app, mode, action);
}

fn apply(app: &Arc<App>, mode: Mode, action: Action) {
    match action {
        Action::None => {}
        Action::Start => app.on_press(mode),
        Action::Stop => app.stop(),
        Action::Cancel => app.cancel(),
        Action::HandsFree => app.set_hands_free(),
        Action::AwaitSecondTap(at) => {
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(DOUBLE_TAP);
                let mut m = lock(&MACHINE);
                let action = m.expire(at);
                apply(&app, mode, action);
            });
        }
    }
}

/// Called once the tap runs after the permission was missing.
fn on_tap_running() {
    if let Some(app) = APP.get() {
        let mut err = lock(&app.hotkey_error);
        if err.as_deref() == Some(permission_error().as_str()) {
            *err = None;
        }
    }
    log::info!("single-key shortcuts: listening");
}

/// Asks for Input Monitoring: the system prompt the first time, System Settings after that.
pub fn request_permission() {
    tap::request_permission();
}

/// macOS's own action for the 🌐/Fn key (System Settings → Keyboard → "Press 🌐 key to"), unless
/// it is "Do Nothing". It runs on every Fn press too and can switch the input source or take
/// focus away from the app being dictated into (emoji picker, Apple Dictation). Normally `globe`
/// has set it to "Do Nothing"; this is for when that wasn't possible.
pub fn system_action() -> Option<&'static str> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let out = std::process::Command::new("defaults").args(["read", "com.apple.HIToolbox", "AppleFnUsageType"]).output().ok()?;
    match String::from_utf8_lossy(&out.stdout).trim() {
        "0" => None,
        "1" => Some("changes the input source"),
        "2" => Some("shows Emoji & Symbols"),
        "3" => Some("starts Apple Dictation"),
        // Not set: the system default, which depends on the Mac but isn't "Do Nothing".
        _ => Some("switches the input source or shows Emoji & Symbols"),
    }
}

/// HIToolbox's 🌐 functions must run on the main thread.
fn on_main_thread(app: &Arc<App>, f: impl FnOnce() + Send + 'static) {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn pthread_main_np() -> i32;
        }
        if unsafe { pthread_main_np() } == 0 {
            let _ = app.handle.run_on_main_thread(f);
            return;
        }
    }
    let _ = app;
    f();
}

/// Holds "Press 🌐 key to" at "Do Nothing" while Fn is a shortcut, and puts the user's setting
/// back afterwards (on switching away from Fn, on quit, or at the next launch after a crash).
///
/// Writing the preference directly only applies at the next login, so this uses
/// TISUpdateFnUsageType, the private HIToolbox call System Settings itself makes; it is looked up
/// at runtime, so a macOS without it only loses this (the Permissions page then shows the warning).
#[cfg(target_os = "macos")]
mod globe {
    use std::ffi::{c_char, c_int, c_void, CStr};
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};

    const DO_NOTHING: i32 = 0;

    #[derive(serde::Serialize, serde::Deserialize, Clone, Copy)]
    struct Backup {
        original: i32,
        /// Whether the preference was set at all; if not, it is removed again so macOS keeps
        /// choosing the default for the keyboard.
        existed: bool,
    }

    /// Our change and how to undo it, while it is in effect.
    static OWNED: Mutex<Option<Backup>> = Mutex::new(None);
    static BACKUP_FILE: OnceLock<PathBuf> = OnceLock::new();

    type Get = unsafe extern "C" fn() -> i32;
    type Update = unsafe extern "C" fn(i32);

    extern "C" {
        fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    }

    fn functions() -> Option<(Get, Update)> {
        static F: OnceLock<Option<(Get, Update)>> = OnceLock::new();
        *F.get_or_init(|| unsafe {
            const RTLD_LAZY: c_int = 1;
            let carbon = dlopen(c"/System/Library/Frameworks/Carbon.framework/Carbon".as_ptr(), RTLD_LAZY);
            if carbon.is_null() {
                return None;
            }
            let sym = |name: &CStr| dlsym(carbon, name.as_ptr());
            let (get, update) = (sym(c"TISGetFnUsageType"), sym(c"TISUpdateFnUsageType"));
            if get.is_null() || update.is_null() {
                log::warn!("TISUpdateFnUsageType not found; the 🌐 key's own action stays on");
                return None;
            }
            Some((std::mem::transmute::<*mut c_void, Get>(get), std::mem::transmute::<*mut c_void, Update>(update)))
        })
    }

    fn lock() -> std::sync::MutexGuard<'static, Option<Backup>> {
        OWNED.lock().unwrap_or_else(|e| e.into_inner())
    }

    type Ref = *const c_void;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFPreferencesCurrentUser: Ref;
        static kCFPreferencesAnyHost: Ref;
        fn CFStringCreateWithCString(allocator: Ref, s: *const c_char, encoding: u32) -> Ref;
        fn CFPreferencesCopyValue(key: Ref, app: Ref, user: Ref, host: Ref) -> Ref;
        fn CFPreferencesSetValue(key: Ref, value: Ref, app: Ref, user: Ref, host: Ref);
        fn CFPreferencesSynchronize(app: Ref, user: Ref, host: Ref) -> u8;
        fn CFRelease(cf: Ref);
    }

    /// Runs `f` with the preference's key and domain (in-process, so it is ordered with the
    /// HIToolbox calls, unlike running `defaults`).
    fn with_preference<T>(f: impl FnOnce(Ref, Ref) -> T) -> T {
        const UTF8: u32 = 0x0800_0100;
        unsafe {
            let key = CFStringCreateWithCString(std::ptr::null(), c"AppleFnUsageType".as_ptr(), UTF8);
            let domain = CFStringCreateWithCString(std::ptr::null(), c"com.apple.HIToolbox".as_ptr(), UTF8);
            let out = f(key, domain);
            CFRelease(key);
            CFRelease(domain);
            out
        }
    }

    fn preference_exists() -> bool {
        with_preference(|key, domain| unsafe {
            // Re-read: values from other apps' domains are cached for the life of the process.
            CFPreferencesSynchronize(domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost);
            let value = CFPreferencesCopyValue(key, domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost);
            if value.is_null() {
                return false;
            }
            CFRelease(value);
            true
        })
    }

    fn remove_preference() {
        with_preference(|key, domain| unsafe {
            CFPreferencesSetValue(key, std::ptr::null(), domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost);
            CFPreferencesSynchronize(domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost);
        })
    }

    /// Adopts the backup a crashed run left, unless the user picked a new 🌐 action since.
    pub fn recover(file: PathBuf) {
        let _ = BACKUP_FILE.set(file.clone());
        let Ok(text) = std::fs::read_to_string(&file) else { return };
        let Ok(backup) = serde_json::from_str::<Backup>(&text) else {
            let _ = std::fs::remove_file(&file);
            return;
        };
        // Kept for a later run that can restore it.
        let Some((get, _)) = functions() else { return };
        if unsafe { get() } == DO_NOTHING {
            *lock() = Some(backup);
        } else {
            let _ = std::fs::remove_file(&file);
        }
    }

    pub fn hold() {
        let mut owned = lock();
        let Some((get, update)) = functions() else { return };
        if owned.is_some() {
            return;
        }
        let original = unsafe { get() };
        if original == DO_NOTHING {
            return;
        }
        let backup = Backup { original, existed: preference_exists() };
        // Record how to get back before changing anything.
        let Some(file) = BACKUP_FILE.get() else { return };
        if let Err(e) = serde_json::to_string(&backup).map_err(std::io::Error::other).and_then(|s| std::fs::write(file, s)) {
            log::warn!("not changing the 🌐 key action, can't save a backup: {e}");
            return;
        }
        unsafe { update(DO_NOTHING) };
        *owned = Some(backup);
        log::info!("🌐 key action set to Do Nothing while Fn is a shortcut (was {original})");
    }

    pub fn release() {
        let mut owned = lock();
        let (Some(backup), Some((get, update))) = (owned.take(), functions()) else { return };
        // Only while it is still ours: if the user picked an action meanwhile, theirs wins.
        if unsafe { get() } == DO_NOTHING {
            unsafe { update(backup.original) };
            if !backup.existed {
                remove_preference();
            }
            log::info!("🌐 key action restored ({})", backup.original);
        }
        if let Some(file) = BACKUP_FILE.get() {
            let _ = std::fs::remove_file(file);
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod globe {
    pub fn recover(_file: std::path::PathBuf) {}
    pub fn hold() {}
    pub fn release() {}
}

#[cfg(target_os = "macos")]
mod tap {
    use super::TapEvent;
    use std::ffi::c_void;
    use std::ptr::null_mut;
    use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};
    use std::time::Duration;

    type Ref = *mut c_void;
    type Callback = extern "C" fn(Ref, u32, Ref, Ref) -> Ref;

    const SESSION_EVENT_TAP: u32 = 1;
    const HEAD_INSERT_EVENT_TAP: u32 = 0;
    const LISTEN_ONLY: u32 = 1;
    const LEFT_MOUSE_DOWN: u32 = 1;
    const RIGHT_MOUSE_DOWN: u32 = 3;
    const KEY_DOWN: u32 = 10;
    const FLAGS_CHANGED: u32 = 12;
    const OTHER_MOUSE_DOWN: u32 = 25;
    const DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
    const DISABLED_BY_USER_INPUT: u32 = 0xFFFF_FFFF;
    const KEYCODE_FIELD: u32 = 9;
    const HID_SYSTEM_STATE: i32 = 1;
    /// The 🌐 key also sends a key press of its own as it is released; it is the Fn key itself,
    /// not another key, so it must not cancel a tap.
    const GLOBE_KEYCODE: i64 = 179;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventTapCreate(tap: u32, place: u32, options: u32, mask: u64, callback: Callback, info: Ref) -> Ref;
        fn CGEventTapEnable(tap: Ref, enable: bool);
        fn CGEventGetFlags(event: Ref) -> u64;
        fn CGEventGetIntegerValueField(event: Ref, field: u32) -> i64;
        fn CGRequestListenEventAccess() -> bool;
        fn CGPreflightListenEventAccess() -> bool;
        fn CGEventSourceFlagsState(state: i32) -> u64;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFRunLoopCommonModes: Ref;
        fn CFMachPortCreateRunLoopSource(allocator: Ref, port: Ref, order: isize) -> Ref;
        fn CFRunLoopGetCurrent() -> Ref;
        fn CFRunLoopAddSource(rl: Ref, source: Ref, mode: Ref);
        fn CFRunLoopRemoveSource(rl: Ref, source: Ref, mode: Ref);
        fn CFRunLoopRun();
        fn CFRelease(cf: *const c_void);
    }

    #[link(name = "objc")]
    extern "C" {
        fn objc_autoreleasePoolPush() -> Ref;
        fn objc_autoreleasePoolPop(pool: Ref);
    }

    static STARTED: AtomicBool = AtomicBool::new(false);
    static PORT: AtomicPtr<c_void> = AtomicPtr::new(null_mut());

    pub fn running() -> bool {
        !PORT.load(Ordering::SeqCst).is_null()
    }

    pub fn preflight() -> bool {
        unsafe { CGPreflightListenEventAccess() }
    }

    fn create() -> Ref {
        // Clicks count as using the key with something else (⇧-click, ⌘-click with a right-hand
        // modifier as the shortcut), so they cancel. Media and brightness keys (system-defined
        // events) are left out: that type also reports clicks, so it would cancel twice.
        let mask = 1 << KEY_DOWN | 1 << FLAGS_CHANGED | 1 << LEFT_MOUSE_DOWN | 1 << RIGHT_MOUSE_DOWN | 1 << OTHER_MOUSE_DOWN;
        // Null when Input Monitoring isn't granted.
        unsafe { CGEventTapCreate(SESSION_EVENT_TAP, HEAD_INSERT_EVENT_TAP, LISTEN_ONLY, mask, callback, null_mut()) }
    }

    /// Starts the tap on its own thread (once). Without permission it shows the system prompt
    /// (only ever once, and only if `prompt`) and retries every second, so the key works as soon
    /// as it is granted.
    pub fn start(prompt: bool) -> bool {
        static PROMPTED: AtomicBool = AtomicBool::new(false);
        let ask = || {
            if prompt && !PROMPTED.swap(true, Ordering::SeqCst) {
                unsafe { CGRequestListenEventAccess() };
            }
        };
        if STARTED.swap(true, Ordering::SeqCst) {
            // Started without asking (by the shortcut recorder): ask now that a key is chosen.
            if !running() {
                ask();
            }
            return running();
        }
        let port = create();
        let ok = !port.is_null();
        log::info!("key tap {}; Input Monitoring granted: {}", if ok { "created" } else { "not created yet" }, preflight());
        if !ok {
            ask();
        }
        struct Port(Ref);
        unsafe impl Send for Port {}
        let first = Port(port);
        std::thread::Builder::new()
            .name("key-tap".into())
            .spawn(move || {
                let mut port = first;
                loop {
                    let waited = port.0.is_null();
                    while port.0.is_null() {
                        std::thread::sleep(Duration::from_secs(1));
                        port.0 = create();
                    }
                    PORT.store(port.0, Ordering::SeqCst);
                    if waited {
                        super::on_tap_running();
                    }
                    unsafe {
                        let source = CFMachPortCreateRunLoopSource(null_mut(), port.0, 0);
                        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
                        CGEventTapEnable(port.0, true);
                        // Returns only if the tap stopped for good (e.g. its port was invalidated).
                        CFRunLoopRun();
                        PORT.store(null_mut(), Ordering::SeqCst);
                        CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
                        CFRelease(source.cast_const());
                        CFRelease(port.0.cast_const());
                    }
                    log::warn!("key tap stopped, recreating it");
                    port.0 = null_mut();
                }
            })
            .is_ok()
            && ok
    }

    pub fn request_permission() {
        // Prompts only the first time; after that the user has to flip the switch in System Settings.
        if !unsafe { CGRequestListenEventAccess() } {
            let _ = std::process::Command::new("open")
                .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
                .spawn();
        }
    }

    extern "C" fn callback(_proxy: Ref, kind: u32, event: Ref, _info: Ref) -> Ref {
        let ev = match kind {
            // macOS switches a tap off if it is slow or on some secure input; switch it back on.
            DISABLED_BY_TIMEOUT | DISABLED_BY_USER_INPUT => {
                unsafe { CGEventTapEnable(PORT.load(Ordering::SeqCst), true) };
                let why = if kind == DISABLED_BY_TIMEOUT { "timeout" } else { "user input" };
                log::warn!("key tap was disabled ({why}), re-enabled");
                // A release may have been missed meanwhile; don't stay stuck "held".
                let Some((key, _)) = *super::lock(&super::BINDING) else { return event };
                if unsafe { CGEventSourceFlagsState(HID_SYSTEM_STATE) } & key.down_flag() != 0 {
                    return event;
                }
                TapEvent::Modifier { key: Some(key), down: false, alone: true }
            }
            FLAGS_CHANGED => unsafe {
                TapEvent::from_flags(CGEventGetIntegerValueField(event, KEYCODE_FIELD), CGEventGetFlags(event))
            },
            KEY_DOWN if unsafe { CGEventGetIntegerValueField(event, KEYCODE_FIELD) } == GLOBE_KEYCODE => return event,
            KEY_DOWN | LEFT_MOUSE_DOWN | RIGHT_MOUSE_DOWN | OTHER_MOUSE_DOWN => TapEvent::KeyDown,
            _ => return event,
        };
        // This thread never returns to a run loop that drains autoreleased objects (the frontmost
        // window lookup on each press makes some), so drain them per event.
        let pool = unsafe { objc_autoreleasePoolPush() };
        // A panic must not unwind into Quartz.
        if std::panic::catch_unwind(|| super::on_tap_event(ev)).is_err() {
            log::error!("key tap handler panicked");
        }
        unsafe { objc_autoreleasePoolPop(pool) };
        event
    }
}

#[cfg(not(target_os = "macos"))]
mod tap {
    pub fn start(_prompt: bool) -> bool {
        false
    }
    pub fn running() -> bool {
        false
    }
    pub fn preflight() -> bool {
        false
    }
    pub fn request_permission() {}
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Sim {
        m: Machine,
        t0: Instant,
        recording: bool,
    }

    impl Sim {
        fn new() -> Self {
            Sim { m: Machine::new(), t0: Instant::now(), recording: false }
        }
        /// Feeds an event at `ms` and keeps `recording` in step like the app would.
        fn ev(&mut self, ev: Event, ms: u64) -> Action {
            let a = self.m.on_event(ev, self.t0 + Duration::from_millis(ms), self.recording);
            match a {
                Action::Start => self.recording = true,
                Action::Stop | Action::Cancel => self.recording = false,
                _ => {}
            }
            a
        }
        fn expire(&mut self, tapped_ms: u64) -> Action {
            let a = self.m.expire(self.t0 + Duration::from_millis(tapped_ms));
            if a == Action::Cancel {
                self.recording = false;
            }
            a
        }
    }

    fn at(s: &Sim, ms: u64) -> Instant {
        s.t0 + Duration::from_millis(ms)
    }

    #[test]
    fn hold_is_push_to_talk() {
        let mut s = Sim::new();
        assert_eq!(s.ev(Event::Down, 0), Action::Start);
        assert_eq!(s.ev(Event::Down, 100), Action::None, "repeated down is ignored");
        assert_eq!(s.ev(Event::Up, 2000), Action::Stop);
        assert!(!s.recording);
        // Released exactly at the threshold still counts as a hold.
        assert_eq!(s.ev(Event::Down, 3000), Action::Start);
        assert_eq!(s.ev(Event::Up, 3000 + HOLD.as_millis() as u64), Action::Stop);
    }

    #[test]
    fn single_tap_is_discarded() {
        let mut s = Sim::new();
        assert_eq!(s.ev(Event::Down, 0), Action::Start);
        assert_eq!(s.ev(Event::Up, 120), Action::AwaitSecondTap(at(&s, 120)));
        assert!(s.recording, "keeps recording while waiting for a second tap");
        assert_eq!(s.expire(120), Action::Cancel);
        // A later press is a fresh start, not a hands-free stop.
        assert_eq!(s.ev(Event::Down, 2000), Action::Start);
    }

    #[test]
    fn double_tap_is_hands_free_until_next_press() {
        let mut s = Sim::new();
        assert_eq!(s.ev(Event::Down, 0), Action::Start);
        assert_eq!(s.ev(Event::Up, 100), Action::AwaitSecondTap(at(&s, 100)));
        assert_eq!(s.ev(Event::Down, 250), Action::HandsFree);
        // The second tap's release, however long it was held, doesn't stop anything.
        assert_eq!(s.ev(Event::Up, 1500), Action::None);
        // The stale double-tap timer must not cancel the hands-free recording.
        assert_eq!(s.expire(100), Action::None);
        assert_eq!(s.ev(Event::OtherKey, 3000), Action::None, "typing while hands-free is fine");
        assert!(s.recording);
        assert_eq!(s.ev(Event::Down, 9000), Action::Stop);
        // Releasing that press doesn't start a new recording.
        assert_eq!(s.ev(Event::Up, 9100), Action::None);
        assert!(!s.recording);
        assert_eq!(s.ev(Event::Down, 10000), Action::Start);
    }

    #[test]
    fn fn_with_another_key_cancels() {
        let mut s = Sim::new();
        assert_eq!(s.ev(Event::Down, 0), Action::Start);
        assert_eq!(s.ev(Event::OtherKey, 500), Action::Cancel);
        assert_eq!(s.ev(Event::OtherKey, 600), Action::None);
        assert_eq!(s.ev(Event::Up, 2000), Action::None, "the rest of the chord does nothing");
        // Tap, then typing straight away: the tap is discarded too.
        assert_eq!(s.ev(Event::Down, 3000), Action::Start);
        assert_eq!(s.ev(Event::Up, 3100), Action::AwaitSecondTap(at(&s, 3100)));
        assert_eq!(s.ev(Event::OtherKey, 3200), Action::Cancel);
        assert_eq!(s.expire(3100), Action::None);
        assert_eq!(s.ev(Event::Down, 3300), Action::Start, "not mistaken for a double-tap");
    }

    #[test]
    fn rapid_taps_cycle_predictably() {
        // Tap, tap = hands-free; the next tap finishes. Nine quick taps are three dictations.
        let mut s = Sim::new();
        let mut stops = 0;
        for i in 0..9 {
            let ms = i * 60;
            if s.ev(Event::Down, ms) == Action::Stop {
                stops += 1;
            }
            s.ev(Event::Up, ms + 30);
        }
        assert_eq!(stops, 3);
        assert!(!s.recording);
        assert_eq!(s.ev(Event::Down, 2000), Action::Start);
        assert_eq!(s.ev(Event::Up, 4000), Action::Stop);
    }

    #[test]
    fn recording_ended_elsewhere_resyncs() {
        let mut s = Sim::new();
        // Hands-free, then Esc cancels it outside the machine.
        s.ev(Event::Down, 0);
        s.ev(Event::Up, 100);
        s.ev(Event::Down, 200);
        s.ev(Event::Up, 300);
        s.recording = false;
        assert_eq!(s.ev(Event::Down, 5000), Action::Start, "next press starts, not stops");
        // Held, but the recording failed to start (or was cancelled while held).
        s.recording = false;
        assert_eq!(s.ev(Event::Up, 7000), Action::None);
        assert_eq!(s.ev(Event::Down, 8000), Action::Start);
    }

    #[test]
    fn press_while_busy_waits_for_release() {
        let mut s = Sim::new();
        // Start is ignored by the app while it processes the previous dictation.
        assert_eq!(s.m.on_event(Event::Down, at(&s, 0), false), Action::Start);
        assert_eq!(s.m.on_event(Event::Up, at(&s, 2000), false), Action::None);
        assert_eq!(s.m.on_event(Event::Down, at(&s, 3000), false), Action::Start);
    }

    #[test]
    fn fn_stops_hands_free_started_elsewhere() {
        let mut s = Sim::new();
        s.recording = true; // tray / CLI toggle
        assert_eq!(s.ev(Event::Down, 0), Action::Stop);
        assert_eq!(s.ev(Event::Up, 100), Action::None);
        assert_eq!(s.ev(Event::Down, 1000), Action::Start);
    }

    #[test]
    fn key_names_round_trip() {
        for k in Key::ALL {
            assert_eq!(Key::parse(k.name()), Some(k));
            assert_eq!(Key::from_code(k.code()), Some(k));
        }
        assert_eq!(Key::parse("Ctrl+Space"), None);
        assert_eq!(Key::from_code(58), None, "left Option is not a single-key shortcut");
    }

    #[test]
    fn flags_tell_right_from_left_and_alone_from_combined() {
        // Right Option down on its own.
        assert_eq!(
            TapEvent::from_flags(61, OPTION | 0x40),
            TapEvent::Modifier { key: Some(Key::RightOption), down: true, alone: true }
        );
        // Right Option released while left Option is still held: the generic flag stays set, but
        // the right-hand bit tells it is up.
        assert_eq!(
            TapEvent::from_flags(61, OPTION | 0x20),
            TapEvent::Modifier { key: Some(Key::RightOption), down: false, alone: false }
        );
        // Right Command pressed while Shift is held: a combination, not the key alone.
        assert_eq!(
            TapEvent::from_flags(54, COMMAND | 0x10 | SHIFT | 0x02),
            TapEvent::Modifier { key: Some(Key::RightCommand), down: true, alone: false }
        );
        assert_eq!(TapEvent::from_flags(63, SECONDARY_FN), TapEvent::Modifier { key: Some(Key::Fn), down: true, alone: true });
        assert_eq!(TapEvent::from_flags(63, 0), TapEvent::Modifier { key: Some(Key::Fn), down: false, alone: true });
        // Right Option pressed while left Option is already held: not on its own.
        assert_eq!(
            TapEvent::from_flags(61, OPTION | 0x20 | 0x40),
            TapEvent::Modifier { key: Some(Key::RightOption), down: true, alone: false }
        );
        // Caps Lock and left-hand modifiers aren't ours.
        assert!(matches!(TapEvent::from_flags(58, OPTION | 0x20), TapEvent::Modifier { key: None, .. }));
    }

    #[test]
    fn recorder_captures_a_key_pressed_on_its_own() {
        let down = |k| TapEvent::Modifier { key: Some(k), down: true, alone: true };
        let up = |k| TapEvent::Modifier { key: Some(k), down: false, alone: true };
        let mut c = Capture::default();
        assert_eq!(c.on(down(Key::Fn)), None);
        assert_eq!(c.on(up(Key::Fn)), Some(Key::Fn));
        // Only once per press.
        assert_eq!(c.on(up(Key::Fn)), None);
        // Right Option used to type a character: a combination, so nothing is captured.
        c.on(down(Key::RightOption));
        c.on(TapEvent::KeyDown);
        assert_eq!(c.on(up(Key::RightOption)), None);
        // Held together with another modifier: not on its own.
        c.on(TapEvent::Modifier { key: Some(Key::RightCommand), down: true, alone: false });
        assert_eq!(c.on(up(Key::RightCommand)), None);
        c.on(down(Key::RightCommand));
        c.on(TapEvent::Modifier { key: None, down: true, alone: false });
        assert_eq!(c.on(up(Key::RightCommand)), None);
        // A different key's release doesn't count.
        c.on(down(Key::RightShift));
        assert_eq!(c.on(up(Key::RightControl)), None);
    }
}
