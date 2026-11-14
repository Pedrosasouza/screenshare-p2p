use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;
use windows::Win32::System::Threading::GetCurrentProcessId;

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
        self.stop_signal.store(true, Ordering::Release);
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
    fn lock_inner(&self) -> MutexGuard<'_, CaptureCoordinatorState> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn begin_session(&self, stop_signal: Arc<AtomicBool>) -> Result<u64, String> {
        let mut guard = self.lock_inner();

        guard.generation = guard.generation.wrapping_add(1);
        if let Some(session) = guard.active_session.take() {
            session.stop();
        }
        if let Some(prev_pending) = guard.pending_stop.take() {
            prev_pending.store(true, Ordering::Release);
        }
        guard.pending_stop = Some(stop_signal);
        Ok(guard.generation)
    }

    pub fn stop_all(&self) {
        let mut guard = self.lock_inner();
        guard.generation = guard.generation.wrapping_add(1);
        if let Some(session) = guard.active_session.take() {
            session.stop();
        }
        if let Some(pending) = guard.pending_stop.take() {
            pending.store(true, Ordering::Release);
        }
    }

    fn is_generation_active(&self, gen: u64) -> bool {
        self.lock_inner().generation == gen
    }

    fn clear_pending_if_generation(&self, gen: u64) {
        let mut guard = self.lock_inner();
        if guard.generation == gen {
            guard.pending_stop = None;
        }
    }

    pub fn clear_session_if_generation(&self, gen: u64) {
        let mut guard = self.lock_inner();
        if guard.generation == gen {
            if let Some(session) = guard.active_session.take() {
                session.stop();
            }
            if let Some(pending) = guard.pending_stop.take() {
                pending.store(true, Ordering::Release);
            }
        }
    }

    fn commit_session(
        &self,
        gen: u64,
        stop_signal: Arc<AtomicBool>,
        forward_task: tauri::async_runtime::JoinHandle<()>,
    ) -> Result<(), String> {
        let mut guard = self.lock_inner();
        if guard.generation != gen {
            forward_task.abort();
            stop_signal.store(true, Ordering::Release);
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
    }
}

pub fn validate_capture_target(
    pid: u32,
    include_tree: bool,
    current_pid: u32,
) -> Result<(), String> {
    if pid == 0 {
        return Err("PID inválido para captura de áudio.".into());
    }
    if include_tree && pid == current_pid {
        return Err("Auto-captura do próprio processo StreamGrid não é permitida.".into());
    }
    Ok(())
}

#[derive(Serialize, Clone)]
struct CaptureStoppedEvent {
    pid: u32,
    reason: String,
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
    app: AppHandle,
    pid: u32,
    include_tree: bool,
    on_audio: Channel<InvokeResponseBody>,
    state: &AudioCaptureState,
) -> Result<CaptureStartedInfo, String> {
    let current_pid = unsafe { GetCurrentProcessId() };
    validate_capture_target(pid, include_tree, current_pid)?;

    let (audio_tx, mut audio_rx) = mpsc::channel::<Vec<u8>>(100);
    let stop_signal = Arc::new(AtomicBool::new(false));
    let mode_str = if include_tree { "include" } else { "exclude" };

    // Garante isolamento: invalida e encerra sessão/inicialização anterior antes do await.
    let gen = state.begin_session(stop_signal.clone())?;
    let app_for_stop = app.clone();

    let (sample_rate, channels) = match start_wasapi_capture(
        pid,
        include_tree,
        audio_tx,
        stop_signal.clone(),
        move |reason| {
            app_for_stop
                .state::<AudioCaptureState>()
                .clear_session_if_generation(gen);
            let _ = app_for_stop.emit(
                "wasapi-capture-stopped",
                CaptureStoppedEvent { pid, reason },
            );
        },
    )
    .await
    {
        Ok(info) => info,
        Err(err) => {
            stop_signal.store(true, Ordering::Release);
            state.clear_pending_if_generation(gen);
            return Err(err);
        }
    };

    if !state.is_generation_active(gen) {
        stop_signal.store(true, Ordering::Release);
        return Err("Captura de áudio cancelada durante inicialização.".into());
    }

    let forward_stop = stop_signal.clone();
    let forward_task = tauri::async_runtime::spawn(async move {
        while let Some(pcm_chunk) = audio_rx.recv().await {
            if forward_stop.load(Ordering::Acquire) {
                break;
            }
            if on_audio.send(InvokeResponseBody::Raw(pcm_chunk)).is_err() {
                forward_stop.store(true, Ordering::Release);
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
pub async fn list_windows() -> Vec<WindowInfo> {
    tauri::async_runtime::spawn_blocking(list_application_windows)
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn get_discord_status() -> DiscordStatus {
    tauri::async_runtime::spawn_blocking(fetch_discord_status)
        .await
        .unwrap_or_else(|_| DiscordStatus {
            detected: false,
            pid: 0,
            name: "Discord Desktop".into(),
        })
}

#[tauri::command]
pub async fn start_capture(
    app: AppHandle,
    pid: u32,
    exclude: Option<bool>,
    on_audio: Channel<InvokeResponseBody>,
    state: State<'_, AudioCaptureState>,
) -> Result<CaptureStartedInfo, String> {
    let include_tree = !exclude.unwrap_or(false);
    start_capture_session(app, pid, include_tree, on_audio, state.inner()).await
}

#[tauri::command]
pub async fn start_exclude_discord(
    app: AppHandle,
    on_audio: Channel<InvokeResponseBody>,
    state: State<'_, AudioCaptureState>,
) -> Result<CaptureStartedInfo, String> {
    let discord_pid = find_discord_root_pid()
        .ok_or_else(|| "O Discord não foi encontrado em execução no Windows.".to_string())?;
    start_capture_session(app, discord_pid, false, on_audio, state.inner()).await
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
            state
                .commit_session(gen, stop_signal.clone(), task)
                .unwrap();

            assert!(!stop_signal.load(Ordering::Relaxed));
            assert!(!dropped.load(Ordering::Relaxed));

            state.stop_all();
            tokio::time::sleep(Duration::from_millis(20)).await;

            assert!(stop_signal.load(Ordering::Relaxed));
            assert!(dropped.load(Ordering::Relaxed));
        });
    }

    #[test]
    fn validate_capture_target_rejects_zero_and_self_include_pid() {
        assert!(validate_capture_target(0, true, 1234).is_err());
        assert!(validate_capture_target(1234, true, 1234).is_err());
        // Modo exclude no próprio PID só seria anômalo se alguém passar explicitamente,
        // mas processos legítimos externos passam normalmente.
        assert!(validate_capture_target(5678, true, 1234).is_ok());
        assert!(validate_capture_target(1234, false, 1234).is_ok());
    }

    #[test]
    fn clear_session_if_generation_only_clears_matching_generation() {
        tauri::async_runtime::block_on(async {
            let state = AudioCaptureState::default();
            let stop1 = Arc::new(AtomicBool::new(false));
            let gen1 = state.begin_session(stop1.clone()).unwrap();
            let dropped1 = Arc::new(AtomicBool::new(false));
            let task1 = spawn_cancellable_dummy(dropped1.clone());
            state.commit_session(gen1, stop1.clone(), task1).unwrap();

            // Limpar com geração diferente não deve afetar a sessão atual
            state.clear_session_if_generation(gen1.wrapping_add(1));
            tokio::time::sleep(Duration::from_millis(20)).await;
            assert!(!stop1.load(Ordering::Acquire));
            assert!(!dropped1.load(Ordering::Relaxed));

            // Limpar com a geração exata encerra a sessão atual
            state.clear_session_if_generation(gen1);
            tokio::time::sleep(Duration::from_millis(20)).await;
            assert!(stop1.load(Ordering::Acquire));
            assert!(dropped1.load(Ordering::Relaxed));
        });
    }
}
