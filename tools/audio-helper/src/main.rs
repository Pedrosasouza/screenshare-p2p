use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use wasapi::*;
use windows::core::PWSTR;
use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
};

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    #[arg(short, long, default_value_t = 45454)]
    port: u16,

    #[arg(short, long, default_value = "")]
    token: String,

    #[arg(long, default_value_t = 0)]
    parent_pid: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct WindowInfo {
    pid: u32,
    title: String,
    exe: String,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
enum ClientMessage {
    #[serde(rename = "auth")]
    Auth { token: String },
    #[serde(rename = "list_windows")]
    ListWindows,
    #[serde(rename = "get_discord_status")]
    GetDiscordStatus,
    #[serde(rename = "start_capture")]
    StartCapture {
        pid: u32,
        #[serde(default)]
        exclude: bool,
    },
    #[serde(rename = "start_exclude_discord")]
    StartExcludeDiscord,
    #[serde(rename = "stop_capture")]
    StopCapture,
    #[serde(rename = "shutdown")]
    Shutdown,
    #[serde(rename = "ping")]
    Ping,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
enum ServerMessage {
    #[serde(rename = "auth_ok")]
    AuthOk,
    #[serde(rename = "auth_failed")]
    AuthFailed { error: String },
    #[serde(rename = "windows_list")]
    WindowsList { windows: Vec<WindowInfo> },
    #[serde(rename = "discord_status")]
    DiscordStatus {
        detected: bool,
        pid: u32,
        name: String,
    },
    #[serde(rename = "capture_started")]
    CaptureStarted {
        pid: u32,
        sample_rate: u32,
        channels: u16,
        format: String,
        mode: String, // "include" ou "exclude"
    },
    #[serde(rename = "capture_stopped")]
    CaptureStopped,
    #[serde(rename = "error")]
    Error { message: String },
    #[serde(rename = "pong")]
    Pong,
}

// Watch parent process and exit when parent dies
fn spawn_parent_watcher(parent_pid: u32) {
    if parent_pid == 0 {
        return;
    }
    std::thread::spawn(move || {
        unsafe {
            // Tentativa 1: Aguarda via WaitForSingleObject se conseguir SYNCHRONIZE
            if let Ok(handle) = OpenProcess(PROCESS_SYNCHRONIZE, false, parent_pid) {
                let _ = windows::Win32::System::Threading::WaitForSingleObject(
                    handle,
                    windows::Win32::System::Threading::INFINITE,
                );
                let _ = windows::Win32::Foundation::CloseHandle(handle);
            } else {
                // Tentativa 2: Fallback com polling rápido (300ms) via PROCESS_QUERY_LIMITED_INFORMATION
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, parent_pid) {
                        Ok(handle) => {
                            let mut exit_code: u32 = 0;
                            let res = windows::Win32::System::Threading::GetExitCodeProcess(handle, &mut exit_code);
                            let _ = windows::Win32::Foundation::CloseHandle(handle);
                            if res.is_err() || exit_code != 259 /* STILL_ACTIVE */ {
                                break;
                            }
                        }
                        Err(_) => {
                            // Se nem sequer puder abrir o processo, ele encerrou
                            break;
                        }
                    }
                }
            }
        }
        eprintln!("[Helper] Processo pai encerrou. Finalizando streamgrid-audio-helper.");
        std::process::exit(0);
    });
}

// Find Discord root process (for exclusion mode)
fn find_discord_root_pid() -> Option<u32> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };

        let mut discord_procs: Vec<(u32, u32)> = Vec::new(); // (pid, parent_pid)

        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let name = String::from_utf16_lossy(&entry.szExeFile)
                    .trim_matches(char::from(0))
                    .to_lowercase();

                if name == "discord.exe" || name == "discordcanary.exe" || name == "discordptb.exe" {
                    discord_procs.push((entry.th32ProcessID, entry.th32ParentProcessID));
                }

                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = windows::Win32::Foundation::CloseHandle(snapshot);

        if discord_procs.is_empty() {
            return None;
        }

        // Find the root Discord process: parent is not another Discord process
        let pids: HashSet<u32> = discord_procs.iter().map(|(p, _)| *p).collect();
        for (pid, parent_pid) in &discord_procs {
            if !pids.contains(parent_pid) {
                return Some(*pid);
            }
        }

        Some(discord_procs[0].0)
    }
}

// Enumerate applications via both visible windows and active WASAPI audio sessions
fn list_application_windows(parent_pid: u32) -> Vec<WindowInfo> {
    let _ = initialize_mta();

    struct EnumState {
        my_pid: u32,
        parent_pid: u32,
        windows: Vec<WindowInfo>,
    }

    let my_pid = unsafe { GetCurrentProcessId() };

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state = &mut *(lparam.0 as *mut EnumState);

        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }

        let len = GetWindowTextLengthW(hwnd);
        if len == 0 {
            return BOOL(1);
        }

        let mut title_buf = vec![0u16; (len + 1) as usize];
        let read = GetWindowTextW(hwnd, &mut title_buf);
        if read == 0 {
            return BOOL(1);
        }
        let title = String::from_utf16_lossy(&title_buf[..read as usize])
            .trim()
            .to_string();
        if title.is_empty() {
            return BOOL(1);
        }

        // Filter out Windows shell components
        if title == "Program Manager"
            || title == "Windows Shell Experience Host"
            || title == "Settings"
        {
            return BOOL(1);
        }

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 || pid == state.my_pid || pid == state.parent_pid {
            return BOOL(1);
        }

        if state.windows.iter().any(|w| w.pid == pid) {
            return BOOL(1);
        }

        let mut exe_name = String::new();
        if let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            let mut path_buf = vec![0u16; 1024];
            let mut size = path_buf.len() as u32;
            if QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                PWSTR(path_buf.as_mut_ptr()),
                &mut size,
            )
            .is_ok()
            {
                let full_path = String::from_utf16_lossy(&path_buf[..size as usize]);
                if let Some(file_name) = Path::new(&full_path).file_name() {
                    exe_name = file_name.to_string_lossy().to_string();
                }
            }
            let _ = windows::Win32::Foundation::CloseHandle(handle);
        }

        // Filter out StreamGrid and WebView2 subprocesses
        let exe_lower = exe_name.to_lowercase();
        if exe_lower.contains("streamgrid")
            || exe_lower.contains("msedgewebview2")
            || exe_lower.contains("neutralino")
        {
            return BOOL(1);
        }

        state.windows.push(WindowInfo {
            pid,
            title,
            exe: exe_name,
        });

        BOOL(1)
    }

    let mut state = EnumState {
        my_pid,
        parent_pid,
        windows: Vec::new(),
    };

    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut state as *mut _ as isize));
    }

    // Also scan active WASAPI audio sessions to include active players/apps
    if let Ok(enumerator) = DeviceEnumerator::new() {
        if let Ok(collection) = enumerator.get_device_collection(&Direction::Render) {
            for device in &collection {
                if let Ok(dev) = device {
                    if let Ok(manager) = dev.get_iaudiosessionmanager() {
                        if let Ok(sessions) = manager.get_audiosessionenumerator() {
                            let count = sessions.get_count().unwrap_or(0);
                            for i in 0..count {
                                if let Ok(control) = sessions.get_session(i) {
                                    if let Ok(session_pid) = control.get_process_id() {
                                        if session_pid == 0
                                            || session_pid == my_pid
                                            || session_pid == parent_pid
                                        {
                                            continue;
                                        }

                                        if !state.windows.iter().any(|w| w.pid == session_pid) {
                                            let mut exe_name = String::new();
                                            unsafe {
                                                if let Ok(handle) = OpenProcess(
                                                    PROCESS_QUERY_LIMITED_INFORMATION,
                                                    false,
                                                    session_pid,
                                                ) {
                                                    let mut path_buf = vec![0u16; 1024];
                                                    let mut size = path_buf.len() as u32;
                                                    if QueryFullProcessImageNameW(
                                                        handle,
                                                        PROCESS_NAME_WIN32,
                                                        PWSTR(path_buf.as_mut_ptr()),
                                                        &mut size,
                                                    )
                                                    .is_ok()
                                                    {
                                                        let full_path = String::from_utf16_lossy(
                                                            &path_buf[..size as usize],
                                                        );
                                                        if let Some(file_name) =
                                                            Path::new(&full_path).file_name()
                                                        {
                                                            exe_name = file_name
                                                                .to_string_lossy()
                                                                .to_string();
                                                        }
                                                    }
                                                    let _ = windows::Win32::Foundation::CloseHandle(
                                                        handle,
                                                    );
                                                }
                                            }

                                            let exe_lower = exe_name.to_lowercase();
                                            if exe_lower.contains("streamgrid")
                                                || exe_lower.contains("msedgewebview2")
                                                || exe_lower.contains("neutralino")
                                            {
                                                continue;
                                            }

                                            let title = if !exe_name.is_empty() {
                                                format!("App de Áudio: {}", exe_name)
                                            } else {
                                                format!("Processo de Áudio (PID {})", session_pid)
                                            };

                                            state.windows.push(WindowInfo {
                                                pid: session_pid,
                                                title,
                                                exe: exe_name,
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    state.windows
}

// Audio capture worker thread running inside dedicated COM apartment
// include_tree: true = INCLUDE mode (captures ONLY this process tree)
// include_tree: false = EXCLUDE mode (captures entire system EXCEPT this process tree!)
async fn start_wasapi_capture(
    pid: u32,
    include_tree: bool,
    audio_tx: mpsc::Sender<Vec<u8>>,
    stop_signal: Arc<AtomicBool>,
) -> Result<(u32, u16), String> {
    let (ready_tx, ready_rx) = oneshot::channel();

    std::thread::spawn(move || {
        let _ = initialize_mta();

        // Standard 32-bit float stereo @ 48kHz
        let desired_format = WaveFormat::new(32, 32, &SampleType::Float, 48000, 2, None);
        let blockalign = desired_format.get_blockalign() as usize;
        let autoconvert = true;

        let mut audio_client = match AudioClient::new_application_loopback_client(pid, include_tree) {
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

        if let Err(e) = audio_client.initialize_client(&desired_format, &Direction::Capture, &mode) {
            let _ = ready_tx.send(Err(format!("Falha ao inicializar cliente WASAPI: {:?}", e)));
            return;
        }

        let h_event = match audio_client.set_get_eventhandle() {
            Ok(h) => h,
            Err(e) => {
                let _ = ready_tx.send(Err(format!("Falha ao obter evento de sincronia: {:?}", e)));
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

        // Notify caller that audio capture initialized successfully
        let _ = ready_tx.send(Ok((48000, 2)));

        let mut sample_queue: VecDeque<u8> = VecDeque::new();
        let chunk_frames = 480; // 10ms of audio (480 frames * 8 bytes = 3840 bytes)
        let chunk_bytes = chunk_frames * blockalign;

        // Real-time clock pacing: guarantees exact 48kHz output without drift or audio glitch
        let start_time = Instant::now();
        let mut total_frames_sent: u64 = 0;

        while !stop_signal.load(Ordering::Relaxed) {
            // Send available full 10ms chunks
            while sample_queue.len() >= chunk_bytes {
                let chunk: Vec<u8> = sample_queue.drain(..chunk_bytes).collect();
                total_frames_sent += chunk_frames as u64;
                if audio_tx.blocking_send(chunk).is_err() {
                    break;
                }
            }

            match capture_client.get_next_packet_size() {
                Ok(Some(new_frames)) if new_frames > 0 => {
                    let additional = (new_frames as usize * blockalign)
                        .saturating_sub(sample_queue.capacity() - sample_queue.len());
                    sample_queue.reserve(additional);

                    if let Err(_) = capture_client.read_from_device_to_deque(&mut sample_queue) {
                        eprintln!("[WASAPI] Read device error");
                        break;
                    }
                }
                Ok(_) => {
                    // Packet size was 0 or None (waiting for data)
                }
                Err(_) => {
                    eprintln!("[WASAPI] get_next_packet_size error");
                    break;
                }
            }

            // Wait for event with a 10ms timeout
            let _ = h_event.wait_for_event(10);

            // Real-time clock generator: if game is silent or paused, synthesize exact silence frames
            let elapsed_sec = start_time.elapsed().as_secs_f64();
            let expected_frames = (elapsed_sec * 48000.0) as u64;
            let current_queued_frames = (sample_queue.len() / blockalign) as u64;

            if total_frames_sent + current_queued_frames < expected_frames {
                let missing_frames = (expected_frames - (total_frames_sent + current_queued_frames)) as usize;
                if missing_frames > 0 && missing_frames <= 4800 { // Max 100ms burst to prevent runaway
                    sample_queue.resize(sample_queue.len() + (missing_frames * blockalign), 0);
                }
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

#[tokio::main]
async fn main() {
    let args = Args::parse();
    spawn_parent_watcher(args.parent_pid);

    let listener = match TcpListener::bind(format!("127.0.0.1:{}", args.port)).await {
        Ok(l) => l,
        Err(_) => {
            // Exit cleanly with pure ASCII so Neutralino's JSON parser never crashes on Windows localized CP850 stderr
            println!("STREAMGRID_AUDIO_HELPER_ALREADY_RUNNING");
            return;
        }
    };

    if args.token.trim().is_empty() {
        eprintln!("[Helper Security] ERRO CRÍTICO: O parâmetro --token é obrigatório.");
        std::process::exit(1);
    }

    if let Ok(local_addr) = listener.local_addr() {
        println!("STREAMGRID_AUDIO_HELPER_PORT={}", local_addr.port());
    }
    println!("STREAMGRID_AUDIO_HELPER_READY");

    let required_token = Arc::new(args.token);
    let parent_pid = args.parent_pid;
    let active_connections = Arc::new(std::sync::atomic::AtomicUsize::new(0));

    // Watchdog: Encerra o helper apos 2.5s se a conexao com StreamGrid cair
    let active_conns_watchdog = active_connections.clone();
    tokio::spawn(async move {
        let mut had_connection = false;
        let mut grace_start: Option<Instant> = None;
        let startup_time = Instant::now();
        loop {
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            let count = active_conns_watchdog.load(Ordering::Relaxed);
            if count > 0 {
                had_connection = true;
                grace_start = None;
            } else if had_connection {
                let elapsed = grace_start.get_or_insert_with(Instant::now).elapsed();
                if elapsed > tokio::time::Duration::from_millis(2500) {
                    eprintln!("[Helper Watchdog] StreamGrid fechado. Encerrando helper.");
                    std::process::exit(0);
                }
            } else if startup_time.elapsed() > tokio::time::Duration::from_secs(30) {
                std::process::exit(0);
            }
        }
    });

    while let Ok((stream, _)) = listener.accept().await {
        let token = required_token.clone();
        let conn_counter = active_connections.clone();
        tokio::spawn(async move {
            conn_counter.fetch_add(1, Ordering::Relaxed);
            let _ = handle_client(stream, token, parent_pid).await;
            conn_counter.fetch_sub(1, Ordering::Relaxed);
        });
    }
}

fn is_allowed_origin(origin: &str) -> bool {
    let lower = origin.trim().to_lowercase();
    lower.starts_with("http://localhost:") || lower == "http://localhost"
        || lower.starts_with("https://localhost:") || lower == "https://localhost"
        || lower.starts_with("http://127.0.0.1:") || lower == "http://127.0.0.1"
        || lower.starts_with("https://127.0.0.1:") || lower == "https://127.0.0.1"
        || lower.starts_with("neutralino://")
}

async fn handle_client(
    stream: TcpStream,
    required_token: Arc<String>,
    parent_pid: u32,
) -> Result<(), Box<dyn std::error::Error>> {
    let callback = |req: &tokio_tungstenite::tungstenite::handshake::server::Request,
                    response: tokio_tungstenite::tungstenite::handshake::server::Response| {
        if let Some(origin_header) = req.headers().get("Origin") {
            if let Ok(origin_str) = origin_header.to_str() {
                if !is_allowed_origin(origin_str) {
                    eprintln!("[Helper Security] Rejeitando conexão WebSocket com Origin não autorizado: {}", origin_str);
                    let mut err_response = tokio_tungstenite::tungstenite::handshake::server::ErrorResponse::new(Some("Forbidden Origin".into()));
                    *err_response.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN;
                    return Err(err_response);
                }
            } else {
                let mut err_response = tokio_tungstenite::tungstenite::handshake::server::ErrorResponse::new(Some("Invalid Origin Header".into()));
                *err_response.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::BAD_REQUEST;
                return Err(err_response);
            }
        }
        Ok(response)
    };

    let mut ws = tokio_tungstenite::accept_hdr_async(stream, callback).await?;
    let mut authenticated = false;

    let mut capture_stop_signal: Option<Arc<AtomicBool>> = None;
    let (audio_tx, mut audio_rx) = mpsc::channel::<Vec<u8>>(100);

    loop {
        tokio::select! {
            // Forward captured PCM binary chunks to WebSocket
            Some(pcm_data) = audio_rx.recv() => {
                if ws.send(Message::Binary(pcm_data)).await.is_err() {
                    break;
                }
            }

            // Receive messages from WebSocket client
            msg = ws.next() => {
                let msg = match msg {
                    Some(Ok(m)) => m,
                    _ => break,
                };

                if let Message::Text(text) = msg {
                    let client_msg: ClientMessage = match serde_json::from_str(&text) {
                        Ok(m) => m,
                        Err(e) => {
                            let _ = ws.send(Message::Text(serde_json::to_string(&ServerMessage::Error {
                                message: format!("JSON inválido: {}", e)
                            })?)).await;
                            continue;
                        }
                    };

                    match client_msg {
                        ClientMessage::Auth { token } => {
                            if !required_token.is_empty() && *required_token == token {
                                authenticated = true;
                                let _ = ws.send(Message::Text(serde_json::to_string(&ServerMessage::AuthOk)?)).await;
                            } else {
                                let _ = ws.send(Message::Text(serde_json::to_string(&ServerMessage::AuthFailed {
                                    error: "Token de segurança inválido".into()
                                })?)).await;
                                break;
                            }
                        }
                        _ if !authenticated => {
                            let _ = ws.send(Message::Text(serde_json::to_string(&ServerMessage::AuthFailed {
                                error: "Autenticação requerida".into()
                            })?)).await;
                            break;
                        }
                        ClientMessage::ListWindows => {
                            let windows = list_application_windows(parent_pid);
                            let _ = ws.send(Message::Text(serde_json::to_string(&ServerMessage::WindowsList { windows })?)).await;
                        }
                        ClientMessage::GetDiscordStatus => {
                            let discord_pid = find_discord_root_pid();
                            let _ = ws.send(Message::Text(serde_json::to_string(&ServerMessage::DiscordStatus {
                                detected: discord_pid.is_some(),
                                pid: discord_pid.unwrap_or(0),
                                name: "Discord Desktop".into(),
                            })?)).await;
                        }
                        ClientMessage::StartCapture { pid, exclude } => {
                            if let Some(stop) = capture_stop_signal.take() {
                                stop.store(true, Ordering::Relaxed);
                            }

                            let stop = Arc::new(AtomicBool::new(false));
                            capture_stop_signal = Some(stop.clone());

                            // include_tree: true = INCLUDE (captures only target)
                            // include_tree: false = EXCLUDE (captures system except target)
                            let include_tree = !exclude;
                            let mode_str = if exclude { "exclude" } else { "include" };

                            match start_wasapi_capture(pid, include_tree, audio_tx.clone(), stop).await {
                                Ok((sample_rate, channels)) => {
                                    let _ = ws.send(Message::Text(serde_json::to_string(&ServerMessage::CaptureStarted {
                                        pid,
                                        sample_rate,
                                        channels,
                                        format: "f32le".into(),
                                        mode: mode_str.into(),
                                    })?)).await;
                                }
                                Err(err) => {
                                    let _ = ws.send(Message::Text(serde_json::to_string(&ServerMessage::Error {
                                        message: err
                                    })?)).await;
                                }
                            }
                        }
                        ClientMessage::StartExcludeDiscord => {
                            let discord_pid = find_discord_root_pid();
                            match discord_pid {
                                Some(pid) => {
                                    if let Some(stop) = capture_stop_signal.take() {
                                        stop.store(true, Ordering::Relaxed);
                                    }

                                    let stop = Arc::new(AtomicBool::new(false));
                                    capture_stop_signal = Some(stop.clone());

                                    // false = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
                                    match start_wasapi_capture(pid, false, audio_tx.clone(), stop).await {
                                        Ok((sample_rate, channels)) => {
                                            let _ = ws.send(Message::Text(serde_json::to_string(&ServerMessage::CaptureStarted {
                                                pid,
                                                sample_rate,
                                                channels,
                                                format: "f32le".into(),
                                                mode: "exclude".into(),
                                            })?)).await;
                                        }
                                        Err(err) => {
                                            let _ = ws.send(Message::Text(serde_json::to_string(&ServerMessage::Error {
                                                message: err
                                            })?)).await;
                                        }
                                    }
                                }
                                None => {
                                    let _ = ws.send(Message::Text(serde_json::to_string(&ServerMessage::Error {
                                        message: "O Discord não foi encontrado em execução no Windows.".into()
                                    })?)).await;
                                }
                            }
                        }
                        ClientMessage::StopCapture => {
                            if let Some(stop) = capture_stop_signal.take() {
                                stop.store(true, Ordering::Relaxed);
                            }
                            let _ = ws.send(Message::Text(serde_json::to_string(&ServerMessage::CaptureStopped)?)).await;
                        }
                        ClientMessage::Shutdown => {
                            eprintln!("[Helper] Comando de shutdown recebido via WebSocket. Encerrando processo.");
                            if let Some(stop) = capture_stop_signal.take() {
                                stop.store(true, Ordering::Relaxed);
                            }
                            std::process::exit(0);
                        }
                        ClientMessage::Ping => {
                            let _ = ws.send(Message::Text(serde_json::to_string(&ServerMessage::Pong)?)).await;
                        }
                    }
                }
            }
        }
    }

    if let Some(stop) = capture_stop_signal {
        stop.store(true, Ordering::Relaxed);
    }

    Ok(())
}
