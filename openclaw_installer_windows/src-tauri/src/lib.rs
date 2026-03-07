mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| Ok(()))
        .invoke_handler(tauri::generate_handler![
            commands::get_app_state,
            commands::check_environment,
            commands::run_syscheck,
            commands::start_install,
            commands::validate_api_key,
            commands::validate_feishu_connectivity,
            commands::get_saved_api_config,
            commands::get_saved_feishu_config,
            commands::save_api_key,
            commands::start_gateway,
            commands::start_gateway_bg,
            commands::stop_gateway,
            commands::kill_gateway_process,
            commands::get_gateway_status,
            commands::open_url,
            commands::open_config_file,
            commands::open_folder,
            commands::relaunch_as_admin,
            commands::uninstall,
            commands::get_default_install_dir,
            commands::detect_cli_capabilities,
            commands::run_doctor,
            commands::run_doctor_fix,
            commands::run_onboarding,
            commands::run_onboarding_with_model,
            commands::run_onboarding_guided,
            commands::run_gateway_start,
            commands::run_dashboard,
            commands::get_log_directory,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
