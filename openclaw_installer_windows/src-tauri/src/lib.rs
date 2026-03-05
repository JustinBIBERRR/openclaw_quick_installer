mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_app_state,
            commands::run_syscheck,
            commands::start_install,
            commands::validate_api_key,
            commands::save_api_key,
            commands::start_gateway,
            commands::start_gateway_bg,
            commands::stop_gateway,
            commands::get_gateway_status,
            commands::open_url,
            commands::relaunch_as_admin,
            commands::uninstall,
            commands::get_default_install_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
