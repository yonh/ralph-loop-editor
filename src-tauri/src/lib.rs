use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Mutex, LazyLock};
use std::thread;
use std::time::Duration;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use chrono::{DateTime, Utc};
use std::collections::HashMap;
use dirs::home_dir;
use tokio::fs;
use tokio::sync::Mutex as AsyncMutex;

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
static PROJECT_STATE: LazyLock<AsyncMutex<ProjectState>> = LazyLock::new(|| AsyncMutex::new(ProjectState::new()));

/// Maximum number of chunks kept in the in-memory output buffer.
const OUTPUT_BUFFER_LIMIT: usize = 2_000;

/// Default task prompt used when the UI does not provide one.
const DEFAULT_PROMPT: &str = "创建一个优秀的团队来实践工作，阅读 任务目标.md 实现工作，每一个小迭代完毕需要提交代码，持续迭代持续总结经验";

/// Default max iterations for one loop run.
const DEFAULT_MAX_ITERATIONS: u32 = 20;

/// Project data structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub description: String,
    pub work_directory: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub last_prompt: Option<String>,
    pub max_iterations: Option<u32>,
    pub completion_promise: Option<String>,
}

/// Application settings
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub default_max_iterations: u32,
    pub auto_save: bool,
    pub theme: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            default_max_iterations: DEFAULT_MAX_ITERATIONS,
            auto_save: true,
            theme: "default".to_string(),
        }
    }
}

/// Complete application configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub projects: HashMap<String, Project>,
    pub current_project_id: Option<String>,
    pub settings: AppSettings,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            projects: HashMap::new(),
            current_project_id: None,
            settings: AppSettings::default(),
        }
    }
}

/// Project management state
#[derive(Debug)]
pub struct ProjectState {
    pub config: AppConfig,
    pub config_path: Option<String>,
    pub initialized: bool,
}

impl ProjectState {
    pub fn new() -> Self {
        Self {
            config: AppConfig::default(),
            config_path: None,
            initialized: false,
        }
    }

    /// Ensure configuration is initialized
    async fn ensure_initialized(&mut self) -> Result<(), String> {
        if self.initialized {
            return Ok(());
        }
        
        // Get config directory path
        let config_dir = home_dir()
            .ok_or_else(|| "Cannot find home directory".to_string())?
            .join(".ralph-loop-editor");

        // Create config directory if it doesn't exist
        fs::create_dir_all(&config_dir).await.map_err(|e| {
            format!("Failed to create config directory: {}", e)
        })?;

        // Set config file path
        let config_path = config_dir.join("config.json");
        self.config_path = Some(config_path.to_string_lossy().to_string());

        // Load existing config if it exists
        if config_path.exists() {
            self.load_config().await?;
        } else {
            // Save default config
            self.save_config().await?;
        }

        self.initialized = true;
        Ok(())
    }

    /// Load configuration from file
    async fn load_config(&mut self) -> Result<(), String> {
        let config_path = self.config_path.as_ref()
            .ok_or_else(|| "Config path not set".to_string())?;

        let content = fs::read_to_string(config_path).await
            .map_err(|e| format!("Failed to read config file: {}", e))?;

        self.config = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse config file: {}", e))?;

        log::info!("[load_config] loaded configuration from {}", config_path);
        Ok(())
    }

    /// Save configuration to file
    async fn save_config(&self) -> Result<(), String> {
        let config_path = self.config_path.as_ref()
            .ok_or_else(|| "Config path not set".to_string())?;

        let content = serde_json::to_string_pretty(&self.config)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;

        fs::write(config_path, content).await
            .map_err(|e| format!("Failed to write config file: {}", e))?;

        log::info!("[save_config] saved configuration to {}", config_path);
        Ok(())
    }
}

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

#[tauri::command(rename_all = "snake_case")]
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

#[tauri::command(rename_all = "snake_case")]
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

#[tauri::command(rename_all = "snake_case")]
/// Starts the loop process in the optional working directory.
fn start_loop(work_dir: Option<String>, prompt: Option<String>, max_iterations: Option<u32>, completion_promise: Option<String>) -> Result<String, String> {
    log::info!(
        "[start_loop] called with work_dir={:?}, prompt_provided={}, max_iterations={:?}, completion_promise={:?}",
        work_dir,
        prompt.as_ref().map(|p| !p.trim().is_empty()).unwrap_or(false),
        max_iterations,
        completion_promise
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
    let max_iter = max_iterations.unwrap_or(DEFAULT_MAX_ITERATIONS);
    
    let mut command_parts = vec![
        format!("\"{}\"", task_prompt.replace('"', "\\\"")),
        format!("--max-iterations {}", max_iter)
    ];
    
    // Add completion promise if provided
    if let Some(promise) = completion_promise {
        if !promise.trim().is_empty() {
            command_parts.push(format!("--completion-promise \"{}\"", promise.replace('"', "\\\"")));
        }
    }
    
    let command_payload = format!(
        "/ralph-loop:ralph-loop {}",
        command_parts.join(" ")
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

#[tauri::command]
/// Get all projects
async fn get_projects() -> Result<Vec<Project>, String> {
    let mut state = PROJECT_STATE.lock().await;
    
    // Initialize if not already done
    state.ensure_initialized().await.map_err(|err| {
        log::error!("[get_projects] failed to initialize: {}", err);
        err
    })?;

    let projects: Vec<Project> = state.config.projects.values().cloned().collect();
    log::info!("[get_projects] returning {} projects", projects.len());
    Ok(projects)
}

#[tauri::command(rename_all = "snake_case")]
/// Create a new project
async fn create_project(name: String, description: String, work_directory: String) -> Result<Project, String> {
    let mut state = PROJECT_STATE.lock().await;
    
    // Initialize if not already done
    state.ensure_initialized().await.map_err(|err| {
        log::error!("[create_project] failed to initialize: {}", err);
        err
    })?;

    // Validate work directory
    if !Path::new(&work_directory).exists() {
        return Err(format!("工作目录不存在: {}", work_directory));
    }

    // Create new project
    let project = Project {
        id: Uuid::new_v4().to_string(),
        name: name.clone(),
        description,
        work_directory,
        created_at: Utc::now(),
        updated_at: Utc::now(),
        last_prompt: None,
        max_iterations: None,
        completion_promise: None,
    };

    // Add to config
    state.config.projects.insert(project.id.clone(), project.clone());

    // Save config
    if let Err(e) = state.save_config().await {
        log::error!("[create_project] failed to save config: {}", e);
        return Err(e);
    }

    log::info!("[create_project] created project: {} ({})", name, project.id);
    Ok(project)
}

#[tauri::command(rename_all = "snake_case")]
/// Update an existing project
async fn update_project(project_id: String, name: String, description: String, work_directory: String, max_iterations: Option<u32>, completion_promise: Option<String>) -> Result<Project, String> {
    let mut state = PROJECT_STATE.lock().await;
    
    // Initialize if not already done
    state.ensure_initialized().await.map_err(|err| {
        log::error!("[update_project] failed to initialize: {}", err);
        err
    })?;

    // Validate work directory
    if !Path::new(&work_directory).exists() {
        return Err(format!("工作目录不存在: {}", work_directory));
    }

    // Get existing project
    let project = state.config.projects.get_mut(&project_id).ok_or_else(|| {
        format!("项目不存在: {}", project_id)
    })?;

    // Update project fields
    project.name = name;
    project.description = description;
    project.work_directory = work_directory;
    project.updated_at = Utc::now();
    project.max_iterations = max_iterations;
    project.completion_promise = completion_promise;

    let updated_project = project.clone();

    // Save config
    if let Err(e) = state.save_config().await {
        log::error!("[update_project] failed to save config: {}", e);
        return Err(e);
    }

    log::info!("[update_project] updated project: {} ({})", updated_project.name, project_id);
    Ok(updated_project)
}

#[tauri::command(rename_all = "snake_case")]
/// Delete a project
async fn delete_project(project_id: String) -> Result<String, String> {
    let mut state = PROJECT_STATE.lock().await;
    
    // Initialize if not already done
    state.ensure_initialized().await.map_err(|err| {
        log::error!("[delete_project] failed to initialize: {}", err);
        err
    })?;

    // Remove project first, then persist. If persistence fails, rollback in-memory state.
    let removed_project = state.config.projects.remove(&project_id).ok_or_else(|| {
        format!("项目不存在: {}", project_id)
    })?;

    let previous_current_project_id = state.config.current_project_id.clone();
    if state.config.current_project_id.as_deref() == Some(project_id.as_str()) {
        state.config.current_project_id = None;
    }

    if let Err(e) = state.save_config().await {
        // Roll back mutation on save failure so backend state stays consistent with disk.
        state
            .config
            .projects
            .insert(project_id.clone(), removed_project);
        state.config.current_project_id = previous_current_project_id;
        log::error!("[delete_project] failed to save config: {}", e);
        return Err(e);
    }

    log::info!(
        "[delete_project] deleted project: {} ({})",
        removed_project.name,
        project_id
    );
    Ok("项目删除成功".to_string())
}

#[tauri::command(rename_all = "snake_case")]
/// Set current project
async fn set_current_project(project_id: String) -> Result<Project, String> {
    let mut state = PROJECT_STATE.lock().await;
    
    // Initialize if not already done
    state.ensure_initialized().await.map_err(|err| {
        log::error!("[set_current_project] failed to initialize: {}", err);
        err
    })?;

    // Check if project exists
    let project = state.config.projects.get(&project_id).ok_or_else(|| {
        format!("项目不存在: {}", project_id)
    })?;

    // Clone project before modifying state
    let current_project = project.clone();
    
    // Set current project
    state.config.current_project_id = Some(project_id.clone());

    // Save config
    if let Err(e) = state.save_config().await {
        log::error!("[set_current_project] failed to save config: {}", e);
        return Err(e);
    }

    log::info!("[set_current_project] set current project: {} ({})", current_project.name, project_id);
    Ok(current_project)
}

#[tauri::command]
/// Get current project
async fn get_current_project() -> Result<Option<Project>, String> {
    let mut state = PROJECT_STATE.lock().await;
    
    // Initialize if not already done
    state.ensure_initialized().await.map_err(|err| {
        log::error!("[get_current_project] failed to initialize: {}", err);
        err
    })?;

    if let Some(current_id) = &state.config.current_project_id {
        if let Some(project) = state.config.projects.get(current_id) {
            log::info!("[get_current_project] returning current project: {} ({})", project.name, current_id);
            return Ok(Some(project.clone()));
        }
    }

    log::info!("[get_current_project] no current project set");
    Ok(None)
}

#[tauri::command]
/// Get complete application configuration
async fn get_app_config() -> Result<AppConfig, String> {
    let mut state = PROJECT_STATE.lock().await;
    
    // Initialize if not already done
    state.ensure_initialized().await.map_err(|err| {
        log::error!("[get_app_config] failed to initialize: {}", err);
        err
    })?;

    log::info!("[get_app_config] returning complete configuration");
    Ok(state.config.clone())
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
            get_runtime_debug_state,
            get_projects,
            create_project,
            update_project,
            delete_project,
            set_current_project,
            get_current_project,
            get_app_config
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
