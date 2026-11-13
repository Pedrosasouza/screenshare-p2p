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
        let start_time = Instant::now();
        let mut total_frames_sent: u64 = 0;

        while !stop_signal.load(Ordering::Relaxed) {
            while sample_queue.len() >= chunk_bytes {
                let chunk: Vec<u8> = sample_queue.drain(..chunk_bytes).collect();
                total_frames_sent += CHUNK_FRAMES as u64;
                if audio_tx.blocking_send(chunk).is_err() {
                    stop_signal.store(true, Ordering::Relaxed);
                    break;
                }
            }

            if stop_signal.load(Ordering::Relaxed) {
                break;
            }

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
                        break;
                    }
                }
                Ok(_) => {}
                Err(_) => {
                    eprintln!("[WASAPI] get_next_packet_size error");
                    break;
                }
            }

            let _ = h_event.wait_for_event(10);

            let elapsed_sec = start_time.elapsed().as_secs_f64();
            let expected_frames = (elapsed_sec * SAMPLE_RATE as f64) as u64;
            let current_queued_frames = (sample_queue.len() / blockalign) as u64;

            let missing_frames = compute_missing_silence_frames(
                expected_frames,
                total_frames_sent,
                current_queued_frames,
            );
            if missing_frames > 0 {
                sample_queue.resize(sample_queue.len() + (missing_frames * blockalign), 0);
            }
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
    use super::compute_missing_silence_frames;

    #[test]
    fn synthesizes_missing_silence_up_to_burst_cap() {
        assert_eq!(compute_missing_silence_frames(1000, 400, 120), 480);
        assert_eq!(compute_missing_silence_frames(1000, 900, 200), 0);
        // Overshoot above MAX_SILENCE_BURST_FRAMES (4800) is suppressed to avoid runaway
        assert_eq!(compute_missing_silence_frames(10_000, 0, 0), 0);
    }
}
