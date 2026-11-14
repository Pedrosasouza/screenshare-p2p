use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{mpsc, oneshot};
use wasapi::{initialize_mta, AudioClient, Direction, SampleType, StreamMode, WaveFormat};

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u16 = 2;
pub const CHUNK_FRAMES: usize = 480; // 10ms @ 48kHz
const MAX_SILENCE_BURST_FRAMES: usize = 4_800; // Max 100ms burst to prevent runaway
const MAX_QUEUED_FRAMES: usize = (SAMPLE_RATE as usize) / 2; // 500ms cap = 24_000 frames

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
                stop_signal.store(true, Ordering::Relaxed);
                return false;
            }
        }
    }
    true
}

/// Inicia captura WASAPI Application Loopback em thread dedicada com apartamento COM MTA.
/// `include_tree`: true = INCLUDE (apenas o processo alvo); false = EXCLUDE (sistema exceto alvo).
pub async fn start_wasapi_capture(
    pid: u32,
    include_tree: bool,
    audio_tx: mpsc::Sender<Vec<u8>>,
    stop_signal: Arc<AtomicBool>,
) -> Result<(u32, u16), String> {
    let (ready_tx, ready_rx) = oneshot::channel();

    std::thread::spawn(move || {
        let _ = initialize_mta();

        let desired_format = WaveFormat::new(32, 32, &SampleType::Float, SAMPLE_RATE as usize, CHANNELS as usize, None);
        let blockalign = desired_format.get_blockalign() as usize;
        let autoconvert = true;

        let mut audio_client = match AudioClient::new_application_loopback_client(pid, include_tree)
        {
            Ok(c) => c,
            Err(e) => {
                let mode_desc = if include_tree { "inclusão" } else { "exclusão" };
                let _ = ready_tx.send(Err(format!(
                    "Falha ao criar loopback WASAPI (modo {}) para PID {}: {:?}",
                    mode_desc, pid, e
                )));
                return;
            }
        };

        let mode = StreamMode::EventsShared {
            autoconvert,
            buffer_duration_hns: 0,
        };

        if let Err(e) = audio_client.initialize_client(&desired_format, &Direction::Capture, &mode)
        {
            let _ = ready_tx.send(Err(format!("Falha ao inicializar cliente WASAPI: {:?}", e)));
            return;
        }

        let h_event = match audio_client.set_get_eventhandle() {
            Ok(h) => h,
            Err(e) => {
                let _ = ready_tx.send(Err(format!(
                    "Falha ao obter evento de sincronia WASAPI: {:?}",
                    e
                )));
                return;
            }
        };

        let capture_client = match audio_client.get_audiocaptureclient() {
            Ok(c) => c,
            Err(e) => {
                let _ = ready_tx.send(Err(format!("Falha ao obter AudioCaptureClient: {:?}", e)));
                return;
            }
        };

        if let Err(e) = audio_client.start_stream() {
            let _ = ready_tx.send(Err(format!("Falha ao iniciar stream WASAPI: {:?}", e)));
            return;
        }

        let _ = ready_tx.send(Ok((SAMPLE_RATE, CHANNELS)));

        let mut sample_queue: VecDeque<u8> = VecDeque::new();
        let chunk_bytes = CHUNK_FRAMES * blockalign;
        let mut silence_sync = SilenceSyncTracker::new(Instant::now());
        let mut total_frames_sent: u64 = 0;

        while !stop_signal.load(Ordering::Relaxed) {
            let mut read_error = false;
            while !stop_signal.load(Ordering::Relaxed) {
                match capture_client.get_next_packet_size() {
                    Ok(Some(new_frames)) if new_frames > 0 => {
                        let additional = (new_frames as usize * blockalign)
                            .saturating_sub(sample_queue.capacity() - sample_queue.len());
                        sample_queue.reserve(additional);

                        if capture_client
                            .read_from_device_to_deque(&mut sample_queue)
                            .is_err()
                        {
                            eprintln!("[WASAPI] Read device error");
                            read_error = true;
                            break;
                        }
                    }
                    Ok(_) => break,
                    Err(_) => {
                        eprintln!("[WASAPI] get_next_packet_size error");
                        read_error = true;
                        break;
                    }
                }
            }

            if read_error || stop_signal.load(Ordering::Relaxed) {
                break;
            }

            let dropped_frames = trim_sample_queue_excess(&mut sample_queue, MAX_QUEUED_FRAMES, blockalign);
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
                Instant::now(),
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

            let _ = h_event.wait_for_event(10);
        }

        let _ = audio_client.stop_stream();
        eprintln!("[WASAPI] Stream finalizado com sucesso para PID {}", pid);
    });

    match ready_rx.await {
        Ok(res) => res,
        Err(_) => Err("Thread de captura de áudio finalizou prematuramente".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        compute_missing_silence_frames, flush_sample_chunks, trim_sample_queue_excess,
        SilenceSyncTracker, CHUNK_FRAMES, MAX_SILENCE_BURST_FRAMES,
    };
    use std::collections::VecDeque;
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
        let burst = tracker.compute_missing_or_resync(
            t0 + Duration::from_millis(120),
            960,
            0,
        );
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
}
