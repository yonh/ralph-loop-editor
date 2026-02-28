use std::process::{Child, Command};
use std::sync::Mutex;
use std::path::Path;
use std::thread;
use std::time::Duration;

static LOOP_STATE: Mutex<Option<Child>> = Mutex::new(None);
static ENABLED_STATE: Mutex<bool> = Mutex::new(false);

#[derive(serde::Serialize)]
/// Snapshot of backend runtime state for diagnostics.
struct RuntimeDebugState {
    enabled: bool,
    loop_running: bool,
    loop_pid: Option<u32>,
}

/// Default task prompt used when the UI does not provide one.
const DEFAULT_PROMPT: &str = "创建一个优秀的团队来实践工作，阅读 任务目标.md 实现工作，每一个小迭代完毕需要提交代码，持续迭代持续总结经验";

/// Default max iterations for one loop run.
const DEFAULT_MAX_ITERATIONS: u32 = 20;

#[tauri::command]
/// Returns whether the app is enabled.
fn get_enabled() -> Result<bool, String> {
    match ENABLED_STATE.lock() {
        Ok(state) => {
            let value = *state;
            log::info!("[get_enabled] returning enabled={}.", value);
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
                "[set_enabled] changed enabled from {} to {}.",
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

    let snapshot = RuntimeDebugState {
        enabled: *enabled,
        loop_running: loop_state.is_some(),
        loop_pid: loop_state.as_ref().map(Child::id),
    };

    log::info!(
        "[get_runtime_debug_state] enabled={}, loop_running={}, loop_pid={:?}",
        snapshot.enabled,
        snapshot.loop_running,
        snapshot.loop_pid
    );

    Ok(snapshot)
}

#[tauri::command]
/// Starts the loop process in the optional working directory.
fn start_loop(work_dir: Option<String>, prompt: Option<String>) -> Result<String, String> {
    log::info!(
        "[start_loop] called with work_dir={:?}, prompt_provided={}",
        work_dir,
        prompt.as_ref().map(|p| !p.trim().is_empty()).unwrap_or(false)
    );

    // Check whether the app is enabled first.
    let enabled = ENABLED_STATE.lock().map_err(|e| {
        log::error!("[start_loop] failed to lock ENABLED_STATE: {}", e);
        e.to_string()
    })?;
    if !*enabled {
        log::warn!("[start_loop] blocked because app is disabled.");
        return Err("应用未启用，请先点击启用按钮".to_string());
    }

    let mut state = LOOP_STATE.lock().map_err(|e| {
        log::error!("[start_loop] failed to lock LOOP_STATE: {}", e);
        e.to_string()
    })?;

    if state.is_some() {
        log::warn!("[start_loop] ignored because loop is already running.");
        return Ok("Loop already running".to_string());
    }

    // Use the user prompt if provided; otherwise fallback to default prompt.
    let task_prompt = prompt.unwrap_or_else(|| DEFAULT_PROMPT.to_string());

    // Keep CLI invocation compatible with the original shell workflow.
    let command_payload = format!(
        "/ralph-loop:ralph-loop \"{}\" --max-iterations {}",
        task_prompt.replace('"', "\\\""),
        DEFAULT_MAX_ITERATIONS
    );
    log::info!("[start_loop] command payload prepared.");

    let mut cmd = Command::new("claude");
    cmd.arg("--dangerously-skip-permissions")
        .arg(&command_payload);

    // Apply the working directory only when the path exists.
    if let Some(dir) = work_dir {
        if !Path::new(&dir).exists() {
            log::error!("[start_loop] work directory does not exist: {}", dir);
            return Err(format!("工作目录不存在: {}", dir));
        }
        log::info!("[start_loop] setting current_dir to {}", dir);
        cmd.current_dir(&dir);
    }

    log::info!("[start_loop] spawning claude process now.");

    let mut child = cmd
        .spawn()
        .map_err(|e| {
            log::error!("[start_loop] failed to spawn process: {}", e);
            format!("Failed to start loop: {}", e)
        })?;

    log::info!("[start_loop] spawned process with pid={:?}", child.id());

    // Detect immediate startup failures from the spawned process.
    thread::sleep(Duration::from_millis(300));
    if let Some(status) = child
        .try_wait()
        .map_err(|e| format!("Failed to inspect loop status: {}", e))?
    {
        log::error!(
            "[start_loop] process exited immediately with status: {}",
            status
        );
        return Err(format!(
            "Loop process exited immediately with status: {}",
            status
        ));
    }

    *state = Some(child);
    log::info!("[start_loop] loop process stored in state.");
    Ok("Loop started".to_string())
}

#[tauri::command]
/// Stops the currently running loop process if present.
fn stop_loop() -> Result<String, String> {
    log::info!("[stop_loop] called.");
    let mut state = LOOP_STATE.lock().map_err(|e| {
        log::error!("[stop_loop] failed to lock LOOP_STATE: {}", e);
        e.to_string()
    })?;

    if let Some(mut child) = state.take() {
        let pid = child.id();
        log::info!("[stop_loop] killing process pid={:?}", pid);
        child.kill().map_err(|e| {
            log::error!("[stop_loop] failed to stop process pid={:?}: {}", pid, e);
            format!("Failed to stop loop: {}", e)
        })?;
        log::info!("[stop_loop] process pid={:?} stopped.", pid);
        Ok("Loop stopped".to_string())
    } else {
        log::warn!("[stop_loop] no running process found.");
        Ok("No loop running".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Runs the Tauri application and registers command handlers.
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
        start_loop,
        stop_loop,
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
