fn main() {
    // On Linux, sherpa-onnx shared libraries are copied next to the binary (and bundled under lib/opstrellis).
    // macOS links sherpa-onnx statically (see Cargo.toml).
    #[cfg(target_os = "linux")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN:$ORIGIN/../lib/opstrellis");
    tauri_build::build()
}
