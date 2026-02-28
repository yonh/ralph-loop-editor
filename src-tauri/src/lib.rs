use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

/// Runtime session for one active loop process.
struct LoopSession {
    pid: Option<u32>,
    child: Box<dyn portable_pty::Child + Send>,
    writer: Box<dyn Write + Send>,
    pty_master: Box<dyn portable_pty::MasterPty + Send>,
}

static LOOP_STATE: Mutex<Option<LoopSession>> = Mutex::new(None);
static ENABLED_STATE: Mutex<bool> = Mutex::new(false);
static OUTPUT_BUFFER: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

/// Maximum number of chunks kept in the in-memory output buffer.
const OUTPUT_BUFFER_LIMIT: usize = 2_000;

/// Default task prompt used when the UI does not provide one.
const DEFAULT_PROMPT: &str = "创建一个优秀的团队来实践工作，阅读 任务目标.md 实现工作，每一个小迭代完毕需要提交代码，持续迭代持续总结经验";

/// Default max iterations for one loop run.
const DEFAULT_MAX_ITERATIONS: u32 = 20;

#[derive(serde::Serialize)]
/// Snapshot of backend runtime state for diagnostics.
struct RuntimeDebugState {
    enabled: bool,
    loop_running: bool,
    loop_pid: Option<u32>,
}

/// Pushes a chunk into the output buffer and trims old entries.
fn push_output_chunk(chunk: String) {
    match OUTPUT_BUFFER.lock() {
        Ok(mut buffer) => {
            buffer.push_back(chunk);
            while buffer.len() > OUTPUT_BUFFER_LIMIT {
                let _ = buffer.pop_front();
            }
        }
        Err(err) => {
            log::error!("[push_output_chunk] failed to lock OUTPUT_BUFFER: {}", err);
        }
    }
}

/// Clears the active session when the given pid matches current runtime pid.
fn clear_loop_state_for_pid(pid: Option<u32>) {
    match LOOP_STATE.lock() {
        Ok(mut state) => {
            let should_clear = state
                .as_ref()
                .map(|session| session.pid == pid)
                .unwrap_or(false);
            if should_clear {
                *state = None;
                log::info!("[clear_loop_state_for_pid] cleared session for pid={:?}", pid);
            }
        }
        Err(err) => {
            log::error!(
                "[clear_loop_state_for_pid] failed to lock LOOP_STATE for pid={:?}: {}",
                pid,
                err
            );
        }
    }
}

/// Starts a background reader thread for process output.
fn spawn_output_reader(mut reader: Box<dyn Read + Send>, pid: Option<u32>) {
    thread::spawn(move || {
        let mut buf = [0u8; 2048];
        let mut pending_bytes: Vec<u8> = Vec::new();

        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    if !pending_bytes.is_empty() {
                        let flushed = String::from_utf8_lossy(&pending_bytes).to_string();
                        push_output_chunk(flushed);
                        pending_bytes.clear();
                    }
                    push_output_chunk("\n[system] loop process output stream closed.\n".to_string());
                    clear_loop_state_for_pid(pid);
                    break;
                }
                Ok(size) => {
                    pending_bytes.extend_from_slice(&buf[..size]);

                    loop {
                        match std::str::from_utf8(&pending_bytes) {
                            Ok(text) => {
                                if !text.is_empty() {
                                    push_output_chunk(text.to_string());
                                }
                                pending_bytes.clear();
                                break;
                            }
                            Err(err) => {
                                let valid_up_to = err.valid_up_to();
                                if valid_up_to > 0 {
                                    let valid_text =
                                        String::from_utf8_lossy(&pending_bytes[..valid_up_to]).to_string();
                                    push_output_chunk(valid_text);
                                    pending_bytes.drain(..valid_up_to);
                                }

                                if let Some(error_len) = err.error_len() {
                                    let remove_len = error_len.min(pending_bytes.len());
                                    pending_bytes.drain(..remove_len);
                                    push_output_chunk(
                                        "\n[system] skipped undecodable output bytes.\n".to_string(),
                                    );
                                    continue;
                                }

                                // Incomplete UTF-8 sequence at the end; wait for more bytes.
                                break;
                            }
                        }
                    }
                }
                Err(err) => {
                    push_output_chunk(format!("\n[system] output read error: {}\n", err));
                    clear_loop_state_for_pid(pid);
                    break;
                }
            }
        }
    });
}

#[tauri::command]
/// Returns whether the app is enabled.
fn get_enabled() -> Result<bool, String> {
    match ENABLED_STATE.lock() {
        Ok(state) => {
            let value = *state;
            log::info!("[get_enabled] returning enabled={}", value);
            Ok(value)
        }
        Err(err) => {
            log::error!("[get_enabled] failed to lock ENABLED_STATE: {}", err);
            Err(format!("Failed to read enabled state: {}", err))
        }
    }
}

#[tauri::command]
/// Updates and returns the enabled flag.
fn set_enabled(enabled: bool) -> Result<bool, String> {
    match ENABLED_STATE.lock() {
        Ok(mut state) => {
            let previous = *state;
            *state = enabled;
            log::info!(
                "[set_enabled] changed enabled from {} to {}",
                previous,
                enabled
            );
            Ok(enabled)
        }
        Err(err) => {
            log::error!("[set_enabled] failed to lock ENABLED_STATE: {}", err);
            Err(format!("Failed to update enabled state: {}", err))
        }
    }
}

#[tauri::command]
/// Returns a backend state snapshot to help diagnose UI/command issues.
fn get_runtime_debug_state() -> Result<RuntimeDebugState, String> {
    let enabled = ENABLED_STATE.lock().map_err(|err| {
        log::error!(
            "[get_runtime_debug_state] failed to lock ENABLED_STATE: {}",
            err
        );
        format!("Failed to read enabled state: {}", err)
    })?;

    let loop_state = LOOP_STATE.lock().map_err(|err| {
        log::error!(
            "[get_runtime_debug_state] failed to lock LOOP_STATE: {}",
            err
        );
        format!("Failed to read loop state: {}", err)
    })?;

    Ok(RuntimeDebugState {
        enabled: *enabled,
        loop_running: loop_state.is_some(),
        loop_pid: loop_state.as_ref().and_then(|session| session.pid),
    })
}

#[tauri::command]
/// Drains and returns current buffered output chunks from the process.
fn poll_loop_output() -> Result<Vec<String>, String> {
    let mut buffer = OUTPUT_BUFFER.lock().map_err(|err| {
        log::error!("[poll_loop_output] failed to lock OUTPUT_BUFFER: {}", err);
        format!("Failed to read output buffer: {}", err)
    })?;

    Ok(buffer.drain(..).collect())
}

#[tauri::command]
/// Sends user input to the running loop process.
fn send_loop_input(input: String, append_newline: Option<bool>) -> Result<String, String> {
    let mut state = LOOP_STATE.lock().map_err(|err| {
        log::error!("[send_loop_input] failed to lock LOOP_STATE: {}", err);
        format!("Failed to access loop state: {}", err)
    })?;

    let session = state
        .as_mut()
        .ok_or_else(|| "No loop process is running".to_string())?;

    let payload = if append_newline.unwrap_or(true) {
        format!("{}\n", input)
    } else {
        input
    };

    session.writer.write_all(payload.as_bytes()).map_err(|err| {
        log::error!("[send_loop_input] failed to write to process stdin: {}", err);
        format!("Failed to send input: {}", err)
    })?;

    session.writer.flush().map_err(|err| {
        log::error!("[send_loop_input] failed to flush process stdin: {}", err);
        format!("Failed to flush input: {}", err)
    })?;

    Ok("Input sent".to_string())
}

#[tauri::command]
/// Resizes the PTY of the running loop process.
fn resize_pty(cols: u16, rows: u16) -> Result<String, String> {
    log::info!("[resize_pty] called with cols={}, rows={}", cols, rows);
    
    let mut state = LOOP_STATE.lock().map_err(|err| {
        log::error!("[resize_pty] failed to lock LOOP_STATE: {}", err);
        format!("Failed to access loop state: {}", err)
    })?;

    let session = state
        .as_mut()
        .ok_or_else(|| "No loop process is running".to_string())?;

    // Resize the PTY
    session.pty_master.resize(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }).map_err(|err| {
        log::error!("[resize_pty] failed to resize PTY: {}", err);
        format!("Failed to resize PTY: {}", err)
    })?;

    log::info!("[resize_pty] PTY resized successfully to {}x{}", cols, rows);
    Ok(format!("PTY resized to {}x{}", cols, rows))
}

#[tauri::command]
/// Starts the loop process in the optional working directory.
fn start_loop(work_dir: Option<String>, prompt: Option<String>) -> Result<String, String> {
    log::info!(
        "[start_loop] called with work_dir={:?}, prompt_provided={}",
        work_dir,
        prompt.as_ref().map(|p| !p.trim().is_empty()).unwrap_or(false)
    );

    let enabled = ENABLED_STATE.lock().map_err(|err| {
        log::error!("[start_loop] failed to lock ENABLED_STATE: {}", err);
        format!("Failed to read enabled state: {}", err)
    })?;

    if !*enabled {
        log::warn!("[start_loop] blocked because app is disabled");
        return Err("应用未启用，请先点击启用按钮".to_string());
    }

    let mut state = LOOP_STATE.lock().map_err(|err| {
        log::error!("[start_loop] failed to lock LOOP_STATE: {}", err);
        format!("Failed to access loop state: {}", err)
    })?;

    if state.is_some() {
        log::warn!("[start_loop] ignored because loop is already running");
        return Ok("Loop already running".to_string());
    }

    let task_prompt = prompt.unwrap_or_else(|| DEFAULT_PROMPT.to_string());
    let command_payload = format!(
        "/ralph-loop:ralph-loop \"{}\" --max-iterations {}",
        task_prompt.replace('"', "\\\""),
        DEFAULT_MAX_ITERATIONS
    );

    let mut command = CommandBuilder::new("claude");
    command.arg("--dangerously-skip-permissions");
    command.arg(command_payload);

    if let Some(dir) = work_dir {
        if !Path::new(&dir).exists() {
            return Err(format!("工作目录不存在: {}", dir));
        }
        command.cwd(dir);
    }

    let pty_system = native_pty_system();
    let pty_pair = pty_system
        .openpty(PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("Failed to create PTY: {}", err))?;

    let child = pty_pair
        .slave
        .spawn_command(command)
        .map_err(|err| format!("Failed to start loop process: {}", err))?;

    let pid = child.process_id();
    let reader = pty_pair
        .master
        .try_clone_reader()
        .map_err(|err| format!("Failed to open output reader: {}", err))?;
    let writer = pty_pair
        .master
        .take_writer()
        .map_err(|err| format!("Failed to open input writer: {}", err))?;

    match OUTPUT_BUFFER.lock() {
        Ok(mut buffer) => buffer.clear(),
        Err(err) => {
            log::error!("[start_loop] failed to clear OUTPUT_BUFFER: {}", err);
        }
    }

    push_output_chunk(format!("[system] loop process started, pid={:?}\n", pid));
    spawn_output_reader(reader, pid);

    *state = Some(LoopSession { 
        pid, 
        child, 
        writer, 
        pty_master: pty_pair.master
    });

    thread::sleep(Duration::from_millis(200));
    Ok("Loop started".to_string())
}

#[tauri::command]
/// Stops the currently running loop process if present.
fn stop_loop() -> Result<String, String> {
    log::info!("[stop_loop] called");

    let mut state = LOOP_STATE.lock().map_err(|err| {
        log::error!("[stop_loop] failed to lock LOOP_STATE: {}", err);
        format!("Failed to access loop state: {}", err)
    })?;

    let mut session = match state.take() {
        Some(session) => session,
        None => {
            log::warn!("[stop_loop] no running process found");
            return Ok("No loop running".to_string());
        }
    };

    let pid = session.pid;
    session
        .child
        .kill()
        .map_err(|err| format!("Failed to stop loop process: {}", err))?;

    let _ = session.child.wait();
    push_output_chunk(format!("\n[system] loop process stopped, pid={:?}\n", pid));
    Ok("Loop stopped".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Runs the Tauri application and registers command handlers.
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            start_loop,
            stop_loop,
            send_loop_input,
            resize_pty,
            poll_loop_output,
            get_enabled,
            set_enabled,
            get_runtime_debug_state
        ])
        .setup(|app| {
            let log_level = if cfg!(debug_assertions) {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            };

            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log_level)
                    .build(),
            )?;

            log::info!("[setup] log plugin initialized with level={:?}", log_level);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
