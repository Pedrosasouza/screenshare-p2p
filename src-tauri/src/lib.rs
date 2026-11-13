mod audio;
mod commands;

use commands::{
    get_discord_status, list_windows, start_capture, start_exclude_discord, stop_capture,
    AudioCaptureState,
};
use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(AudioCaptureState::default())
        .invoke_handler(tauri::generate_handler![
            list_windows,
            get_discord_status,
            start_capture,
            start_exclude_discord,
            stop_capture,
        ])
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed) {
                let state = window.state::<AudioCaptureState>();
                state.stop_all();
            }
        })
        .build(tauri::generate_context!())
        .expect("erro ao construir aplicação StreamGrid Tauri");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }) {
            let state = app_handle.state::<AudioCaptureState>();
            state.stop_all();
        }
    });
}
