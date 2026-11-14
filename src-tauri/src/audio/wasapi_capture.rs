use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot, Notify};
use wasapi::{
    initialize_mta, AudioCaptureClient, AudioClient, Direction, Handle, SampleType, StreamMode,
    WaveFormat,
};
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE,
};

use crate::audio::windows_enum::find_discord_root_pid;

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u16 = 2;
pub const CHUNK_FRAMES: usize = 480; // 10ms @ 48kHz
const MAX_SILENCE_BURST_FRAMES: usize = 4_800; // Max 100ms burst to prevent runaway
const MAX_QUEUED_FRAMES: usize = (SAMPLE_RATE as usize) / 2; // 500ms cap = 24_000 frames
const PROCESS_CHECK_INTERVAL: Duration = Duration::from_millis(250);
const DISCORD_REACQUIRE_INTERVAL: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureTargetKind {
    IncludeApp,
    ExcludeApp,
    ExcludeDiscord,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureReboundInfo {
    pub pid: u32,
    pub mode: String,
    pub reason: String,
}

/// Sinalizador assíncrono de encerramento da thread OS de captura WASAPI.
#[derive(Clone, Default)]
pub struct CaptureExitSignal {
    finished: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl CaptureExitSignal {
    pub fn mark_finished(&self) {
        self.finished.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    pub fn is_finished(&self) -> bool {
        self.finished.load(Ordering::Acquire)
    }

    pub async fn wait_until(&self, timeout: Duration) -> bool {
        if self.is_finished() {
            return true;
        }
        let notified = self.notify.notified();
        if self.is_finished() {
            return true;
        }
        let _ = tokio::time::timeout(timeout, notified).await;
        self.is_finished()
    }
}

struct ExitSignalGuard(CaptureExitSignal);

impl Drop for ExitSignalGuard {
    fn drop(&mut self) {
        self.0.mark_finished();
    }
}

fn should_poll_process(last_checked: Instant, now: Instant, interval: Duration) -> bool {
    now.saturating_duration_since(last_checked) >= interval
}

fn target_exited_reason(pid: u32, include_tree: bool) -> String {
    if include_tree {
        format!("O processo-alvo (PID {}) foi encerrado", pid)
    } else {
        format!("O processo excluído (PID {}) foi encerrado", pid)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TargetExitAction {
    StopUnexpected(String),
    RebindExclude {
        new_pid: u32,
        mode_label: &'static str,
        watch_target: bool,
        in_fallback: bool,
        reason: String,
    },
}

fn decide_after_target_exit(
    kind: CaptureTargetKind,
    exited_pid: u32,
    self_pid: u32,
    resolved_discord_pid: Option<u32>,
) -> TargetExitAction {
    match kind {
        CaptureTargetKind::IncludeApp => {
            TargetExitAction::StopUnexpected(target_exited_reason(exited_pid, true))
        }
        CaptureTargetKind::ExcludeApp => TargetExitAction::RebindExclude {
            new_pid: self_pid,
            mode_label: "system_fallback",
            watch_target: false,
            in_fallback: true,
            reason: format!(
                "O aplicativo excluído (PID {}) foi encerrado; mantendo áudio do sistema.",
                exited_pid
            ),
        },
        CaptureTargetKind::ExcludeDiscord => {
            if let Some(new_pid) =
                resolved_discord_pid.filter(|p| *p != 0 && *p != exited_pid && *p != self_pid)
            {
                TargetExitAction::RebindExclude {
                    new_pid,
                    mode_label: "exclude_discord",
                    watch_target: true,
                    in_fallback: false,
                    reason: format!(
                        "Discord reiniciado (novo PID {}); exclusão atualizada automaticamente.",
                        new_pid
                    ),
                }
            } else {
                TargetExitAction::RebindExclude {
                    new_pid: self_pid,
                    mode_label: "system_fallback",
                    watch_target: false,
                    in_fallback: true,
                    reason: "Discord encerrado; mantendo áudio completo do sistema.".into(),
                }
            }
        }
    }
}

struct TargetProcessWatcher {
    handle: HANDLE,
    last_checked: Instant,
}

impl TargetProcessWatcher {
    fn open(pid: u32, now: Instant) -> Option<Self> {
        // SAFETY: OpenProcess returns an owned HANDLE on success, closed once in Drop.
        let handle = unsafe {
            OpenProcess(
                PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                false,
                pid,
            )
        }
        .ok()?;
        if handle.is_invalid() {
            return None;
        }
        Some(Self {
            handle,
            last_checked: now,
        })
    }

    fn has_exited(&self) -> bool {
        // SAFETY: self.handle is a valid process HANDLE owned by self until Drop.
        let wait_result = unsafe { WaitForSingleObject(self.handle, 0) };
        wait_result == WAIT_OBJECT_0
    }

    fn poll_exited(&mut self, now: Instant) -> bool {
        if !should_poll_process(self.last_checked, now, PROCESS_CHECK_INTERVAL) {
            return false;
        }
        self.last_checked = now;
        self.has_exited()
    }
}

impl Drop for TargetProcessWatcher {
    fn drop(&mut self) {
        if !self.handle.is_invalid() {
            // SAFETY: self.handle is exclusively owned and closed once on Drop.
            unsafe {
                let _ = CloseHandle(self.handle);
            }
        }
    }
}

/// Calcula quantos frames de silêncio sintetizar para manter relógio exato a 48kHz.
pub fn compute_missing_silence_frames(
    expected_frames: u64,
    total_frames_sent: u64,
    current_queued_frames: u64,
) -> usize {
    let accounted = total_frames_sent.saturating_add(current_queued_frames);
    if accounted < expected_frames {
        let missing = (expected_frames - accounted) as usize;
        if missing > 0 && missing <= MAX_SILENCE_BURST_FRAMES {
            return missing;
        }
    }
    0
}

/// Rastreia a base temporal de sincronização de silêncio e ressincroniza após stalls longos.
#[derive(Debug, Clone)]
pub struct SilenceSyncTracker {
    sync_time: Instant,
    baseline_produced_at_sync: u64,
}

impl SilenceSyncTracker {
    pub fn new(now: Instant) -> Self {
        Self {
            sync_time: now,
            baseline_produced_at_sync: 0,
        }
    }

    pub fn resync(&mut self, now: Instant, total_frames_sent: u64, current_queued_frames: u64) {
        self.sync_time = now;
        self.baseline_produced_at_sync = total_frames_sent.saturating_add(current_queued_frames);
    }

    /// Calcula frames de silêncio faltantes desde a última sincronização.
    /// Quando o déficit ultrapassa `MAX_SILENCE_BURST_FRAMES`, ressincroniza o relógio
    /// com `now` e os frames já produzidos, retornando `0` apenas naquele ciclo.
    pub fn compute_missing_or_resync(
        &mut self,
        now: Instant,
        total_frames_sent: u64,
        current_queued_frames: u64,
    ) -> usize {
        let elapsed_sec = now.saturating_duration_since(self.sync_time).as_secs_f64();
        let expected_since_sync = (elapsed_sec * SAMPLE_RATE as f64) as u64;
        let produced_total = total_frames_sent.saturating_add(current_queued_frames);
        let produced_since_sync = produced_total.saturating_sub(self.baseline_produced_at_sync);

        if produced_since_sync < expected_since_sync {
            let missing = expected_since_sync - produced_since_sync;
            if missing > MAX_SILENCE_BURST_FRAMES as u64 {
                self.sync_time = now;
                self.baseline_produced_at_sync = produced_total;
                return 0;
            }
            return compute_missing_silence_frames(expected_since_sync, produced_since_sync, 0);
        }

        0
    }
}

fn trim_sample_queue_excess(
    sample_queue: &mut VecDeque<u8>,
    max_frames: usize,
    blockalign: usize,
) -> usize {
    if blockalign == 0 {
        return 0;
    }
    let max_bytes = max_frames.saturating_mul(blockalign);
    if sample_queue.len() <= max_bytes {
        return 0;
    }

    let excess_bytes = sample_queue.len() - max_bytes;
    let frames_to_drop = excess_bytes.div_ceil(blockalign);
    let max_droppable_frames = sample_queue.len() / blockalign;
    let actual_frames_to_drop = frames_to_drop.min(max_droppable_frames);
    let bytes_to_drop = actual_frames_to_drop * blockalign;
    if bytes_to_drop > 0 {
        sample_queue.drain(..bytes_to_drop);
    }
    actual_frames_to_drop
}

fn flush_sample_chunks(
    sample_queue: &mut VecDeque<u8>,
    chunk_bytes: usize,
    audio_tx: &mpsc::Sender<Vec<u8>>,
    stop_signal: &AtomicBool,
    total_frames_sent: &mut u64,
) -> bool {
    while sample_queue.len() >= chunk_bytes {
        let chunk: Vec<u8> = sample_queue.drain(..chunk_bytes).collect();
        match audio_tx.try_send(chunk) {
            Ok(()) => {
                *total_frames_sent += CHUNK_FRAMES as u64;
            }
            Err(mpsc::error::TrySendError::Full(_)) => {
                // Canal cheio por congestão no WebView: descarta sem travar a thread WASAPI
                // e contabiliza os frames para impedir injeção compensatória de silêncio.
                *total_frames_sent += CHUNK_FRAMES as u64;
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                stop_signal.store(true, Ordering::Release);
                return false;
            }
        }
    }
    true
}

struct ActiveLoopbackStream {
    audio_client: AudioClient,
    h_event: Handle,
    capture_client: AudioCaptureClient,
}

impl ActiveLoopbackStream {
    fn stop_and_drop(self) {
        let _ = self.audio_client.stop_stream();
    }
}

fn open_loopback_stream(
    target_pid: u32,
    include_tree: bool,
    desired_format: &WaveFormat,
    stop_signal: &AtomicBool,
) -> Result<ActiveLoopbackStream, String> {
    let mut audio_client = AudioClient::new_application_loopback_client(target_pid, include_tree)
        .map_err(|e| {
        let mode_desc = if include_tree {
            "inclusão"
        } else {
            "exclusão"
        };
        format!(
            "Falha ao criar loopback WASAPI (modo {}) para PID {}: {:?}",
            mode_desc, target_pid, e
        )
    })?;

    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: 0,
    };

    audio_client
        .initialize_client(desired_format, &Direction::Capture, &mode)
        .map_err(|e| format!("Falha ao inicializar cliente WASAPI: {:?}", e))?;

    let h_event = audio_client
        .set_get_eventhandle()
        .map_err(|e| format!("Falha ao obter evento de sincronia WASAPI: {:?}", e))?;

    let capture_client = audio_client
        .get_audiocaptureclient()
        .map_err(|e| format!("Falha ao obter AudioCaptureClient: {:?}", e))?;

    if stop_signal.load(Ordering::Acquire) {
        return Err("Captura de áudio cancelada antes do início.".into());
    }

    audio_client
        .start_stream()
        .map_err(|e| format!("Falha ao iniciar stream WASAPI: {:?}", e))?;

    Ok(ActiveLoopbackStream {
        audio_client,
        h_event,
        capture_client,
    })
}

struct RebindOutcome {
    stream: ActiveLoopbackStream,
    watcher: Option<TargetProcessWatcher>,
    info: CaptureReboundInfo,
}

fn rebind_exclude_stream(
    active_stream: &mut Option<ActiveLoopbackStream>,
    new_pid: u32,
    watch_target: bool,
    mode_label: &str,
    reason: String,
    desired_format: &WaveFormat,
    stop_signal: &AtomicBool,
) -> Result<Option<RebindOutcome>, String> {
    if let Some(prev) = active_stream.take() {
        prev.stop_and_drop();
    }
    if stop_signal.load(Ordering::Acquire) {
        return Ok(None);
    }
    let next_stream = open_loopback_stream(new_pid, false, desired_format, stop_signal)?;
    let watcher = if watch_target {
        TargetProcessWatcher::open(new_pid, Instant::now())
    } else {
        None
    };
    Ok(Some(RebindOutcome {
        stream: next_stream,
        watcher,
        info: CaptureReboundInfo {
            pid: new_pid,
            mode: mode_label.to_string(),
            reason,
        },
    }))
}

/// Inicia captura WASAPI Application Loopback em thread dedicada com apartamento COM MTA.
/// Em modos de exclusão (`ExcludeApp` / `ExcludeDiscord`), preserva o fluxo de áudio de sistema
/// caso o processo excluído seja encerrado ou reiniciado.
pub async fn start_wasapi_capture<F, R>(
    pid: u32,
    target_kind: CaptureTargetKind,
    audio_tx: mpsc::Sender<Vec<u8>>,
    stop_signal: Arc<AtomicBool>,
    exit_signal: CaptureExitSignal,
    on_unexpected_stop: F,
    mut on_target_rebound: R,
) -> Result<(u32, u16), String>
where
    F: FnOnce(u32, String) + Send + 'static,
    R: FnMut(CaptureReboundInfo) + Send + 'static,
{
    let (ready_tx, ready_rx) = oneshot::channel();
    let include_tree = target_kind == CaptureTargetKind::IncludeApp;

    std::thread::spawn(move || {
        // Declarado primeiro para dropar por último (após drop do AudioClient).
        let _exit_guard = ExitSignalGuard(exit_signal);
        let _ = initialize_mta();

        let desired_format = WaveFormat::new(
            32,
            32,
            &SampleType::Float,
            SAMPLE_RATE as usize,
            CHANNELS as usize,
            None,
        );
        let blockalign = desired_format.get_blockalign() as usize;
        let self_pid = unsafe { GetCurrentProcessId() };

        let mut active_stream =
            match open_loopback_stream(pid, include_tree, &desired_format, &stop_signal) {
                Ok(stream) => Some(stream),
                Err(err) => {
                    let _ = ready_tx.send(Err(err));
                    return;
                }
            };

        let _ = ready_tx.send(Ok((SAMPLE_RATE, CHANNELS)));

        let mut current_pid = pid;
        let mut sample_queue: VecDeque<u8> = VecDeque::new();
        let chunk_bytes = CHUNK_FRAMES * blockalign;
        let mut silence_sync = SilenceSyncTracker::new(Instant::now());
        let mut total_frames_sent: u64 = 0;
        let mut unexpected_reason: Option<String> = None;
        let mut process_watcher = TargetProcessWatcher::open(current_pid, Instant::now());
        let mut in_discord_fallback = false;
        let mut last_discord_probe = Instant::now();

        while !stop_signal.load(Ordering::Acquire) {
            let mut read_error = false;
            if let Some(stream) = active_stream.as_ref() {
                while !stop_signal.load(Ordering::Acquire) {
                    match stream.capture_client.get_next_packet_size() {
                        Ok(Some(new_frames)) if new_frames > 0 => {
                            sample_queue.reserve(new_frames as usize * blockalign);

                            if stream
                                .capture_client
                                .read_from_device_to_deque(&mut sample_queue)
                                .is_err()
                            {
                                eprintln!("[WASAPI] Read device error");
                                unexpected_reason =
                                    Some("Dispositivo ou processo de áudio indisponível".into());
                                read_error = true;
                                break;
                            }
                        }
                        Ok(_) => break,
                        Err(_) => {
                            eprintln!("[WASAPI] get_next_packet_size error");
                            unexpected_reason =
                                Some("Dispositivo de áudio desconectado ou invalidado".into());
                            read_error = true;
                            break;
                        }
                    }
                }
            }

            if read_error || stop_signal.load(Ordering::Acquire) {
                break;
            }

            let now = Instant::now();
            if let Some(watcher) = process_watcher.as_mut() {
                if watcher.poll_exited(now) {
                    if stop_signal.load(Ordering::Acquire) {
                        break;
                    }
                    let resolved_discord = if target_kind == CaptureTargetKind::ExcludeDiscord {
                        find_discord_root_pid()
                    } else {
                        None
                    };
                    match decide_after_target_exit(
                        target_kind,
                        current_pid,
                        self_pid,
                        resolved_discord,
                    ) {
                        TargetExitAction::StopUnexpected(reason) => {
                            unexpected_reason = Some(reason);
                            break;
                        }
                        TargetExitAction::RebindExclude {
                            new_pid,
                            mode_label,
                            watch_target,
                            in_fallback,
                            reason,
                        } => match rebind_exclude_stream(
                            &mut active_stream,
                            new_pid,
                            watch_target,
                            mode_label,
                            reason,
                            &desired_format,
                            &stop_signal,
                        ) {
                            Ok(Some(outcome)) => {
                                active_stream = Some(outcome.stream);
                                current_pid = new_pid;
                                in_discord_fallback = in_fallback;
                                last_discord_probe = Instant::now();
                                process_watcher = outcome.watcher;
                                let queued = (sample_queue.len() / blockalign) as u64;
                                silence_sync.resync(Instant::now(), total_frames_sent, queued);
                                on_target_rebound(outcome.info);
                            }
                            Ok(None) => break,
                            Err(err) => {
                                if !stop_signal.load(Ordering::Acquire) {
                                    unexpected_reason = Some(err);
                                }
                                break;
                            }
                        },
                    }
                }
            } else if in_discord_fallback
                && target_kind == CaptureTargetKind::ExcludeDiscord
                && should_poll_process(last_discord_probe, now, DISCORD_REACQUIRE_INTERVAL)
            {
                last_discord_probe = now;
                if let Some(new_pid) = find_discord_root_pid().filter(|p| *p != 0 && *p != self_pid)
                {
                    let reason = format!(
                        "Discord detectado (PID {}); voltando a excluir chamadas.",
                        new_pid
                    );
                    match rebind_exclude_stream(
                        &mut active_stream,
                        new_pid,
                        true,
                        "exclude_discord",
                        reason,
                        &desired_format,
                        &stop_signal,
                    ) {
                        Ok(Some(outcome)) => {
                            active_stream = Some(outcome.stream);
                            current_pid = new_pid;
                            in_discord_fallback = false;
                            process_watcher = outcome.watcher;
                            let queued = (sample_queue.len() / blockalign) as u64;
                            silence_sync.resync(Instant::now(), total_frames_sent, queued);
                            on_target_rebound(outcome.info);
                        }
                        Ok(None) => break,
                        Err(err) => {
                            if !stop_signal.load(Ordering::Acquire) {
                                unexpected_reason = Some(err);
                            }
                            break;
                        }
                    }
                }
            }

            let dropped_frames =
                trim_sample_queue_excess(&mut sample_queue, MAX_QUEUED_FRAMES, blockalign);
            total_frames_sent += dropped_frames as u64;

            if !flush_sample_chunks(
                &mut sample_queue,
                chunk_bytes,
                &audio_tx,
                &stop_signal,
                &mut total_frames_sent,
            ) {
                break;
            }

            let current_queued_frames = (sample_queue.len() / blockalign) as u64;
            let missing_frames = silence_sync.compute_missing_or_resync(
                now,
                total_frames_sent,
                current_queued_frames,
            );
            if missing_frames > 0 {
                sample_queue.resize(sample_queue.len() + (missing_frames * blockalign), 0);
                if !flush_sample_chunks(
                    &mut sample_queue,
                    chunk_bytes,
                    &audio_tx,
                    &stop_signal,
                    &mut total_frames_sent,
                ) {
                    break;
                }
            }

            if let Some(stream) = active_stream.as_ref() {
                let _ = stream.h_event.wait_for_event(10);
            }
        }

        if let Some(stream) = active_stream.take() {
            stream.stop_and_drop();
        }
        eprintln!("[WASAPI] Stream finalizado para PID {}", current_pid);
        if let Some(reason) = unexpected_reason {
            if !stop_signal.load(Ordering::Acquire) {
                on_unexpected_stop(current_pid, reason);
            }
        }
    });

    match ready_rx.await {
        Ok(res) => res,
        Err(_) => Err("Thread de captura de áudio finalizou prematuramente".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        compute_missing_silence_frames, decide_after_target_exit, flush_sample_chunks,
        should_poll_process, target_exited_reason, trim_sample_queue_excess, CaptureTargetKind,
        SilenceSyncTracker, TargetExitAction, TargetProcessWatcher, CHUNK_FRAMES,
        MAX_SILENCE_BURST_FRAMES, PROCESS_CHECK_INTERVAL,
    };
    use std::collections::VecDeque;
    use std::process::Command;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};
    use tokio::sync::mpsc;

    #[test]
    fn synthesizes_missing_silence_up_to_burst_cap() {
        assert_eq!(compute_missing_silence_frames(1000, 400, 120), 480);
        assert_eq!(compute_missing_silence_frames(1000, 900, 200), 0);
        // Overshoot above MAX_SILENCE_BURST_FRAMES (4800) is suppressed to avoid runaway
        assert_eq!(compute_missing_silence_frames(10_000, 0, 0), 0);
    }

    #[test]
    fn tracker_computes_normal_deficit_accounting_for_queued_frames() {
        let t0 = Instant::now();
        let mut tracker = SilenceSyncTracker::new(t0);

        // 20ms @ 48kHz = 960 frames expected; 200 sent + 280 queued = 480 accounted -> 480 missing
        let missing = tracker.compute_missing_or_resync(t0 + Duration::from_millis(20), 200, 280);
        assert_eq!(missing, 480);

        // Deficit exactly at MAX_SILENCE_BURST_FRAMES (100ms = 4800 frames) still synthesizes without resync
        let burst = tracker.compute_missing_or_resync(t0 + Duration::from_millis(120), 960, 0);
        assert_eq!(burst, MAX_SILENCE_BURST_FRAMES);
    }

    #[test]
    fn tracker_resyncs_after_large_stall_and_resumes_silence() {
        let t0 = Instant::now();
        let mut tracker = SilenceSyncTracker::new(t0);

        // 500ms stall (24_000 frames > MAX_SILENCE_BURST_FRAMES) suppresses burst and resyncs clock
        let t_stall = t0 + Duration::from_millis(500);
        assert_eq!(tracker.compute_missing_or_resync(t_stall, 480, 480), 0);

        // Queued 480 frames drain (total_frames_sent = 960, queued = 0), then 10ms of silence elapses
        let t_after = t_stall + Duration::from_millis(10);
        assert_eq!(tracker.compute_missing_or_resync(t_after, 960, 0), 480);
    }

    #[test]
    fn tracker_handles_ahead_of_clock_queue_without_underflow_or_spurious_resync() {
        let t0 = Instant::now();
        let mut tracker = SilenceSyncTracker::new(t0);

        // 10ms elapsed (480 expected), but 960 frames are already queued ahead of the clock
        assert_eq!(
            tracker.compute_missing_or_resync(t0 + Duration::from_millis(10), 0, 960),
            0
        );

        // After draining those 960 frames, at 20ms (960 expected) deficit is still 0
        assert_eq!(
            tracker.compute_missing_or_resync(t0 + Duration::from_millis(20), 960, 0),
            0
        );

        // At 30ms (1440 expected), 480 frames are missing (sync_time was preserved)
        assert_eq!(
            tracker.compute_missing_or_resync(t0 + Duration::from_millis(30), 960, 0),
            480
        );
    }

    #[test]
    fn flush_sample_chunks_drops_on_full_channel_without_blocking() {
        let (tx, _rx) = mpsc::channel(1);
        tx.try_send(vec![9u8; 8]).unwrap();

        let chunk_bytes = CHUNK_FRAMES * 8;
        let mut queue: VecDeque<u8> = vec![1u8; chunk_bytes * 2].into();
        let stop = AtomicBool::new(false);
        let mut total_frames_sent = 0u64;

        let ok = flush_sample_chunks(&mut queue, chunk_bytes, &tx, &stop, &mut total_frames_sent);
        assert!(ok);
        assert!(!stop.load(Ordering::Relaxed));
        assert!(queue.is_empty());
        assert_eq!(total_frames_sent, (CHUNK_FRAMES * 2) as u64);
    }

    #[test]
    fn flush_sample_chunks_signals_stop_when_receiver_closed() {
        let (tx, rx) = mpsc::channel(4);
        drop(rx);

        let chunk_bytes = CHUNK_FRAMES * 8;
        let mut queue: VecDeque<u8> = vec![1u8; chunk_bytes].into();
        let stop = AtomicBool::new(false);
        let mut total_frames_sent = 0u64;

        let ok = flush_sample_chunks(&mut queue, chunk_bytes, &tx, &stop, &mut total_frames_sent);
        assert!(!ok);
        assert!(stop.load(Ordering::Relaxed));
        assert_eq!(total_frames_sent, 0);
    }

    #[test]
    fn trim_sample_queue_excess_keeps_blockalign_and_max_frames() {
        let blockalign = 8;
        let mut queue: VecDeque<u8> = VecDeque::new();
        for frame_idx in 0u8..7 {
            queue.extend([frame_idx; 8]);
        }

        // Max 4 frames (32 bytes): must drop 3 frames (24 bytes), keeping frames 3..6 aligned
        let dropped = trim_sample_queue_excess(&mut queue, 4, blockalign);
        assert_eq!(dropped, 3);
        assert_eq!(queue.len(), 32);
        assert_eq!(queue[0], 3);
        assert_eq!(queue[8], 4);

        // Unaligned excess (36 bytes > 32 max): rounds up to 1 full frame (8 bytes)
        let mut unaligned: VecDeque<u8> = (0u8..36).collect();
        let dropped_unaligned = trim_sample_queue_excess(&mut unaligned, 4, blockalign);
        assert_eq!(dropped_unaligned, 1);
        assert_eq!(unaligned.len(), 28);
        assert_eq!(unaligned[0], 8);

        // blockalign = 0 is a safe no-op
        assert_eq!(trim_sample_queue_excess(&mut unaligned, 2, 0), 0);
    }

    #[test]
    fn target_process_watcher_reports_active_self_and_exited_child() {
        let now = Instant::now();
        let self_watcher = TargetProcessWatcher::open(std::process::id(), now)
            .expect("should open handle to current process");
        assert!(!self_watcher.has_exited());

        let mut child = Command::new("cmd")
            .args(["/C", "exit 0"])
            .spawn()
            .expect("should spawn short-lived child process");
        let child_pid = child.id();
        let mut child_watcher =
            TargetProcessWatcher::open(child_pid, now).expect("should open handle to child");

        let status = child.wait().expect("should wait for child process");
        assert!(status.success());
        assert!(child_watcher.has_exited());

        assert!(!child_watcher.poll_exited(now + Duration::from_millis(100)));
        assert!(child_watcher.poll_exited(now + PROCESS_CHECK_INTERVAL));
    }

    #[test]
    fn should_poll_process_and_reason_formatting() {
        let t0 = Instant::now();
        assert!(!should_poll_process(
            t0,
            t0 + Duration::from_millis(249),
            PROCESS_CHECK_INTERVAL
        ));
        assert!(should_poll_process(
            t0,
            t0 + Duration::from_millis(250),
            PROCESS_CHECK_INTERVAL
        ));

        assert_eq!(
            target_exited_reason(4242, true),
            "O processo-alvo (PID 4242) foi encerrado"
        );
        assert_eq!(
            target_exited_reason(4242, false),
            "O processo excluído (PID 4242) foi encerrado"
        );
    }

    #[test]
    fn decide_after_target_exit_handles_include_exclude_and_discord_restart() {
        assert_eq!(
            decide_after_target_exit(CaptureTargetKind::IncludeApp, 1001, 9999, Some(2002)),
            TargetExitAction::StopUnexpected("O processo-alvo (PID 1001) foi encerrado".into())
        );

        assert_eq!(
            decide_after_target_exit(CaptureTargetKind::ExcludeApp, 1002, 9999, None),
            TargetExitAction::RebindExclude {
                new_pid: 9999,
                mode_label: "system_fallback",
                watch_target: false,
                in_fallback: true,
                reason:
                    "O aplicativo excluído (PID 1002) foi encerrado; mantendo áudio do sistema."
                        .into(),
            }
        );

        assert_eq!(
            decide_after_target_exit(CaptureTargetKind::ExcludeDiscord, 1003, 9999, Some(2003)),
            TargetExitAction::RebindExclude {
                new_pid: 2003,
                mode_label: "exclude_discord",
                watch_target: true,
                in_fallback: false,
                reason: "Discord reiniciado (novo PID 2003); exclusão atualizada automaticamente."
                    .into(),
            }
        );

        assert_eq!(
            decide_after_target_exit(CaptureTargetKind::ExcludeDiscord, 1003, 9999, None),
            TargetExitAction::RebindExclude {
                new_pid: 9999,
                mode_label: "system_fallback",
                watch_target: false,
                in_fallback: true,
                reason: "Discord encerrado; mantendo áudio completo do sistema.".into(),
            }
        );

        // Stale same PID should trigger system fallback rather than looping on dead PID
        assert_eq!(
            decide_after_target_exit(CaptureTargetKind::ExcludeDiscord, 1003, 9999, Some(1003)),
            TargetExitAction::RebindExclude {
                new_pid: 9999,
                mode_label: "system_fallback",
                watch_target: false,
                in_fallback: true,
                reason: "Discord encerrado; mantendo áudio completo do sistema.".into(),
            }
        );
    }

    #[test]
    fn tracker_explicit_resync_resets_clock_baseline_after_rebind() {
        let t0 = Instant::now();
        let mut tracker = SilenceSyncTracker::new(t0);
        let t_rebind = t0 + Duration::from_secs(5);
        tracker.resync(t_rebind, 10_000, 480);
        assert_eq!(tracker.compute_missing_or_resync(t_rebind, 10_000, 480), 0);
        assert_eq!(
            tracker.compute_missing_or_resync(t_rebind + Duration::from_millis(10), 10_480, 0),
            480
        );
    }
}
