use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;
use tokio::sync::mpsc;

use crate::audio::wasapi_capture::start_wasapi_capture;
use crate::audio::windows_enum::{
    find_discord_root_pid, get_discord_status as fetch_discord_status, list_application_windows,
    DiscordStatus, WindowInfo,
};

struct ActiveCaptureSession {
    stop_signal: Arc<AtomicBool>,
    forward_task: tauri::async_runtime::JoinHandle<()>,
}

impl ActiveCaptureSession {
    fn stop(self) {
        self.stop_signal.store(true, Ordering::Relaxed);
        self.forward_task.abort();
    }
}

#[derive(Default)]
pub struct AudioCaptureState {
    active_session: Mutex<Option<ActiveCaptureSession>>,
}

impl AudioCaptureState {
    pub fn stop_all(&self) {
        if let Ok(mut guard) = self.active_session.lock() {
            if let Some(session) = guard.take() {
                session.stop();
            }
        }
    }
}

#[derive(Serialize, Debug, Clone)]
pub struct CaptureStartedInfo {
    pub pid: u32,
    pub sample_rate: u32,
    pub channels: u16,
    pub format: String,
    pub mode: String,
}

async fn start_capture_session(
    pid: u32,
    include_tree: bool,
    on_audio: Channel<InvokeResponseBody>,
    state: &AudioCaptureState,
) -> Result<CaptureStartedInfo, String> {
    if pid == 0 {
        return Err("PID inválido para captura de áudio.".into());
    }

    // Garante isolamento: encerra sessão anterior antes de abrir uma nova.
    state.stop_all();

    let (audio_tx, mut audio_rx) = mpsc::channel::<Vec<u8>>(100);
    let stop_signal = Arc::new(AtomicBool::new(false));
    let mode_str = if include_tree { "include" } else { "exclude" };

    let (sample_rate, channels) =
        start_wasapi_capture(pid, include_tree, audio_tx, stop_signal.clone()).await?;

    let forward_stop = stop_signal.clone();
    let forward_task = tauri::async_runtime::spawn(async move {
        while let Some(pcm_chunk) = audio_rx.recv().await {
            if forward_stop.load(Ordering::Relaxed) {
                break;
            }
            if on_audio.send(InvokeResponseBody::Raw(pcm_chunk)).is_err() {
                forward_stop.store(true, Ordering::Relaxed);
                break;
            }
        }
    });

    if let Ok(mut guard) = state.active_session.lock() {
        if let Some(prev) = guard.replace(ActiveCaptureSession {
            stop_signal,
            forward_task,
        }) {
            prev.stop();
        }
    } else {
        stop_signal.store(true, Ordering::Relaxed);
        return Err("Falha ao adquirir estado interno de captura de áudio.".into());
    }

    Ok(CaptureStartedInfo {
        pid,
        sample_rate,
        channels,
        format: "f32le".to_string(),
        mode: mode_str.to_string(),
    })
}

#[tauri::command]
pub fn list_windows() -> Vec<WindowInfo> {
    list_application_windows()
}

#[tauri::command]
pub fn get_discord_status() -> DiscordStatus {
    fetch_discord_status()
}

#[tauri::command]
pub async fn start_capture(
    pid: u32,
    exclude: Option<bool>,
    on_audio: Channel<InvokeResponseBody>,
    state: State<'_, AudioCaptureState>,
) -> Result<CaptureStartedInfo, String> {
    let include_tree = !exclude.unwrap_or(false);
    start_capture_session(pid, include_tree, on_audio, state.inner()).await
}

#[tauri::command]
pub async fn start_exclude_discord(
    on_audio: Channel<InvokeResponseBody>,
    state: State<'_, AudioCaptureState>,
) -> Result<CaptureStartedInfo, String> {
    let discord_pid = find_discord_root_pid().ok_or_else(|| {
        "O Discord não foi encontrado em execução no Windows.".to_string()
    })?;
    start_capture_session(discord_pid, false, on_audio, state.inner()).await
}

#[tauri::command]
pub fn stop_capture(state: State<'_, AudioCaptureState>) -> Result<(), String> {
    state.stop_all();
    Ok(())
}
