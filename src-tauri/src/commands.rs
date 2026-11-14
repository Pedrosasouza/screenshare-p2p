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
struct CaptureCoordinatorState {
    generation: u64,
    active_session: Option<ActiveCaptureSession>,
    pending_stop: Option<Arc<AtomicBool>>,
}

#[derive(Default)]
pub struct AudioCaptureState {
    inner: Mutex<CaptureCoordinatorState>,
}

impl AudioCaptureState {
    fn begin_session(&self, stop_signal: Arc<AtomicBool>) -> Result<u64, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "Falha ao adquirir estado interno de captura de áudio.".to_string())?;

        guard.generation = guard.generation.wrapping_add(1);
        if let Some(session) = guard.active_session.take() {
            session.stop();
        }
        if let Some(prev_pending) = guard.pending_stop.take() {
            prev_pending.store(true, Ordering::Relaxed);
        }
        guard.pending_stop = Some(stop_signal);
        Ok(guard.generation)
    }

    pub fn stop_all(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.generation = guard.generation.wrapping_add(1);
            if let Some(session) = guard.active_session.take() {
                session.stop();
            }
            if let Some(pending) = guard.pending_stop.take() {
                pending.store(true, Ordering::Relaxed);
            }
        }
    }

    fn is_generation_active(&self, gen: u64) -> bool {
        self.inner
            .lock()
            .map(|guard| guard.generation == gen)
            .unwrap_or(false)
    }

    fn clear_pending_if_generation(&self, gen: u64) {
        if let Ok(mut guard) = self.inner.lock() {
            if guard.generation == gen {
                guard.pending_stop = None;
            }
        }
    }

    fn commit_session(
        &self,
        gen: u64,
        stop_signal: Arc<AtomicBool>,
        forward_task: tauri::async_runtime::JoinHandle<()>,
    ) -> Result<(), String> {
        if let Ok(mut guard) = self.inner.lock() {
            if guard.generation != gen {
                forward_task.abort();
                stop_signal.store(true, Ordering::Relaxed);
                return Err("Captura de áudio cancelada durante inicialização.".into());
            }

            guard.pending_stop = None;
            if let Some(prev) = guard.active_session.replace(ActiveCaptureSession {
                stop_signal,
                forward_task,
            }) {
                prev.stop();
            }
            Ok(())
        } else {
            stop_signal.store(true, Ordering::Relaxed);
            forward_task.abort();
            Err("Falha ao adquirir estado interno de captura de áudio.".into())
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

    let (audio_tx, mut audio_rx) = mpsc::channel::<Vec<u8>>(100);
    let stop_signal = Arc::new(AtomicBool::new(false));
    let mode_str = if include_tree { "include" } else { "exclude" };

    // Garante isolamento: invalida e encerra sessão/inicialização anterior antes do await.
    let gen = state.begin_session(stop_signal.clone())?;

    let (sample_rate, channels) =
        match start_wasapi_capture(pid, include_tree, audio_tx, stop_signal.clone()).await {
            Ok(info) => info,
            Err(err) => {
                stop_signal.store(true, Ordering::Relaxed);
                state.clear_pending_if_generation(gen);
                return Err(err);
            }
        };

    if !state.is_generation_active(gen) {
        stop_signal.store(true, Ordering::Relaxed);
        return Err("Captura de áudio cancelada durante inicialização.".into());
    }

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

    state.commit_session(gen, stop_signal, forward_task)?;

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    struct DropFlag(Arc<AtomicBool>);

    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Relaxed);
        }
    }

    fn spawn_cancellable_dummy(dropped: Arc<AtomicBool>) -> tauri::async_runtime::JoinHandle<()> {
        let guard = DropFlag(dropped);
        tauri::async_runtime::spawn(async move {
            let _keep_alive = guard;
            tokio::time::sleep(Duration::from_secs(60)).await;
        })
    }

    #[test]
    fn stop_all_during_inflight_begin_cancels_pending_and_aborts_commit() {
        tauri::async_runtime::block_on(async {
            let state = AudioCaptureState::default();
            let stop_signal = Arc::new(AtomicBool::new(false));
            let gen = state.begin_session(stop_signal.clone()).unwrap();

            assert!(state.is_generation_active(gen));
            state.stop_all();

            assert!(stop_signal.load(Ordering::Relaxed));
            assert!(!state.is_generation_active(gen));

            let dropped = Arc::new(AtomicBool::new(false));
            let task = spawn_cancellable_dummy(dropped.clone());
            let commit_res = state.commit_session(gen, stop_signal.clone(), task);

            assert!(commit_res.is_err());
            tokio::time::sleep(Duration::from_millis(20)).await;
            assert!(dropped.load(Ordering::Relaxed));
        });
    }

    #[test]
    fn second_begin_session_invalidates_first_and_allows_second_commit() {
        tauri::async_runtime::block_on(async {
            let state = AudioCaptureState::default();
            let stop1 = Arc::new(AtomicBool::new(false));
            let stop2 = Arc::new(AtomicBool::new(false));

            let gen1 = state.begin_session(stop1.clone()).unwrap();
            let gen2 = state.begin_session(stop2.clone()).unwrap();

            assert_ne!(gen1, gen2);
            assert!(stop1.load(Ordering::Relaxed));
            assert!(!stop2.load(Ordering::Relaxed));
            assert!(!state.is_generation_active(gen1));
            assert!(state.is_generation_active(gen2));

            let dropped1 = Arc::new(AtomicBool::new(false));
            let task1 = spawn_cancellable_dummy(dropped1.clone());
            assert!(state.commit_session(gen1, stop1.clone(), task1).is_err());

            let dropped2 = Arc::new(AtomicBool::new(false));
            let task2 = spawn_cancellable_dummy(dropped2.clone());
            assert!(state.commit_session(gen2, stop2.clone(), task2).is_ok());

            tokio::time::sleep(Duration::from_millis(20)).await;
            assert!(dropped1.load(Ordering::Relaxed));
            assert!(!dropped2.load(Ordering::Relaxed));
            assert!(!stop2.load(Ordering::Relaxed));

            state.stop_all();
            tokio::time::sleep(Duration::from_millis(20)).await;
            assert!(stop2.load(Ordering::Relaxed));
            assert!(dropped2.load(Ordering::Relaxed));
        });
    }

    #[test]
    fn stop_all_after_commit_signals_stop_and_aborts_task() {
        tauri::async_runtime::block_on(async {
            let state = AudioCaptureState::default();
            let stop_signal = Arc::new(AtomicBool::new(false));
            let gen = state.begin_session(stop_signal.clone()).unwrap();

            let dropped = Arc::new(AtomicBool::new(false));
            let task = spawn_cancellable_dummy(dropped.clone());
            state.commit_session(gen, stop_signal.clone(), task).unwrap();

            assert!(!stop_signal.load(Ordering::Relaxed));
            assert!(!dropped.load(Ordering::Relaxed));

            state.stop_all();
            tokio::time::sleep(Duration::from_millis(20)).await;

            assert!(stop_signal.load(Ordering::Relaxed));
            assert!(dropped.load(Ordering::Relaxed));
        });
    }
}
