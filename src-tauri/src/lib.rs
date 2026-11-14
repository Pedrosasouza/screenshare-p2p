mod audio;
mod commands;

use commands::{
    get_discord_status, list_windows, start_capture, start_exclude_discord, stop_capture,
    AudioCaptureState,
};
use tauri::webview::PageLoadEvent;
use tauri::{Manager, WebviewWindowBuilder, WindowEvent};

/// Restringe navegações da WebView principal estritamente à origem local do aplicativo.
pub fn is_allowed_app_navigation_url(url_str: &str) -> bool {
    let lower = url_str.trim().to_ascii_lowercase();
    if lower == "about:blank" || lower.starts_with("tauri://localhost") {
        return true;
    }
    if let Some(rest) = lower
        .strip_prefix("http://tauri.localhost")
        .or_else(|| lower.strip_prefix("https://tauri.localhost"))
    {
        return rest.is_empty()
            || rest.starts_with('/')
            || rest.starts_with('?')
            || rest.starts_with('#');
    }
    if cfg!(debug_assertions) {
        if let Some(rest) = lower
            .strip_prefix("http://localhost:")
            .or_else(|| lower.strip_prefix("http://127.0.0.1:"))
        {
            return rest.chars().next().is_some_and(|c| c.is_ascii_digit());
        }
    }
    false
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(AudioCaptureState::default())
        .setup(|app| {
            if let Some(main_cfg) = app.config().app.windows.first() {
                WebviewWindowBuilder::from_config(app.handle(), main_cfg)?
                    .on_navigation(|url| is_allowed_app_navigation_url(url.as_str()))
                    .build()?;
            }
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Started) {
                let state = webview.state::<AudioCaptureState>();
                state.stop_all();
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_windows,
            get_discord_status,
            start_capture,
            start_exclude_discord,
            stop_capture,
        ])
        .on_window_event(|window, event| {
            if matches!(
                event,
                WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
            ) {
                let state = window.state::<AudioCaptureState>();
                state.stop_all();
            }
        })
        .build(tauri::generate_context!())
        .expect("erro ao construir aplicação StreamGrid Tauri");

    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            let state = app_handle.state::<AudioCaptureState>();
            state.stop_all();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::is_allowed_app_navigation_url;

    #[test]
    fn allows_internal_tauri_origins_and_blocks_external_urls() {
        assert!(is_allowed_app_navigation_url("http://tauri.localhost/"));
        assert!(is_allowed_app_navigation_url(
            "https://tauri.localhost/?room=abc"
        ));
        assert!(is_allowed_app_navigation_url(
            "tauri://localhost/index.html"
        ));
        assert!(is_allowed_app_navigation_url("about:blank"));
        assert!(!is_allowed_app_navigation_url("https://evil.example.com/"));
        assert!(!is_allowed_app_navigation_url(
            "http://tauri.localhost.evil.com/"
        ));
        assert!(!is_allowed_app_navigation_url("javascript:alert(1)"));
    }
}
