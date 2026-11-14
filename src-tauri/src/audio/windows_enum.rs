use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use wasapi::{initialize_mta, DeviceEnumerator, Direction};
use windows::core::PWSTR;
use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct WindowInfo {
    pub pid: u32,
    pub title: String,
    pub exe: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct DiscordStatus {
    pub detected: bool,
    pub pid: u32,
    pub name: String,
}

/// Determina se um executável deve ser omitido da lista de captura (StreamGrid / WebView2 / shell).
pub fn should_exclude_process_exe(exe_name: &str) -> bool {
    let lower = exe_name.trim().to_lowercase();
    lower.contains("streamgrid") || lower.contains("msedgewebview2") || lower.contains("neutralino")
}

/// Seleciona o processo raiz do Discord cujo processo pai não é outro processo do Discord,
/// priorizando o candidato que comanda a maior subárvore ativa (evita órfãos sem filhos).
pub fn select_discord_root_pid(discord_procs: &[(u32, u32)]) -> Option<u32> {
    if discord_procs.is_empty() {
        return None;
    }

    let pids: HashSet<u32> = discord_procs.iter().map(|(pid, _)| *pid).collect();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for &(pid, parent_pid) in discord_procs {
        children.entry(parent_pid).or_default().push(pid);
    }

    let mut best_root: Option<(u32, usize)> = None;
    for &(pid, parent_pid) in discord_procs {
        if pids.contains(&parent_pid) {
            continue;
        }
        let mut subtree_size = 0usize;
        let mut stack = vec![pid];
        let mut visited = HashSet::new();
        while let Some(curr) = stack.pop() {
            if !visited.insert(curr) {
                continue;
            }
            subtree_size += 1;
            if let Some(child_pids) = children.get(&curr) {
                stack.extend(child_pids.iter().copied());
            }
        }
        if best_root.is_none_or(|(_, best_size)| subtree_size > best_size) {
            best_root = Some((pid, subtree_size));
        }
    }

    best_root
        .map(|(pid, _)| pid)
        .or_else(|| Some(discord_procs[0].0))
}

/// Decodifica um buffer UTF-16 terminando no primeiro caractere NUL (`\0`), ignorando lixo residual.
pub fn decode_utf16_nul_terminated(slice: &[u16]) -> String {
    let nul_pos = slice.iter().position(|&c| c == 0).unwrap_or(slice.len());
    String::from_utf16_lossy(&slice[..nul_pos])
}

/// Limita o tamanho retornado por `GetWindowTextLengthW` (rejeita valores `<= 0` e limita a 4096 chars).
pub fn bounded_window_text_len(raw_len: i32) -> Option<usize> {
    if raw_len <= 0 {
        None
    } else {
        Some((raw_len as usize).min(4096))
    }
}

fn query_process_exe_name(pid: u32) -> String {
    let mut exe_name = String::new();
    unsafe {
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
    }
    exe_name
}

/// Localiza o PID raiz do Discord Desktop (para modo de exclusão de árvore de processos).
pub fn find_discord_root_pid() -> Option<u32> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };

        let mut discord_procs: Vec<(u32, u32)> = Vec::new();

        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let name = decode_utf16_nul_terminated(&entry.szExeFile).to_lowercase();

                if name == "discord.exe" || name == "discordcanary.exe" || name == "discordptb.exe"
                {
                    discord_procs.push((entry.th32ProcessID, entry.th32ParentProcessID));
                }

                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = windows::Win32::Foundation::CloseHandle(snapshot);

        select_discord_root_pid(&discord_procs)
    }
}

pub fn get_discord_status() -> DiscordStatus {
    let discord_pid = find_discord_root_pid();
    DiscordStatus {
        detected: discord_pid.is_some(),
        pid: discord_pid.unwrap_or(0),
        name: "Discord Desktop".to_string(),
    }
}

/// Enumera aplicativos por janelas visíveis e sessões ativas de áudio WASAPI.
pub fn list_application_windows() -> Vec<WindowInfo> {
    let _ = initialize_mta();

    struct EnumState {
        my_pid: u32,
        windows: Vec<WindowInfo>,
    }

    let my_pid = unsafe { GetCurrentProcessId() };

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let state = &mut *(lparam.0 as *mut EnumState);

            if !IsWindowVisible(hwnd).as_bool() {
                return BOOL(1);
            }

            let Some(max_chars) = bounded_window_text_len(GetWindowTextLengthW(hwnd)) else {
                return BOOL(1);
            };

            let mut title_buf = vec![0u16; max_chars + 1];
            let read = GetWindowTextW(hwnd, &mut title_buf);
            if read <= 0 {
                return BOOL(1);
            }
            let valid_read = (read as usize).min(title_buf.len());
            let title = String::from_utf16_lossy(&title_buf[..valid_read])
                .trim()
                .to_string();
            if title.is_empty() {
                return BOOL(1);
            }

            if title == "Program Manager"
                || title == "Windows Shell Experience Host"
                || title == "Settings"
            {
                return BOOL(1);
            }

            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 || pid == state.my_pid {
                return BOOL(1);
            }

            if state.windows.iter().any(|w| w.pid == pid) {
                return BOOL(1);
            }

            let exe_name = query_process_exe_name(pid);
            if should_exclude_process_exe(&exe_name) {
                return BOOL(1);
            }

            state.windows.push(WindowInfo {
                pid,
                title,
                exe: exe_name,
            });

            BOOL(1)
        }))
        .unwrap_or(BOOL(1))
    }

    let mut state = EnumState {
        my_pid,
        windows: Vec::new(),
    };

    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut state as *mut _ as isize));
    }

    if let Ok(enumerator) = DeviceEnumerator::new() {
        if let Ok(collection) = enumerator.get_device_collection(&Direction::Render) {
            for dev in (&collection).into_iter().flatten() {
                if let Ok(manager) = dev.get_iaudiosessionmanager() {
                    if let Ok(sessions) = manager.get_audiosessionenumerator() {
                        let count = sessions.get_count().unwrap_or(0);
                        for i in 0..count {
                            if let Ok(control) = sessions.get_session(i) {
                                if let Ok(session_pid) = control.get_process_id() {
                                    if session_pid == 0 || session_pid == my_pid {
                                        continue;
                                    }

                                    if !state.windows.iter().any(|w| w.pid == session_pid) {
                                        let exe_name = query_process_exe_name(session_pid);
                                        if should_exclude_process_exe(&exe_name) {
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

    state.windows
}

#[cfg(test)]
mod tests {
    use super::{
        bounded_window_text_len, decode_utf16_nul_terminated, select_discord_root_pid,
        should_exclude_process_exe,
    };

    #[test]
    fn selects_root_discord_process_whose_parent_is_not_discord() {
        let procs = vec![(102, 100), (100, 1), (103, 102)];
        assert_eq!(select_discord_root_pid(&procs), Some(100));
        assert_eq!(select_discord_root_pid(&[]), None);
    }

    #[test]
    fn falls_back_to_first_discord_pid_when_cycle_exists() {
        let procs = vec![(200, 201), (201, 200)];
        assert_eq!(select_discord_root_pid(&procs), Some(200));
    }

    #[test]
    fn excludes_streamgrid_and_webview2_processes() {
        assert!(should_exclude_process_exe("StreamGrid.exe"));
        assert!(should_exclude_process_exe("msedgewebview2.exe"));
        assert!(should_exclude_process_exe("neutralino-win_x64.exe"));
        assert!(!should_exclude_process_exe("spotify.exe"));
        assert!(!should_exclude_process_exe("Discord.exe"));
    }

    #[test]
    fn decode_utf16_nul_terminated_ignores_trailing_garbage_after_first_nul() {
        let mut buf: Vec<u16> = "Discord.exe".encode_utf16().collect();
        buf.push(0);
        buf.extend("old_process_name.exe\0\0".encode_utf16());
        assert_eq!(decode_utf16_nul_terminated(&buf), "Discord.exe");

        assert_eq!(decode_utf16_nul_terminated(&[]), "");
        let no_nul: Vec<u16> = "spotify.exe".encode_utf16().collect();
        assert_eq!(decode_utf16_nul_terminated(&no_nul), "spotify.exe");
    }

    #[test]
    fn bounded_window_text_len_guards_negative_zero_and_oversized_lengths() {
        assert_eq!(bounded_window_text_len(-1), None);
        assert_eq!(bounded_window_text_len(0), None);
        assert_eq!(bounded_window_text_len(42), Some(42));
        assert_eq!(bounded_window_text_len(i32::MAX), Some(4096));
    }

    #[test]
    fn selects_root_with_largest_subtree_ignoring_orphan_discord_process() {
        let procs = vec![(999, 1), (102, 100), (100, 1), (103, 102)];
        assert_eq!(select_discord_root_pid(&procs), Some(100));
    }
}
