use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use std::collections::{HashMap, VecDeque};
use std::env;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, LazyLock};
use std::thread;
use std::time::Duration;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;
use chrono::{DateTime, Utc};
use dirs::home_dir;
use tokio::fs;
use tokio::process::Command;
use tokio::sync::Mutex as AsyncMutex;
use tokio::time::{timeout, Duration as TokioDuration};

/// Runtime session for one active loop process.
struct LoopSession {
    session_id: String,
    project_id: String,
    pid: Option<u32>,
    child: Box<dyn portable_pty::Child + Send>,
    writer: Box<dyn Write + Send>,
    pty_master: Box<dyn portable_pty::MasterPty + Send>,
}

/// Runtime process state for all active sessions.
#[derive(Default)]
struct RuntimeState {
    sessions: HashMap<String, LoopSession>,
    project_sessions: HashMap<String, String>,
    project_last_session: HashMap<String, String>,
    output_buffers: HashMap<String, VecDeque<String>>,
}

static RUNTIME_STATE: LazyLock<Mutex<RuntimeState>> = LazyLock::new(|| Mutex::new(RuntimeState::default()));
static PROJECT_STATE: LazyLock<AsyncMutex<ProjectState>> = LazyLock::new(|| AsyncMutex::new(ProjectState::new()));

/// Maximum number of chunks kept in the in-memory output buffer.
const OUTPUT_BUFFER_LIMIT: usize = 2_000;

/// Default task prompt used when the UI does not provide one.
const DEFAULT_PROMPT: &str = "创建一个优秀的团队来实践工作，阅读 任务目标.md 实现工作，每一个小迭代完毕需要提交代码，持续迭代持续总结经验";

/// Default max iterations for one loop run.
const DEFAULT_MAX_ITERATIONS: u32 = 20;
const CLAUDE_SETTINGS_DIR_NAME: &str = "claude-settings";
const CLAUDE_PROJECT_SETTINGS_FILE_NAME: &str = "settings.local.json";
const PROMPT_HISTORY_LIMIT: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptHistoryEntry {
    pub prompt: String,
    pub used_at: DateTime<Utc>,
}

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
    #[serde(default)]
    pub prompt_history: Vec<PromptHistoryEntry>,
    pub max_iterations: Option<u32>,
    pub completion_promise: Option<String>,
    pub claude_setting_id: Option<String>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub overwrite_claude_settings_on_create: bool,
}

/// Claude settings file metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeSettingFile {
    pub id: String,
    pub name: String,
    pub file_name: String,
    pub file_path: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Claude setting file content payload for editing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeSettingFileContent {
    pub id: String,
    pub name: String,
    pub content: String,
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
    #[serde(default)]
    pub claude_settings: HashMap<String, ClaudeSettingFile>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            projects: HashMap::new(),
            current_project_id: None,
            settings: AppSettings::default(),
            claude_settings: HashMap::new(),
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
        let config_dir = get_app_config_dir()?;

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

/// Returns Ralph Loop Editor application config directory path.
fn get_app_config_dir() -> Result<PathBuf, String> {
    Ok(
        home_dir()
            .ok_or_else(|| "Cannot find home directory".to_string())?
            .join(".ralph-loop-editor"),
    )
}

/// Ensures and returns the Claude settings file storage directory.
async fn ensure_claude_settings_dir() -> Result<PathBuf, String> {
    let settings_dir = get_app_config_dir()?.join(CLAUDE_SETTINGS_DIR_NAME);
    fs::create_dir_all(&settings_dir)
        .await
        .map_err(|err| format!("Failed to create Claude settings directory: {}", err))?;
    Ok(settings_dir)
}

/// Trims and normalizes optional input strings.
fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

/// Compresses process output into one short single-line preview for errors.
fn compact_process_output(bytes: &[u8]) -> String {
    let raw = String::from_utf8_lossy(bytes).replace('\n', " ").trim().to_string();
    if raw.len() > 240 {
        format!("{}...", &raw[..240])
    } else {
        raw
    }
}

fn extract_openai_text(response_json: &Value) -> Option<String> {
    let content = response_json
        .get("choices")
        .and_then(|choices| choices.as_array())
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))?;

    if let Some(text) = content.as_str() {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    if let Some(items) = content.as_array() {
        let mut merged = String::new();
        for item in items {
            if let Some(text) = item.get("text").and_then(|value| value.as_str()) {
                if !text.is_empty() {
                    if !merged.is_empty() {
                        merged.push('\n');
                    }
                    merged.push_str(text);
                }
            }
        }
        let trimmed = merged.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    None
}

fn extract_anthropic_text(response_json: &Value) -> Option<String> {
    let content = response_json.get("content")?.as_array()?;
    let mut merged = String::new();
    for item in content {
        if item.get("type").and_then(|value| value.as_str()) != Some("text") {
            continue;
        }
        if let Some(text) = item.get("text").and_then(|value| value.as_str()) {
            if !text.is_empty() {
                if !merged.is_empty() {
                    merged.push('\n');
                }
                merged.push_str(text);
            }
        }
    }

    let trimmed = merged.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Returns one absolute executable path resolved from current PATH.
fn resolve_executable_from_path(binary_name: &str) -> Option<String> {
    let trimmed = binary_name.trim();
    if trimmed.is_empty() {
        return None;
    }

    let has_path_separator = trimmed.contains(std::path::MAIN_SEPARATOR)
        || trimmed.contains('/')
        || trimmed.contains('\\');
    if has_path_separator {
        let candidate = PathBuf::from(trimmed);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().to_string());
        }
        return None;
    }

    let path_env = env::var_os("PATH")?;
    let path_entries: Vec<PathBuf> = env::split_paths(&path_env).collect();

    #[cfg(windows)]
    {
        let candidate_path = Path::new(trimmed);
        let has_extension = candidate_path.extension().is_some();
        let pathext: Vec<String> = env::var_os("PATHEXT")
            .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into())
            .to_string_lossy()
            .split(';')
            .filter_map(|item| {
                let ext = item.trim();
                if ext.is_empty() {
                    None
                } else {
                    Some(ext.to_string())
                }
            })
            .collect();

        for dir in path_entries {
            if has_extension {
                let direct = dir.join(trimmed);
                if direct.is_file() {
                    return Some(direct.to_string_lossy().to_string());
                }
                continue;
            }

            for ext in &pathext {
                let candidate = dir.join(format!("{}{}", trimmed, ext));
                if candidate.is_file() {
                    return Some(candidate.to_string_lossy().to_string());
                }
            }
        }
        return None;
    }

    #[cfg(not(windows))]
    {
        for dir in path_entries {
            let candidate = dir.join(trimmed);
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
        None
    }
}

/// Converts a setting display name into a filesystem-safe file stem.
fn sanitize_setting_name(name: &str) -> String {
    let mut output = String::new();
    let mut previous_is_dash = false;

    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            output.push(ch.to_ascii_lowercase());
            previous_is_dash = false;
            continue;
        }

        if !previous_is_dash {
            output.push('-');
            previous_is_dash = true;
        }
    }

    let normalized = output.trim_matches('-');
    if normalized.is_empty() {
        "setting".to_string()
    } else {
        normalized.to_string()
    }
}

/// Picks a non-conflicting setting display name.
fn build_unique_setting_name(state: &ProjectState, base_name: &str) -> String {
    if !state
        .config
        .claude_settings
        .values()
        .any(|setting| setting.name == base_name)
    {
        return base_name.to_string();
    }

    let mut index = 2usize;
    loop {
        let candidate = format!("{} {}", base_name, index);
        if !state
            .config
            .claude_settings
            .values()
            .any(|setting| setting.name == candidate)
        {
            return candidate;
        }
        index += 1;
    }
}

/// Imports workdir `.claude/settings.local.json` into managed settings and returns new setting id.
async fn import_local_workdir_setting_if_present(
    state: &mut ProjectState,
    project_name: &str,
    work_directory: &str,
) -> Result<Option<String>, String> {
    let local_setting_path = Path::new(work_directory)
        .join(".claude")
        .join(CLAUDE_PROJECT_SETTINGS_FILE_NAME);
    if !local_setting_path.exists() {
        return Ok(None);
    }

    let raw_content = fs::read_to_string(&local_setting_path)
        .await
        .map_err(|err| format!("读取本地 Claude setting 失败 '{}': {}", local_setting_path.display(), err))?;
    let normalized_content = match serde_json::from_str::<serde_json::Value>(&raw_content) {
        Ok(value) => serde_json::to_string_pretty(&value).unwrap_or(raw_content.clone()),
        Err(_) => raw_content.clone(),
    };

    let settings_dir = ensure_claude_settings_dir().await?;
    let base_display_name = if project_name.trim().is_empty() {
        "workdir-local-setting".to_string()
    } else {
        format!("{} (workdir)", project_name.trim())
    };
    let display_name = build_unique_setting_name(state, &base_display_name);
    let file_stem = sanitize_setting_name(&display_name);
    let file_name = format!("{}-{}.json", file_stem, &Uuid::new_v4().to_string()[..8]);
    let file_path = settings_dir.join(&file_name);

    fs::write(&file_path, normalized_content)
        .await
        .map_err(|err| format!("写入导入 setting 文件失败 '{}': {}", file_path.display(), err))?;

    let now = Utc::now();
    let setting = ClaudeSettingFile {
        id: Uuid::new_v4().to_string(),
        name: display_name,
        file_name,
        file_path: file_path.to_string_lossy().to_string(),
        created_at: now,
        updated_at: now,
    };
    let setting_id = setting.id.clone();
    state.config.claude_settings.insert(setting.id.clone(), setting);
    Ok(Some(setting_id))
}

/// Writes one Claude setting file into project `.claude/settings.local.json`.
async fn apply_claude_setting_to_work_directory(setting_file_path: &str, work_directory: &str) -> Result<(), String> {
    let setting_content = fs::read_to_string(setting_file_path)
        .await
        .map_err(|err| format!("Failed to read Claude setting file '{}': {}", setting_file_path, err))?;

    let claude_dir = Path::new(work_directory).join(".claude");
    fs::create_dir_all(&claude_dir)
        .await
        .map_err(|err| format!("Failed to create .claude directory '{}': {}", claude_dir.display(), err))?;

    let project_setting_path = claude_dir.join(CLAUDE_PROJECT_SETTINGS_FILE_NAME);
    fs::write(&project_setting_path, setting_content)
        .await
        .map_err(|err| format!("Failed to write project Claude setting '{}': {}", project_setting_path.display(), err))?;

    Ok(())
}

#[derive(serde::Serialize)]
/// Snapshot of backend runtime state for diagnostics.
struct RuntimeDebugState {
    current_project_id: Option<String>,
    current_project_enabled: Option<bool>,
    current_project_loop_running: bool,
    current_project_loop_pid: Option<u32>,
    current_project_session_id: Option<String>,
    total_running_sessions: usize,
    running_project_ids: Vec<String>,
    running_sessions: Vec<RuntimeSessionSummary>,
}

#[derive(Serialize)]
/// Lightweight runtime session info for UI status sync.
struct RuntimeSessionSummary {
    session_id: String,
    project_id: String,
    pid: Option<u32>,
}

#[derive(Serialize)]
/// Claude runtime context snapshot for diagnosing settings resolution.
struct ClaudeRuntimeDebugContext {
    work_dir: String,
    claude_dir_exists: bool,
    settings_file_path: String,
    settings_file_exists: bool,
    settings_file_size: Option<u64>,
    model: Option<String>,
    env_anthropic_model: Option<String>,
    env_anthropic_base_url: Option<String>,
    env_disable_nonessential_traffic: Option<String>,
}

/// Pushes a chunk into the output buffer and trims old entries.
fn push_output_chunk(session_id: &str, chunk: String) {
    match RUNTIME_STATE.lock() {
        Ok(mut state) => {
            let buffer = state
                .output_buffers
                .entry(session_id.to_string())
                .or_insert_with(VecDeque::new);
            buffer.push_back(chunk);
            while buffer.len() > OUTPUT_BUFFER_LIMIT {
                let _ = buffer.pop_front();
            }
        }
        Err(err) => {
            log::error!("[push_output_chunk] failed to lock RUNTIME_STATE: {}", err);
        }
    }
}

/// Normalizes optional session/project selector input.
fn normalize_selector(value: Option<String>) -> Option<String> {
    value
        .map(|raw| raw.trim().to_string())
        .filter(|trimmed| !trimmed.is_empty())
}

/// Resolves one running session id from optional project/session selectors.
fn resolve_target_session_id(
    state: &RuntimeState,
    project_id: Option<&str>,
    session_id: Option<&str>,
) -> Result<String, String> {
    if let Some(candidate) = session_id {
        if state.sessions.contains_key(candidate) || state.output_buffers.contains_key(candidate) {
            return Ok(candidate.to_string());
        }
        return Err(format!("运行会话不存在: {}", candidate));
    }

    if let Some(project) = project_id {
        if let Some(found) = state.project_sessions.get(project) {
            return Ok(found.clone());
        }
        if let Some(found) = state.project_last_session.get(project) {
            return Ok(found.clone());
        }
        return Err(format!("项目没有正在运行的会话: {}", project));
    }

    Err("必须提供 session_id 或 project_id".to_string())
}

/// Clears one runtime session and detaches its project index.
fn clear_loop_state_for_session(session_id: &str) {
    match RUNTIME_STATE.lock() {
        Ok(mut state) => {
            if let Some(session) = state.sessions.remove(session_id) {
                state.project_sessions.remove(&session.project_id);
                log::info!(
                    "[clear_loop_state_for_session] cleared session={} project={} pid={:?}",
                    session_id,
                    session.project_id,
                    session.pid
                );
            }
        }
        Err(err) => {
            log::error!(
                "[clear_loop_state_for_session] failed to lock RUNTIME_STATE for session={}: {}",
                session_id,
                err
            );
        }
    }
}

/// Starts a background reader thread for process output.
fn spawn_output_reader(mut reader: Box<dyn Read + Send>, session_id: String) {
    thread::spawn(move || {
        let mut buf = [0u8; 2048];
        let mut pending_bytes: Vec<u8> = Vec::new();

        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    if !pending_bytes.is_empty() {
                        let flushed = String::from_utf8_lossy(&pending_bytes).to_string();
                        push_output_chunk(&session_id, flushed);
                        pending_bytes.clear();
                    }
                    push_output_chunk(
                        &session_id,
                        "\r\n[system] loop process output stream closed.\r\n".to_string(),
                    );
                    clear_loop_state_for_session(&session_id);
                    break;
                }
                Ok(size) => {
                    pending_bytes.extend_from_slice(&buf[..size]);

                    loop {
                        match std::str::from_utf8(&pending_bytes) {
                            Ok(text) => {
                                if !text.is_empty() {
                                    push_output_chunk(&session_id, text.to_string());
                                }
                                pending_bytes.clear();
                                break;
                            }
                            Err(err) => {
                                let valid_up_to = err.valid_up_to();
                                if valid_up_to > 0 {
                                    let valid_text =
                                        String::from_utf8_lossy(&pending_bytes[..valid_up_to]).to_string();
                                    push_output_chunk(&session_id, valid_text);
                                    pending_bytes.drain(..valid_up_to);
                                }

                                if let Some(error_len) = err.error_len() {
                                    let remove_len = error_len.min(pending_bytes.len());
                                    pending_bytes.drain(..remove_len);
                                    push_output_chunk(
                                        &session_id,
                                        "\r\n[system] skipped undecodable output bytes.\r\n".to_string(),
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
                    push_output_chunk(
                        &session_id,
                        format!("\r\n[system] output read error: {}\r\n", err),
                    );
                    clear_loop_state_for_session(&session_id);
                    break;
                }
            }
        }
    });
}

#[tauri::command(rename_all = "snake_case")]
/// Returns whether one project is enabled.
async fn get_project_enabled(project_id: String) -> Result<bool, String> {
    let mut state = PROJECT_STATE.lock().await;
    state.ensure_initialized().await.map_err(|err| {
        log::error!("[get_project_enabled] failed to initialize: {}", err);
        err
    })?;

    let project = state
        .config
        .projects
        .get(project_id.trim())
        .ok_or_else(|| format!("项目不存在: {}", project_id))?;
    Ok(project.enabled)
}

#[tauri::command(rename_all = "snake_case")]
/// Sets one project's enabled flag and returns the updated project.
async fn set_project_enabled(project_id: String, enabled: bool) -> Result<Project, String> {
    let mut state = PROJECT_STATE.lock().await;
    state.ensure_initialized().await.map_err(|err| {
        log::error!("[set_project_enabled] failed to initialize: {}", err);
        err
    })?;

    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err("project_id 不能为空".to_string());
    }

    let previous_project = state
        .config
        .projects
        .get(&project_id)
        .cloned()
        .ok_or_else(|| format!("项目不存在: {}", project_id))?;

    let updated_project = {
        let project = state
            .config
            .projects
            .get_mut(&project_id)
            .ok_or_else(|| format!("项目不存在: {}", project_id))?;
        project.enabled = enabled;
        project.updated_at = Utc::now();
        project.clone()
    };

    if let Err(err) = state.save_config().await {
        state
            .config
            .projects
            .insert(project_id.clone(), previous_project);
        log::error!(
            "[set_project_enabled] failed to save config for project {}: {}",
            project_id,
            err
        );
        return Err(err);
    }

    Ok(updated_project)
}

#[tauri::command]
/// Returns a backend state snapshot to help diagnose UI/command issues.
async fn get_runtime_debug_state() -> Result<RuntimeDebugState, String> {
    let (current_project_id, current_project_enabled) = {
        let mut project_state = PROJECT_STATE.lock().await;
        project_state.ensure_initialized().await.map_err(|err| {
            log::error!("[get_runtime_debug_state] failed to initialize: {}", err);
            err
        })?;

        let current_project_id = project_state.config.current_project_id.clone();
        let current_project_enabled = current_project_id
            .as_ref()
            .and_then(|project_id| project_state.config.projects.get(project_id))
            .map(|project| project.enabled);
        (current_project_id, current_project_enabled)
    };

    let runtime_state = RUNTIME_STATE.lock().map_err(|err| {
        log::error!(
            "[get_runtime_debug_state] failed to lock RUNTIME_STATE: {}",
            err
        );
        format!("Failed to read runtime state: {}", err)
    })?;

    let current_project_session_id = current_project_id
        .as_ref()
        .and_then(|project_id| runtime_state.project_sessions.get(project_id))
        .cloned();
    let current_project_loop_pid = current_project_session_id
        .as_ref()
        .and_then(|session_id| runtime_state.sessions.get(session_id))
        .and_then(|session| session.pid);

    let mut running_project_ids: Vec<String> = runtime_state
        .project_sessions
        .keys()
        .cloned()
        .collect();
    running_project_ids.sort_unstable();

    let mut running_sessions: Vec<RuntimeSessionSummary> = runtime_state
        .sessions
        .values()
        .map(|session| RuntimeSessionSummary {
            session_id: session.session_id.clone(),
            project_id: session.project_id.clone(),
            pid: session.pid,
        })
        .collect();
    running_sessions.sort_by(|left, right| left.project_id.cmp(&right.project_id));

    Ok(RuntimeDebugState {
        current_project_id,
        current_project_enabled,
        current_project_loop_running: current_project_session_id.is_some(),
        current_project_loop_pid,
        current_project_session_id,
        total_running_sessions: runtime_state.sessions.len(),
        running_project_ids,
        running_sessions,
    })
}

#[tauri::command(rename_all = "snake_case")]
/// Drains and returns current buffered output chunks from the process.
fn poll_loop_output(project_id: Option<String>, session_id: Option<String>) -> Result<Vec<String>, String> {
    let normalized_project_id = normalize_selector(project_id);
    let normalized_session_id = normalize_selector(session_id);

    let mut state = RUNTIME_STATE.lock().map_err(|err| {
        log::error!("[poll_loop_output] failed to lock RUNTIME_STATE: {}", err);
        format!("Failed to read runtime state: {}", err)
    })?;

    let resolved_session_id = match resolve_target_session_id(
        &state,
        normalized_project_id.as_deref(),
        normalized_session_id.as_deref(),
    ) {
        Ok(value) => value,
        Err(_) => return Ok(vec![]),
    };

    let has_running_session = state.sessions.contains_key(&resolved_session_id);
    let chunks = if let Some(buffer) = state.output_buffers.get_mut(&resolved_session_id) {
        buffer.drain(..).collect()
    } else {
        vec![]
    };

    if !has_running_session {
        if state
            .output_buffers
            .get(&resolved_session_id)
            .map(|buffer| buffer.is_empty())
            .unwrap_or(false)
        {
            state.output_buffers.remove(&resolved_session_id);
        }
    }

    Ok(chunks)
}

#[tauri::command(rename_all = "snake_case")]
/// Returns runtime Claude settings file info for a work directory.
async fn inspect_claude_runtime_context(work_dir: String) -> Result<ClaudeRuntimeDebugContext, String> {
    let work_dir_path = Path::new(&work_dir);
    let claude_dir = work_dir_path.join(".claude");
    let settings_path = claude_dir.join(CLAUDE_PROJECT_SETTINGS_FILE_NAME);

    let claude_dir_exists = claude_dir.exists();
    let settings_file_exists = settings_path.exists();

    let mut context = ClaudeRuntimeDebugContext {
        work_dir: work_dir.clone(),
        claude_dir_exists,
        settings_file_path: settings_path.to_string_lossy().to_string(),
        settings_file_exists,
        settings_file_size: None,
        model: None,
        env_anthropic_model: None,
        env_anthropic_base_url: None,
        env_disable_nonessential_traffic: None,
    };

    if !settings_file_exists {
        return Ok(context);
    }

    let metadata = fs::metadata(&settings_path)
        .await
        .map_err(|err| format!("读取 settings 文件元信息失败 '{}': {}", settings_path.display(), err))?;
    context.settings_file_size = Some(metadata.len());

    let raw = fs::read_to_string(&settings_path)
        .await
        .map_err(|err| format!("读取 settings 文件失败 '{}': {}", settings_path.display(), err))?;

    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
        context.model = value
            .get("model")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        context.env_anthropic_model = value
            .get("env")
            .and_then(|v| v.get("ANTHROPIC_MODEL"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        context.env_anthropic_base_url = value
            .get("env")
            .and_then(|v| v.get("ANTHROPIC_BASE_URL"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        context.env_disable_nonessential_traffic = value
            .get("env")
            .and_then(|v| v.get("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
    }

    Ok(context)
}

#[tauri::command(rename_all = "snake_case")]
/// Optimizes prompt by direct HTTP API call (OpenAI/Anthropic).
async fn optimize_prompt_api(
    provider: String,
    api_key: String,
    base_url: Option<String>,
    model: String,
    prompt: String,
    timeout_seconds: Option<u64>,
) -> Result<String, String> {
    let provider = provider.trim().to_lowercase();
    if provider != "openai" && provider != "anthropic" {
        return Err(format!("不支持的 provider: {}，仅支持 openai/anthropic", provider));
    }

    let api_key = api_key.trim().to_string();
    if api_key.is_empty() {
        return Err("AI 优化 API Key 不能为空".to_string());
    }

    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("AI 优化模型不能为空".to_string());
    }

    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("优化提示词不能为空".to_string());
    }

    let normalized_base = base_url
        .as_deref()
        .map(|raw| raw.trim())
        .filter(|trimmed| !trimmed.is_empty())
        .map(|trimmed| trimmed.trim_end_matches('/').to_string());

    let endpoint = if provider == "openai" {
        let base = normalized_base.unwrap_or_else(|| "https://api.openai.com/v1".to_string());
        if base.ends_with("/chat/completions") {
            base
        } else if base.ends_with("/v1") {
            format!("{}/chat/completions", base)
        } else {
            format!("{}/v1/chat/completions", base)
        }
    } else {
        let base = normalized_base.unwrap_or_else(|| "https://api.anthropic.com/v1".to_string());
        if base.ends_with("/messages") {
            base
        } else if base.ends_with("/v1") {
            format!("{}/messages", base)
        } else {
            format!("{}/v1/messages", base)
        }
    };

    let timeout_seconds = timeout_seconds.unwrap_or(30).clamp(5, 120);
    let client = reqwest::Client::builder()
        .timeout(TokioDuration::from_secs(timeout_seconds))
        .build()
        .map_err(|err| format!("创建 HTTP 客户端失败: {}", err))?;

    let request = if provider == "openai" {
        client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&json!({
                "model": model,
                "messages": [
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],
                "temperature": 0.2
            }))
    } else {
        client
            .post(&endpoint)
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .header("Content-Type", "application/json")
            .json(&json!({
                "model": model,
                "max_tokens": 2048,
                "messages": [
                    {
                        "role": "user",
                        "content": prompt
                    }
                ]
            }))
    };

    let response = request
        .send()
        .await
        .map_err(|err| format!("调用 {} 接口失败: {}", provider, err))?;

    let status = response.status();
    let raw_body = response
        .text()
        .await
        .map_err(|err| format!("读取 {} 响应失败: {}", provider, err))?;

    if !status.is_success() {
        let parsed = serde_json::from_str::<Value>(&raw_body).ok();
        if let Some(message) = parsed
            .as_ref()
            .and_then(|json| json.get("error"))
            .and_then(|error| error.get("message"))
            .and_then(|message| message.as_str())
        {
            return Err(format!("{} 接口返回错误({}): {}", provider, status.as_u16(), message));
        }
        if let Some(message) = parsed
            .as_ref()
            .and_then(|json| json.get("msg"))
            .and_then(|message| message.as_str())
        {
            let code = parsed
                .as_ref()
                .and_then(|json| json.get("code"))
                .map(|code| code.to_string())
                .unwrap_or_else(|| "-".to_string());
            return Err(format!(
                "{} 接口返回错误({}): code={}, msg={}",
                provider,
                status.as_u16(),
                code,
                message
            ));
        }
        return Err(format!(
            "{} 接口返回错误({}): {}",
            provider,
            status.as_u16(),
            compact_process_output(raw_body.as_bytes())
        ));
    }

    let response_json = serde_json::from_str::<Value>(&raw_body)
        .map_err(|err| format!("解析 {} 响应 JSON 失败: {}", provider, err))?;

    let text = if provider == "openai" {
        extract_openai_text(&response_json)
    } else {
        extract_anthropic_text(&response_json)
    };

    if text.is_none() {
        if let Some(message) = response_json
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(|message| message.as_str())
        {
            return Err(format!("{} 接口返回错误: {}", provider, message));
        }
        if let Some(message) = response_json
            .get("msg")
            .and_then(|message| message.as_str())
        {
            let code = response_json
                .get("code")
                .map(|code| code.to_string())
                .unwrap_or_else(|| "-".to_string());
            return Err(format!("{} 接口返回错误: code={}, msg={}", provider, code, message));
        }
    }

    match text {
        Some(value) => Ok(value),
        None => Err(format!(
            "{} 接口返回成功但未包含可解析文本: {}",
            provider,
            compact_process_output(raw_body.as_bytes())
        )),
    }
}

#[tauri::command(rename_all = "snake_case")]
/// Uses local Claude CLI to optimize one prompt in non-interactive mode.
async fn optimize_prompt(work_dir: Option<String>, prompt: String) -> Result<String, String> {
    let normalized_prompt = prompt.trim().to_string();
    if normalized_prompt.is_empty() {
        return Err("优化提示词不能为空".to_string());
    }

    let resolved_work_dir = work_dir
        .map(|raw| raw.trim().to_string())
        .filter(|trimmed| !trimmed.is_empty())
        .unwrap_or_else(|| ".".to_string());
    if !Path::new(&resolved_work_dir).exists() {
        return Err(format!("工作目录不存在: {}", resolved_work_dir));
    }

    let args = vec!["--dangerously-skip-permissions", "-p"];
    let output = timeout(
        TokioDuration::from_secs(30),
        Command::new("claude")
            .args(&args)
            .arg(&normalized_prompt)
            .current_dir(&resolved_work_dir)
            .output()
    )
    .await;

    match output {
        Ok(wait_result) => match wait_result {
            Ok(result) => {
                let stdout = String::from_utf8_lossy(&result.stdout).trim().to_string();
                if result.status.success() && !stdout.is_empty() {
                    return Ok(stdout);
                }
                Err(format!(
                    "调用 Claude 优化失败。args={:?}, code={:?}, stdout='{}', stderr='{}'",
                    args,
                    result.status.code(),
                    compact_process_output(&result.stdout),
                    compact_process_output(&result.stderr)
                ))
            }
            Err(err) => Err(format!("调用 Claude 优化失败。args={:?}, error={}", args, err)),
        },
        Err(_elapsed) => Err("调用 Claude 优化超时（30s）".to_string()),
    }
}

#[tauri::command(rename_all = "snake_case")]
/// Detects the Claude CLI absolute path from current system PATH.
fn detect_claude_cli_path() -> Result<Option<String>, String> {
    Ok(resolve_executable_from_path("claude"))
}

#[tauri::command(rename_all = "snake_case")]
/// Sends user input to the running loop process.
fn send_loop_input(
    input: String,
    append_newline: Option<bool>,
    project_id: Option<String>,
    session_id: Option<String>,
) -> Result<String, String> {
    let normalized_project_id = normalize_selector(project_id);
    let normalized_session_id = normalize_selector(session_id);

    let mut state = RUNTIME_STATE.lock().map_err(|err| {
        log::error!("[send_loop_input] failed to lock RUNTIME_STATE: {}", err);
        format!("Failed to access runtime state: {}", err)
    })?;

    let resolved_session_id = resolve_target_session_id(
        &state,
        normalized_project_id.as_deref(),
        normalized_session_id.as_deref(),
    )?;
    let session = state
        .sessions
        .get_mut(&resolved_session_id)
        .ok_or_else(|| format!("No loop process is running for session {}", resolved_session_id))?;

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
fn resize_pty(
    cols: u16,
    rows: u16,
    project_id: Option<String>,
    session_id: Option<String>,
) -> Result<String, String> {
    log::info!("[resize_pty] called with cols={}, rows={}", cols, rows);

    let normalized_project_id = normalize_selector(project_id);
    let normalized_session_id = normalize_selector(session_id);

    let mut state = RUNTIME_STATE.lock().map_err(|err| {
        log::error!("[resize_pty] failed to lock RUNTIME_STATE: {}", err);
        format!("Failed to access runtime state: {}", err)
    })?;

    let resolved_session_id = resolve_target_session_id(
        &state,
        normalized_project_id.as_deref(),
        normalized_session_id.as_deref(),
    )?;
    let session = state
        .sessions
        .get_mut(&resolved_session_id)
        .ok_or_else(|| format!("No loop process is running for session {}", resolved_session_id))?;

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
async fn start_loop(
    project_id: Option<String>,
    work_dir: Option<String>,
    claude_path: Option<String>,
    prompt: Option<String>,
    max_iterations: Option<u32>,
    completion_promise: Option<String>,
) -> Result<String, String> {
    log::info!(
        "[start_loop] called with work_dir={:?}, claude_path={:?}, prompt_provided={}, max_iterations={:?}, completion_promise={:?}",
        work_dir,
        claude_path,
        prompt.as_ref().map(|p| !p.trim().is_empty()).unwrap_or(false),
        max_iterations,
        completion_promise
    );

    let requested_project_id = normalize_selector(project_id);
    let current_project = {
        let mut project_state = PROJECT_STATE.lock().await;
        project_state.ensure_initialized().await.map_err(|err| {
            log::error!("[start_loop] failed to initialize project config: {}", err);
            err
        })?;

        let selected_project_id = match requested_project_id {
            Some(ref id) => id.clone(),
            None => project_state
                .config
                .current_project_id
                .clone()
                .ok_or_else(|| "请先选择一个项目".to_string())?,
        };

        project_state
            .config
            .projects
            .get(&selected_project_id)
            .cloned()
            .ok_or_else(|| format!("当前项目不存在: {}", selected_project_id))?
    };

    if !current_project.enabled {
        log::warn!(
            "[start_loop] blocked because current project is disabled: {} ({})",
            current_project.name,
            current_project.id
        );
        return Err("当前项目未启用，请先在项目卡片或主控区启用该项目".to_string());
    }

    let mut state = RUNTIME_STATE.lock().map_err(|err| {
        log::error!("[start_loop] failed to lock RUNTIME_STATE: {}", err);
        format!("Failed to access runtime state: {}", err)
    })?;

    if state.project_sessions.contains_key(&current_project.id) {
        log::warn!(
            "[start_loop] ignored because project already has running session: {}",
            current_project.id
        );
        return Ok("Loop already running for project".to_string());
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

    let resolved_claude_path = claude_path
        .as_ref()
        .map(|raw| raw.trim().to_string())
        .filter(|trimmed| !trimmed.is_empty())
        .unwrap_or_else(|| "claude".to_string());

    let mut command = CommandBuilder::new(&resolved_claude_path);
    command.arg("--dangerously-skip-permissions");
    command.arg(command_payload);

    let resolved_work_dir = work_dir
        .as_ref()
        .map(|raw| raw.trim().to_string())
        .filter(|trimmed| !trimmed.is_empty())
        .unwrap_or_else(|| current_project.work_directory.clone());

    if !Path::new(&resolved_work_dir).exists() {
        return Err(format!("工作目录不存在: {}", resolved_work_dir));
    }
    command.cwd(&resolved_work_dir);

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
        .map_err(|err| format!("Failed to start loop process with '{}': {}", resolved_claude_path, err))?;

    let pid = child.process_id();
    let reader = pty_pair
        .master
        .try_clone_reader()
        .map_err(|err| format!("Failed to open output reader: {}", err))?;
    let writer = pty_pair
        .master
        .take_writer()
        .map_err(|err| format!("Failed to open input writer: {}", err))?;

    let session_id = Uuid::new_v4().to_string();
    state.output_buffers.insert(session_id.clone(), VecDeque::new());
    state.project_sessions.insert(current_project.id.clone(), session_id.clone());
    let previous_session_id = state
        .project_last_session
        .insert(current_project.id.clone(), session_id.clone());
    if let Some(previous) = previous_session_id {
        if previous != session_id && !state.sessions.contains_key(&previous) {
            state.output_buffers.remove(&previous);
        }
    }
    state.sessions.insert(
        session_id.clone(),
        LoopSession {
            session_id: session_id.clone(),
            project_id: current_project.id.clone(),
            pid,
            child,
            writer,
            pty_master: pty_pair.master,
        },
    );
    drop(state);

    push_output_chunk(
        &session_id,
        format!("\r\n[system] loop process started, pid={:?}, session={}\r\n", pid, session_id),
    );
    spawn_output_reader(reader, session_id.clone());

    thread::sleep(Duration::from_millis(200));
    Ok(format!("Loop started (session_id={})", session_id))
}

#[tauri::command(rename_all = "snake_case")]
/// Stops the currently running loop process if present.
fn stop_loop(project_id: Option<String>, session_id: Option<String>) -> Result<String, String> {
    log::info!("[stop_loop] called");
    let normalized_project_id = normalize_selector(project_id);
    let normalized_session_id = normalize_selector(session_id);

    let mut state = RUNTIME_STATE.lock().map_err(|err| {
        log::error!("[stop_loop] failed to lock RUNTIME_STATE: {}", err);
        format!("Failed to access runtime state: {}", err)
    })?;

    let resolved_session_id = match resolve_target_session_id(
        &state,
        normalized_project_id.as_deref(),
        normalized_session_id.as_deref(),
    ) {
        Ok(session) => session,
        Err(_) => return Ok("No loop running".to_string()),
    };
    let mut session = match state.sessions.remove(&resolved_session_id) {
        Some(session) => session,
        None => return Ok("No loop running".to_string()),
    };
    state.project_sessions.remove(&session.project_id);
    let detached_session_id = session.session_id.clone();
    let detached_project_id = session.project_id.clone();
    drop(state);

    let pid = session.pid;
    session
        .child
        .kill()
        .map_err(|err| format!("Failed to stop loop process: {}", err))?;

    let _ = session.child.wait();
    push_output_chunk(
        &detached_session_id,
        format!(
            "\r\n[system] loop process stopped, project={}, pid={:?}, session={}\r\n",
            detached_project_id, pid, detached_session_id
        ),
    );
    Ok(format!("Loop stopped (session_id={})", detached_session_id))
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
async fn create_project(
    name: String,
    description: String,
    work_directory: String,
    claude_setting_id: Option<String>,
    overwrite_claude_settings: Option<bool>,
    enabled: Option<bool>,
) -> Result<Project, String> {
    let mut state = PROJECT_STATE.lock().await;
    
    // Initialize if not already done
    state.ensure_initialized().await.map_err(|err| {
        log::error!("[create_project] failed to initialize: {}", err);
        err
    })?;

    // Validate work directory
    let work_dir_path = Path::new(&work_directory);
    if work_dir_path.exists() {
        if !work_dir_path.is_dir() {
            return Err(format!("工作目录路径不是目录: {}", work_directory));
        }
    } else {
        fs::create_dir_all(work_dir_path)
            .await
            .map_err(|err| format!("创建工作目录失败 '{}': {}", work_directory, err))?;
    }

    let mut resolved_claude_setting_id = normalize_optional_string(claude_setting_id);
    if resolved_claude_setting_id.is_none() {
        if let Some(imported_setting_id) =
            import_local_workdir_setting_if_present(&mut state, &name, &work_directory).await?
        {
            resolved_claude_setting_id = Some(imported_setting_id);
        }
    }

    let selected_claude_setting = if let Some(setting_id) = resolved_claude_setting_id.as_ref() {
        Some(
            state
                .config
                .claude_settings
                .get(setting_id)
                .cloned()
                .ok_or_else(|| format!("Claude setting 文件不存在: {}", setting_id))?,
        )
    } else {
        None
    };

    let should_overwrite_claude_settings = overwrite_claude_settings.unwrap_or(false);
    if should_overwrite_claude_settings {
        let selected = selected_claude_setting.as_ref().ok_or_else(|| {
            "勾选了覆盖 .claude 配置，但未选择 Claude setting 文件".to_string()
        })?;
        apply_claude_setting_to_work_directory(&selected.file_path, &work_directory).await?;
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
        prompt_history: vec![],
        max_iterations: None,
        completion_promise: None,
        claude_setting_id: resolved_claude_setting_id,
        enabled: enabled.unwrap_or(false),
        overwrite_claude_settings_on_create: should_overwrite_claude_settings,
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

#[tauri::command]
/// Get all stored Claude setting files.
async fn get_claude_settings_files() -> Result<Vec<ClaudeSettingFile>, String> {
    let mut state = PROJECT_STATE.lock().await;

    state.ensure_initialized().await.map_err(|err| {
        log::error!("[get_claude_settings_files] failed to initialize: {}", err);
        err
    })?;

    let mut settings: Vec<ClaudeSettingFile> = state.config.claude_settings.values().cloned().collect();
    settings.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(settings)
}

#[tauri::command(rename_all = "snake_case")]
/// Create or overwrite one Claude setting file template.
async fn create_claude_settings_file(
    name: String,
    content: String,
    overwrite: Option<bool>,
) -> Result<ClaudeSettingFile, String> {
    let mut state = PROJECT_STATE.lock().await;

    state.ensure_initialized().await.map_err(|err| {
        log::error!("[create_claude_settings_file] failed to initialize: {}", err);
        err
    })?;

    let normalized_name = name.trim().to_string();
    if normalized_name.is_empty() {
        return Err("setting 名称不能为空".to_string());
    }

    let parsed_json: serde_json::Value = serde_json::from_str(content.trim())
        .map_err(|err| format!("setting 文件内容不是合法 JSON: {}", err))?;
    let pretty_content = serde_json::to_string_pretty(&parsed_json)
        .map_err(|err| format!("格式化 setting 内容失败: {}", err))?;

    let should_overwrite = overwrite.unwrap_or(false);
    let settings_dir = ensure_claude_settings_dir().await?;
    let existing_setting = state
        .config
        .claude_settings
        .values()
        .find(|setting| setting.name == normalized_name)
        .cloned();

    let now = Utc::now();
    let setting = match existing_setting {
        Some(mut existing) => {
            if !should_overwrite {
                return Err(format!(
                    "已存在同名 setting 文件: {}，如需覆盖请勾选覆盖",
                    normalized_name
                ));
            }

            existing.updated_at = now;
            existing
        }
        None => {
            let file_stem = sanitize_setting_name(&normalized_name);
            let mut file_name = format!("{}.json", file_stem);
            let mut file_path = settings_dir.join(&file_name);
            if file_path.exists() {
                file_name = format!("{}-{}.json", file_stem, &Uuid::new_v4().to_string()[..8]);
                file_path = settings_dir.join(&file_name);
            }

            ClaudeSettingFile {
                id: Uuid::new_v4().to_string(),
                name: normalized_name.clone(),
                file_name,
                file_path: file_path.to_string_lossy().to_string(),
                created_at: now,
                updated_at: now,
            }
        }
    };

    let target_path = if setting.file_path.trim().is_empty() {
        settings_dir.join(&setting.file_name)
    } else {
        PathBuf::from(&setting.file_path)
    };
    fs::write(&target_path, pretty_content)
        .await
        .map_err(|err| format!("写入 setting 文件失败 '{}': {}", target_path.display(), err))?;

    let mut stored_setting = setting.clone();
    stored_setting.file_path = target_path.to_string_lossy().to_string();
    state
        .config
        .claude_settings
        .insert(stored_setting.id.clone(), stored_setting.clone());

    if let Err(err) = state.save_config().await {
        log::error!("[create_claude_settings_file] failed to save config: {}", err);
        return Err(err);
    }

    Ok(stored_setting)
}

#[tauri::command(rename_all = "snake_case")]
/// Get one Claude setting file content by id.
async fn get_claude_settings_file_content(setting_id: String) -> Result<ClaudeSettingFileContent, String> {
    let mut state = PROJECT_STATE.lock().await;

    state.ensure_initialized().await.map_err(|err| {
        log::error!("[get_claude_settings_file_content] failed to initialize: {}", err);
        err
    })?;

    let setting = state
        .config
        .claude_settings
        .get(setting_id.trim())
        .cloned()
        .ok_or_else(|| format!("Claude setting 文件不存在: {}", setting_id))?;

    let content = fs::read_to_string(&setting.file_path)
        .await
        .map_err(|err| format!("读取 setting 文件失败 '{}': {}", setting.file_path, err))?;

    Ok(ClaudeSettingFileContent {
        id: setting.id,
        name: setting.name,
        content,
    })
}

#[tauri::command(rename_all = "snake_case")]
/// Update existing Claude setting file content (and optionally rename).
async fn update_claude_settings_file(
    setting_id: String,
    name: String,
    content: String,
) -> Result<ClaudeSettingFile, String> {
    let mut state = PROJECT_STATE.lock().await;

    state.ensure_initialized().await.map_err(|err| {
        log::error!("[update_claude_settings_file] failed to initialize: {}", err);
        err
    })?;

    let normalized_name = name.trim().to_string();
    if normalized_name.is_empty() {
        return Err("setting 名称不能为空".to_string());
    }

    let parsed_json: serde_json::Value = serde_json::from_str(content.trim())
        .map_err(|err| format!("setting 文件内容不是合法 JSON: {}", err))?;
    let pretty_content = serde_json::to_string_pretty(&parsed_json)
        .map_err(|err| format!("格式化 setting 内容失败: {}", err))?;

    let normalized_id = setting_id.trim().to_string();
    if normalized_id.is_empty() {
        return Err("setting_id 不能为空".to_string());
    }

    if state
        .config
        .claude_settings
        .values()
        .any(|item| item.id != normalized_id && item.name == normalized_name)
    {
        return Err(format!("已存在同名 setting 文件: {}", normalized_name));
    }

    let previous_setting = state
        .config
        .claude_settings
        .get(&normalized_id)
        .cloned()
        .ok_or_else(|| format!("Claude setting 文件不存在: {}", normalized_id))?;

    let updated_setting = {
        let setting = state
            .config
            .claude_settings
            .get_mut(&normalized_id)
            .ok_or_else(|| format!("Claude setting 文件不存在: {}", normalized_id))?;

        setting.name = normalized_name;
        setting.updated_at = Utc::now();
        setting.clone()
    };

    if let Err(err) = fs::write(&updated_setting.file_path, pretty_content).await {
        state
            .config
            .claude_settings
            .insert(normalized_id.clone(), previous_setting.clone());
        return Err(format!(
            "写入 setting 文件失败 '{}': {}",
            updated_setting.file_path, err
        ));
    }

    if let Err(err) = state.save_config().await {
        state
            .config
            .claude_settings
            .insert(normalized_id, previous_setting);
        log::error!("[update_claude_settings_file] failed to save config: {}", err);
        return Err(err);
    }

    Ok(updated_setting)
}

#[tauri::command(rename_all = "snake_case")]
/// Delete one Claude setting file, and auto-detach it from referenced projects.
async fn delete_claude_settings_file(setting_id: String) -> Result<String, String> {
    let mut state = PROJECT_STATE.lock().await;

    state.ensure_initialized().await.map_err(|err| {
        log::error!("[delete_claude_settings_file] failed to initialize: {}", err);
        err
    })?;

    let normalized_id = setting_id.trim().to_string();
    if normalized_id.is_empty() {
        return Err("setting_id 不能为空".to_string());
    }

    let previous_projects = state.config.projects.clone();

    let removed = state
        .config
        .claude_settings
        .remove(&normalized_id)
        .ok_or_else(|| format!("Claude setting 文件不存在: {}", normalized_id))?;

    let referenced_count = state
        .config
        .projects
        .values()
        .filter(|project| project.claude_setting_id.as_deref() == Some(normalized_id.as_str()))
        .count();
    if referenced_count > 0 {
        let now = Utc::now();
        state.config.projects.values_mut().for_each(|project| {
            if project.claude_setting_id.as_deref() == Some(normalized_id.as_str()) {
                project.claude_setting_id = None;
                project.updated_at = now;
            }
        });
        log::info!(
            "[delete_claude_settings_file] auto-detached setting={} from {} projects",
            normalized_id,
            referenced_count
        );
    }

    if let Err(err) = fs::remove_file(&removed.file_path).await {
        if err.kind() != std::io::ErrorKind::NotFound {
            state
                .config
                .claude_settings
                .insert(normalized_id, removed.clone());
            state.config.projects = previous_projects;
            return Err(format!("删除 setting 文件失败 '{}': {}", removed.file_path, err));
        }
    }

    if let Err(err) = state.save_config().await {
        state
            .config
            .claude_settings
            .insert(removed.id.clone(), removed);
        state.config.projects = previous_projects;
        log::error!("[delete_claude_settings_file] failed to save config: {}", err);
        return Err(err);
    }

    Ok("setting 文件删除成功".to_string())
}

#[tauri::command(rename_all = "snake_case")]
/// Update an existing project
async fn update_project(
    project_id: String,
    name: String,
    description: String,
    work_directory: String,
    max_iterations: Option<u32>,
    completion_promise: Option<String>,
    last_prompt: Option<String>,
    claude_setting_id: Option<String>,
    overwrite_claude_settings: Option<bool>,
    enabled: Option<bool>,
) -> Result<Project, String> {
    let mut state = PROJECT_STATE.lock().await;
    
    // Initialize if not already done
    state.ensure_initialized().await.map_err(|err| {
        log::error!("[update_project] failed to initialize: {}", err);
        err
    })?;

    // Validate work directory
    let work_dir_path = Path::new(&work_directory);
    if work_dir_path.exists() {
        if !work_dir_path.is_dir() {
            return Err(format!("工作目录路径不是目录: {}", work_directory));
        }
    } else {
        fs::create_dir_all(work_dir_path)
            .await
            .map_err(|err| format!("创建工作目录失败 '{}': {}", work_directory, err))?;
    }

    let normalized_claude_setting_update = match claude_setting_id {
        Some(raw_setting_id) => {
            let trimmed = raw_setting_id.trim();
            if trimmed.is_empty() {
                Some(None)
            } else {
                if !state.config.claude_settings.contains_key(trimmed) {
                    return Err(format!("Claude setting 文件不存在: {}", trimmed));
                }
                Some(Some(trimmed.to_string()))
            }
        }
        None => None,
    };

    // Snapshot previous project for rollback on later failures.
    let previous_project = state.config.projects.get(&project_id).cloned().ok_or_else(|| {
        format!("项目不存在: {}", project_id)
    })?;

    // Update project fields
    let updated_project = {
        let project = state.config.projects.get_mut(&project_id).ok_or_else(|| {
            format!("项目不存在: {}", project_id)
        })?;

        project.name = name;
        project.description = description;
        project.work_directory = work_directory;
        project.updated_at = Utc::now();
        project.max_iterations = max_iterations;
        project.completion_promise = completion_promise;
        if let Some(prompt) = last_prompt {
            let trimmed_prompt = prompt.trim();
            project.last_prompt = if trimmed_prompt.is_empty() {
                None
            } else {
                Some(prompt)
            };
        }
        if let Some(setting_update) = normalized_claude_setting_update {
            project.claude_setting_id = setting_update;
        }
        if let Some(overwrite) = overwrite_claude_settings {
            project.overwrite_claude_settings_on_create = overwrite;
        }
        if let Some(project_enabled) = enabled {
            project.enabled = project_enabled;
        }

        project.clone()
    };

    if overwrite_claude_settings.unwrap_or(false) {
        let setting_id = updated_project
            .claude_setting_id
            .as_ref()
            .ok_or_else(|| "勾选了覆盖 .claude 配置，但项目未绑定 Claude setting 文件".to_string())?;
        let setting_file = state
            .config
            .claude_settings
            .get(setting_id)
            .cloned()
            .ok_or_else(|| format!("Claude setting 文件不存在: {}", setting_id))?;
        if let Err(err) = apply_claude_setting_to_work_directory(
            &setting_file.file_path,
            &updated_project.work_directory,
        )
        .await
        {
            state
                .config
                .projects
                .insert(project_id.clone(), previous_project.clone());
            return Err(err);
        }
    }

    // Save config
    if let Err(e) = state.save_config().await {
        state
            .config
            .projects
            .insert(project_id.clone(), previous_project.clone());
        log::error!("[update_project] failed to save config: {}", e);
        return Err(e);
    }

    log::info!("[update_project] updated project: {} ({})", updated_project.name, project_id);
    Ok(updated_project)
}

#[tauri::command(rename_all = "snake_case")]
/// Records one prompt usage entry for the project and keeps de-duplicated history.
async fn record_prompt_usage(project_id: String, prompt: String) -> Result<Project, String> {
    let mut state = PROJECT_STATE.lock().await;

    state.ensure_initialized().await.map_err(|err| {
        log::error!("[record_prompt_usage] failed to initialize: {}", err);
        err
    })?;

    let normalized_project_id = project_id.trim().to_string();
    if normalized_project_id.is_empty() {
        return Err("project_id 不能为空".to_string());
    }

    let normalized_prompt = prompt.trim().to_string();
    if normalized_prompt.is_empty() {
        return Err("提示词不能为空".to_string());
    }

    let previous_project = state
        .config
        .projects
        .get(&normalized_project_id)
        .cloned()
        .ok_or_else(|| format!("项目不存在: {}", normalized_project_id))?;

    let now = Utc::now();
    let updated_project = {
        let project = state
            .config
            .projects
            .get_mut(&normalized_project_id)
            .ok_or_else(|| format!("项目不存在: {}", normalized_project_id))?;

        project
            .prompt_history
            .retain(|item| item.prompt.trim() != normalized_prompt);
        project.prompt_history.push(PromptHistoryEntry {
            prompt: normalized_prompt.clone(),
            used_at: now,
        });
        project
            .prompt_history
            .sort_by(|left, right| right.used_at.cmp(&left.used_at));
        if project.prompt_history.len() > PROMPT_HISTORY_LIMIT {
            project.prompt_history.truncate(PROMPT_HISTORY_LIMIT);
        }
        project.last_prompt = Some(normalized_prompt.clone());
        project.updated_at = now;
        project.clone()
    };

    if let Err(err) = state.save_config().await {
        state
            .config
            .projects
            .insert(normalized_project_id.clone(), previous_project);
        log::error!(
            "[record_prompt_usage] failed to save config for project {}: {}",
            normalized_project_id,
            err
        );
        return Err(err);
    }

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

    drop(state);

    // Best-effort cleanup for runtime sessions/buffers bound to this project.
    let _ = stop_loop(Some(project_id.clone()), None);
    if let Ok(mut runtime_state) = RUNTIME_STATE.lock() {
        if let Some(last_session_id) = runtime_state.project_last_session.remove(&project_id) {
            if !runtime_state.sessions.contains_key(&last_session_id) {
                runtime_state.output_buffers.remove(&last_session_id);
            }
        }
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
            inspect_claude_runtime_context,
            optimize_prompt,
            optimize_prompt_api,
            detect_claude_cli_path,
            get_project_enabled,
            set_project_enabled,
            get_runtime_debug_state,
            get_projects,
            create_project,
            get_claude_settings_files,
            create_claude_settings_file,
            get_claude_settings_file_content,
            update_claude_settings_file,
            delete_claude_settings_file,
            update_project,
            record_prompt_usage,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_enabled_defaults_to_false_when_missing_in_json() {
        let raw = r#"
        {
          "id": "p1",
          "name": "demo",
          "description": "desc",
          "work_directory": "/tmp/demo",
          "created_at": "2024-01-01T00:00:00Z",
          "updated_at": "2024-01-01T00:00:00Z",
          "last_prompt": null,
          "prompt_history": [],
          "max_iterations": null,
          "completion_promise": null,
          "claude_setting_id": null
        }
        "#;

        let project: Project = serde_json::from_str(raw).expect("project json should parse");
        assert!(!project.enabled);
        assert!(!project.overwrite_claude_settings_on_create);
    }

    #[test]
    fn project_enabled_uses_explicit_value_from_json() {
        let raw = r#"
        {
          "id": "p2",
          "name": "demo2",
          "description": "desc",
          "work_directory": "/tmp/demo2",
          "created_at": "2024-01-01T00:00:00Z",
          "updated_at": "2024-01-01T00:00:00Z",
          "last_prompt": null,
          "prompt_history": [],
          "max_iterations": null,
          "completion_promise": null,
          "claude_setting_id": null,
          "enabled": true
        }
        "#;

        let project: Project = serde_json::from_str(raw).expect("project json should parse");
        assert!(project.enabled);
    }

    #[test]
    fn project_prompt_history_defaults_to_empty_when_missing_in_json() {
        let raw = r#"
        {
          "id": "p3",
          "name": "demo3",
          "description": "desc",
          "work_directory": "/tmp/demo3",
          "created_at": "2024-01-01T00:00:00Z",
          "updated_at": "2024-01-01T00:00:00Z",
          "last_prompt": null,
          "max_iterations": null,
          "completion_promise": null,
          "claude_setting_id": null
        }
        "#;

        let project: Project = serde_json::from_str(raw).expect("project json should parse");
        assert!(project.prompt_history.is_empty());
    }
}
