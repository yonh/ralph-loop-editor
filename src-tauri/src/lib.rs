use std::process::Child;
use std::sync::Mutex;

static LOOP_STATE: Mutex<Option<Child>> = Mutex::new(None);

#[tauri::command]
fn start_loop() -> Result<String, String> {
    let mut state = LOOP_STATE.lock().map_err(|e| e.to_string())?;

    if state.is_some() {
        return Ok("Loop already running".to_string());
    }

    let child = std::process::Command::new("claude")
        .arg("--dangerously-skip-permissions")
        .arg("/ralph-loop:ralph-loop")
        .arg("保持极度克制开发，实现启用禁用功能，实现开始通过claude开发任务及停止功能，除此之外不要增加任意功能")
        .spawn()
        .map_err(|e| format!("Failed to start loop: {}", e))?;

    *state = Some(child);
    Ok("Loop started".to_string())
}

#[tauri::command]
fn stop_loop() -> Result<String, String> {
    let mut state = LOOP_STATE.lock().map_err(|e| e.to_string())?;

    if let Some(mut child) = state.take() {
        child.kill().map_err(|e| format!("Failed to stop loop: {}", e))?;
        Ok("Loop stopped".to_string())
    } else {
        Ok("No loop running".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![start_loop, stop_loop])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
