fn main() {
    // In CI fast Rust tests we only verify Rust logic and unit tests.
    // Skip Tauri build-script heavy work there; full Tauri build is verified
    // by the dedicated build-windows job.
    if std::env::var("OPENCLAW_SKIP_TAURI_BUILD")
        .map(|v| v == "1")
        .unwrap_or(false)
    {
        println!("cargo:warning=Skipping tauri_build::build() by OPENCLAW_SKIP_TAURI_BUILD=1");
        return;
    }

    tauri_build::build()
}
