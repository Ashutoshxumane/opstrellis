// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Answered before Tauri starts, so it works headless and doesn't reach a running instance.
    if std::env::args().skip(1).any(|a| a == "--version" || a == "-V") {
        println!("opstrellis {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    opstrellis_lib::run()
}
