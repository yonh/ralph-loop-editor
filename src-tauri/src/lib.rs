use std::process::{Child, Command};
use std::sync::Mutex;
use std::path::Path;

static LOOP_STATE: Mutex<Option<Child>> = Mutex::new(None);

/// 默认任务提示词
const DEFAULT_PROMPT: &str = "创建一个优秀的团队来实践工作，阅读 任务目标.md 实现工作，每一个小迭代完毕需要提交代码，持续迭代持续总结经验";

#[tauri::command]
fn start_loop(work_dir: Option<String>, prompt: Option<String>) -> Result<String, String> {
    let mut state = LOOP_STATE.lock().map_err(|e| e.to_string())?;

    if state.is_some() {
        return Ok("Loop already running".to_string());
    }

    // 使用用户提供的提示词或默认值
    let task_prompt = prompt.unwrap_or_else(|| DEFAULT_PROMPT.to_string());

    let mut cmd = Command::new("claude");
    cmd.arg("--dangerously-skip-permissions")
       .arg("/ralph-loop:ralph-loop")
       .arg(&task_prompt);

    // 如果指定了工作目录，设置它
    if let Some(dir) = work_dir {
        if !Path::new(&dir).exists() {
            return Err(format!("工作目录不存在: {}", dir));
        }
        cmd.current_dir(&dir);
    }

    let child = cmd
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
