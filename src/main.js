/**
 * Main application entry point for Ralph Loop Editor
 * Integrates xterm.js terminal component with Tauri backend
 */

import { createIcons, Play, Pause, Square, ToggleLeft, ToggleRight, Plus, X, Terminal, Bug, Send, Edit2, Trash2 } from 'lucide';
import { TerminalComponent } from './js/terminal.js';
import { ProjectManager } from './js/project-manager.js';

const icons = {
  Play,
  Pause,
  Square,
  ToggleLeft,
  ToggleRight,
  Plus,
  X,
  Terminal,
  Bug,
  Send,
  Edit2,
  Trash2
};
let invoke = null;
let terminalComponent = null;
let projectManager = null;
let currentProjectEnabled = false;
let runningProjectIds = new Set();
let runningSessions = [];
let outputPollTimer = null;
let statePollTimer = null;
let lastBackendStateSignature = '';
let projectAutoSaveTimer = null;
let projectAutoSaveInFlight = false;
let projectAutoSavePending = false;
let outputPollInFlight = false;
let autoRestartInFlight = false;
const manualStopProjectIds = new Set();
const autoCompletionStopInFlightProjectIds = new Set();
const activeCompletionPromiseByProject = new Map();
const recentOutputByProject = new Map();
const runStartAtByProject = new Map();
const waitingStateSeenAtByProject = new Map();
const lastOutputAtByProject = new Map();
const PROJECT_AUTO_SAVE_DELAY_MS = 700;
const TERMINAL_HISTORY_LIMIT = 200_000;
const AUTO_NEXT_LOOP_ENABLED = true;
const AUTO_NEXT_LOOP_DELAY_MS = 1200;
const AUTO_COMPLETION_WAITING_MARKERS = ['循环等待指令中', '等待指令', 'waiting for input'];
const AUTO_COMPLETION_MIN_RUNTIME_MS = 8000;
const AUTO_COMPLETION_WAITING_GRACE_MS = 3000;
const DEFAULT_AUTO_IDLE_NEXT_LOOP_MS = 45_000;
const DEFAULT_AUTO_HARD_STOP_MS = 15 * 60 * 1000;
const IDLE_NEXT_TIMEOUT_STORAGE_KEY = 'ralph_loop_idle_next_timeout_ms';
const HARD_STOP_TIMEOUT_STORAGE_KEY = 'ralph_loop_hard_stop_timeout_ms';
const TERMINAL_FOCUS_CONTROL_SEQUENCES = new Set(['\u001b[I', '\u001b[O']);
const terminalHistoryByProject = new Map();
let autoIdleNextLoopMs = DEFAULT_AUTO_IDLE_NEXT_LOOP_MS;
let autoHardStopMs = DEFAULT_AUTO_HARD_STOP_MS;
let runtimeCountdownTimer = null;

function getCurrentProject() {
  return projectManager?.getCurrentProject() || null;
}

function isProjectRunning(projectId) {
  return Boolean(projectId) && runningProjectIds.has(projectId);
}

function isCurrentProjectRunning() {
  const currentProject = getCurrentProject();
  return isProjectRunning(currentProject?.id || null);
}

function getRunningSessionByProject(projectId) {
  if (!projectId) {
    return null;
  }
  return runningSessions.find((session) => session.project_id === projectId) || null;
}

function getRunningSessionById(sessionId) {
  if (!sessionId) {
    return null;
  }
  return runningSessions.find((session) => session.session_id === sessionId) || null;
}

function renderRunningSessionsBar() {
  if (!runningSessionsContainer || !runningSessionsList) {
    return;
  }

  if (runningProjectIds.size === 0) {
    runningSessionsContainer.hidden = true;
    runningSessionsList.innerHTML = '';
    return;
  }

  const currentProjectId = getCurrentProject()?.id || null;
  const projects = projectManager?.getProjects?.() || [];
  const projectNameMap = new Map(projects.map((project) => [project.id, project.name]));
  const sortedProjectIds = Array.from(runningProjectIds).sort((left, right) => {
    const leftName = (projectNameMap.get(left) || left).toLowerCase();
    const rightName = (projectNameMap.get(right) || right).toLowerCase();
    return leftName.localeCompare(rightName);
  });

  runningSessionsList.innerHTML = '';
  sortedProjectIds.forEach((projectId) => {
    const projectName = projectNameMap.get(projectId) || projectId;
    const session = getRunningSessionByProject(projectId);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `running-session-chip${currentProjectId === projectId ? ' active' : ''}`;
    chip.title = `切换到 ${projectName}（Alt+点击可停止该任务）`;

    const name = document.createElement('span');
    name.textContent = projectName;
    chip.appendChild(name);

    if (session?.pid) {
      const pid = document.createElement('span');
      pid.className = 'running-session-pid';
      pid.textContent = `PID ${session.pid}`;
      chip.appendChild(pid);
    }

    chip.addEventListener('click', (event) => {
      if (event.altKey) {
        void handleStop({ projectId, sessionId: session?.session_id || null });
        return;
      }
      if (currentProjectId === projectId) {
        return;
      }
      void projectManager?.setCurrentProject(projectId);
    });

    runningSessionsList.appendChild(chip);
  });
  runningSessionsContainer.hidden = false;
}

function appendProjectTerminalOutput(projectId, chunk) {
  if (!projectId || !chunk) {
    return;
  }

  const previous = terminalHistoryByProject.get(projectId) || '';
  const merged = previous + chunk;
  terminalHistoryByProject.set(
    projectId,
    merged.length > TERMINAL_HISTORY_LIMIT ? merged.slice(-TERMINAL_HISTORY_LIMIT) : merged
  );

  const currentProject = getCurrentProject();
  if (currentProject && currentProject.id === projectId) {
    appendTerminalOutput(chunk);
  }
}

function clearTerminalView() {
  if (terminalComponent && terminalComponent.isInitialized()) {
    terminalComponent.clear();
  } else {
    terminalOutput.textContent = '';
  }
}

function renderSelectedProjectTerminalHistory(project) {
  clearTerminalView();
  if (!project) {
    return;
  }

  const history = terminalHistoryByProject.get(project.id) || '';
  if (history) {
    appendTerminalOutput(history);
  }
}

/**
 * Refresh all Lucide icons on the page
 */
function refreshPageIcons() {
  try {
    // Always use ES-module imported icons to avoid CDN conflicts
    createIcons({
      icons,
      nameAttr: 'data-lucide',
      attrs: {
        'stroke-width': 2,
      }
    });
  } catch (err) {
    console.error('Failed to refresh icons:', err);
  }
}

// DOM elements
const toggleBtn = document.getElementById('toggle-btn');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const statusDiv = document.getElementById('status');
const workDirInput = document.getElementById('work-dir');
const promptInput = document.getElementById('prompt');
const maxIterationsInput = document.getElementById('max-iterations');
const completionPromiseInput = document.getElementById('completion-promise');
const idleNextTimeoutInput = document.getElementById('idle-next-timeout-seconds');
const hardStopTimeoutInput = document.getElementById('hard-stop-timeout-seconds');
const idleNextCountdown = document.getElementById('idle-next-countdown');
const hardStopCountdown = document.getElementById('hard-stop-countdown');
const terminalOutput = document.getElementById('terminal-output');
const terminalInput = document.getElementById('terminal-input');
const sendBtn = document.getElementById('send-btn');
const debugLog = document.getElementById('debug-log');
const tabTerminal = document.getElementById('tab-terminal');
const tabDebug = document.getElementById('tab-debug');
const panelTerminal = document.getElementById('panel-terminal');
const panelDebug = document.getElementById('panel-debug');
const runningSessionsContainer = document.getElementById('running-sessions');
const runningSessionsList = document.getElementById('running-sessions-list');

/**
 * Returns the Tauri invoke function if available.
 * Supports both Tauri v2 internals and legacy runtime globals.
 */
function getInvoke() {
  const tauriInternals = window.__TAURI_INTERNALS__;
  if (tauriInternals && typeof tauriInternals.invoke === 'function') {
    return tauriInternals.invoke;
  }

  const tauriCore = window.__TAURI__ && window.__TAURI__.core;
  if (tauriCore && typeof tauriCore.invoke === 'function') {
    return tauriCore.invoke;
  }

  const hasTauri = Boolean(window.__TAURI__);
  const hasInternals = Boolean(window.__TAURI_INTERNALS__);
  throw new Error(
    `Tauri runtime is not available. has__TAURI__=${hasTauri}, has__TAURI_INTERNALS__=${hasInternals}.`
  );
}

/**
 * Serializes any debug value into a readable string.
 */
function serializeDebugValue(value) {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return String(value);
  }
}

/**
 * Appends one timestamped debug message.
 */
function appendDebugLog(message, data) {
  const timestamp = new Date().toISOString();
  const payload = data === undefined ? '' : ` | ${serializeDebugValue(data)}`;
  const line = `[${timestamp}] ${message}${payload}`;
  console.log(line);
  debugLog.textContent += `${line}\n`;
  debugLog.scrollTop = debugLog.scrollHeight;
}

/**
 * Appends terminal text output to the terminal component.
 */
function appendTerminalOutput(chunk) {
  if (!chunk) {
    return;
  }

  if (terminalComponent && terminalComponent.isInitialized()) {
    terminalComponent.write(chunk);
  } else {
    // Fallback to basic rendering
    const cleaned = chunk
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
      .replace(/\u001b[@-Z\\-_]/g, '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g, '');
    terminalOutput.textContent += cleaned;
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
  }
}

/**
 * Removes ANSI control sequences from one string.
 */
function stripAnsi(text) {
  if (!text) {
    return '';
  }
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '');
}

function parseTimeoutMsFromStorage(storageKey, fallbackMs) {
  const raw = window.localStorage.getItem(storageKey);
  if (!raw) {
    return fallbackMs;
  }
  const parsed = parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallbackMs;
  }
  return parsed;
}

function normalizeTimeoutSecondsFromInput(rawValue, fallbackMs) {
  const parsed = parseInt(String(rawValue || '').trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return Math.floor(fallbackMs / 1000);
  }
  return parsed;
}

function formatDurationSeconds(totalSeconds) {
  if (totalSeconds <= 0) {
    return '0s';
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function updateRuntimeCountdownDisplay() {
  if (!idleNextCountdown || !hardStopCountdown) {
    return;
  }

  const currentProject = getCurrentProject();
  if (!currentProject || !isProjectRunning(currentProject.id)) {
    const idleBase = autoIdleNextLoopMs > 0
      ? `Idle countdown: waiting run (${formatDurationSeconds(Math.ceil(autoIdleNextLoopMs / 1000))})`
      : 'Idle countdown: disabled';
    const hardBase = autoHardStopMs > 0
      ? `Hard stop countdown: waiting run (${formatDurationSeconds(Math.ceil(autoHardStopMs / 1000))})`
      : 'Hard stop countdown: disabled';
    idleNextCountdown.textContent = idleBase;
    hardStopCountdown.textContent = hardBase;
    return;
  }

  const projectId = currentProject.id;
  const now = Date.now();
  const startedAt = runStartAtByProject.get(projectId) || now;
  const lastOutputAt = lastOutputAtByProject.get(projectId) || startedAt;
  const idleRemainingMs = autoIdleNextLoopMs > 0 ? autoIdleNextLoopMs - (now - lastOutputAt) : null;
  const hardRemainingMs = autoHardStopMs > 0 ? autoHardStopMs - (now - startedAt) : null;

  idleNextCountdown.textContent = autoIdleNextLoopMs > 0
    ? `Idle countdown: ${formatDurationSeconds(Math.max(0, Math.ceil((idleRemainingMs || 0) / 1000)))}`
    : 'Idle countdown: disabled';
  hardStopCountdown.textContent = autoHardStopMs > 0
    ? `Hard stop countdown: ${formatDurationSeconds(Math.max(0, Math.ceil((hardRemainingMs || 0) / 1000)))}`
    : 'Hard stop countdown: disabled';
}

function applyIdleNextTimeoutInput(options = {}) {
  const { persist = true, announce = true } = options;
  if (!idleNextTimeoutInput) {
    return;
  }
  const seconds = normalizeTimeoutSecondsFromInput(idleNextTimeoutInput.value, DEFAULT_AUTO_IDLE_NEXT_LOOP_MS);
  autoIdleNextLoopMs = seconds * 1000;
  idleNextTimeoutInput.value = String(seconds);
  if (persist) {
    window.localStorage.setItem(IDLE_NEXT_TIMEOUT_STORAGE_KEY, String(autoIdleNextLoopMs));
  }
  if (announce) {
    appendDebugLog('idle-next timeout updated', {
      seconds,
      enabled: seconds > 0
    });
  }
  updateRuntimeCountdownDisplay();
}

function applyHardStopTimeoutInput(options = {}) {
  const { persist = true, announce = true } = options;
  if (!hardStopTimeoutInput) {
    return;
  }
  const seconds = normalizeTimeoutSecondsFromInput(hardStopTimeoutInput.value, DEFAULT_AUTO_HARD_STOP_MS);
  autoHardStopMs = seconds * 1000;
  hardStopTimeoutInput.value = String(seconds);
  if (persist) {
    window.localStorage.setItem(HARD_STOP_TIMEOUT_STORAGE_KEY, String(autoHardStopMs));
  }
  if (announce) {
    appendDebugLog('hard-stop timeout updated', {
      seconds,
      enabled: seconds > 0
    });
  }
  updateRuntimeCountdownDisplay();
}

function initializeRuntimeTimeoutControls() {
  autoIdleNextLoopMs = parseTimeoutMsFromStorage(IDLE_NEXT_TIMEOUT_STORAGE_KEY, DEFAULT_AUTO_IDLE_NEXT_LOOP_MS);
  autoHardStopMs = parseTimeoutMsFromStorage(HARD_STOP_TIMEOUT_STORAGE_KEY, DEFAULT_AUTO_HARD_STOP_MS);
  if (idleNextTimeoutInput) {
    idleNextTimeoutInput.value = String(Math.floor(autoIdleNextLoopMs / 1000));
  }
  if (hardStopTimeoutInput) {
    hardStopTimeoutInput.value = String(Math.floor(autoHardStopMs / 1000));
  }
  updateRuntimeCountdownDisplay();
  appendDebugLog('runtime timeout controls initialized', {
    idle_next_seconds: Math.floor(autoIdleNextLoopMs / 1000),
    hard_stop_seconds: Math.floor(autoHardStopMs / 1000)
  });
}

/**
 * Initializes the terminal component.
 */
async function initTerminal() {
  try {
    terminalComponent = new TerminalComponent(terminalOutput);

    // Set resize callback to notify backend of terminal size changes
    terminalComponent.setResizeCallback(async (cols, rows) => {
      try {
        const currentProject = getCurrentProject();
        if (!currentProject || !isProjectRunning(currentProject.id)) {
          return;
        }
        const runningSession = getRunningSessionByProject(currentProject.id);
        // Notify backend of new terminal size for PTY adjustment
        await invoke('resize_pty', {
          cols,
          rows,
          project_id: currentProject.id,
          session_id: runningSession?.session_id || null
        });
      } catch (err) {
        // Ignore resize errors - backend might not support this command
        console.debug('PTY resize notification failed:', err);
      }
    });

    await terminalComponent.init();

    // Setup input handling
    terminalComponent.setupInput((data) => {
      if (TERMINAL_FOCUS_CONTROL_SEQUENCES.has(data)) {
        return;
      }
      // Forward terminal input to backend when running
      const currentProject = getCurrentProject();
      if (currentProject && isProjectRunning(currentProject.id)) {
        const runningSession = getRunningSessionByProject(currentProject.id);
        sendLoopInput(data, currentProject.id, runningSession?.session_id || null);
      }
    });

    appendDebugLog('Terminal component initialized successfully');
  } catch (error) {
    appendDebugLog('Terminal initialization failed, using fallback', error);
    // Ensure basic terminal styling for fallback
    terminalOutput.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
    terminalOutput.style.fontSize = '13px';
    terminalOutput.style.lineHeight = '1.5';
    terminalOutput.style.color = '#e2e8f0';
    terminalOutput.style.whiteSpace = 'pre-wrap';
    terminalOutput.style.wordBreak = 'break-word';
    terminalOutput.style.padding = '12px';
    terminalOutput.style.overflow = 'auto';
  }
}

/**
 * Switches between terminal and debug log tabs.
 */
function switchLogTab(tab) {
  const showTerminal = tab === 'terminal';
  panelTerminal.hidden = !showTerminal;
  panelDebug.hidden = showTerminal;
  tabTerminal.classList.toggle('active', showTerminal);
  tabDebug.classList.toggle('active', !showTerminal);

  // Focus terminal when switching to terminal tab
  if (showTerminal && terminalComponent) {
    terminalComponent.focus();
  }
}

/**
 * Invokes a backend command and records lifecycle logs.
 */
async function invokeWithDebug(command, args) {
  if (!invoke) {
    throw new Error('Tauri invoke is unavailable.');
  }

  appendDebugLog(`invoke:start ${command}`, args);
  const startedAt = Date.now();
  try {
    const result = await invoke(command, args);
    appendDebugLog(`invoke:success ${command} (${Date.now() - startedAt}ms)`, result);
    return result;
  } catch (err) {
    appendDebugLog(`invoke:failed ${command} (${Date.now() - startedAt}ms)`, err);
    throw err;
  }
}

/**
 * Pulls runtime state from backend and logs it.
 */
async function refreshBackendDebugState() {
  try {
    const state = await invokeWithDebug('get_runtime_debug_state');
    const previousCurrentRunning = isCurrentProjectRunning();
    const previousCurrentProjectId = getCurrentProject()?.id || null;
    const hasCurrentProjectEnabled = state.current_project_enabled !== null && state.current_project_enabled !== undefined;
    currentProjectEnabled = hasCurrentProjectEnabled ? Boolean(state.current_project_enabled) : false;
    runningProjectIds = new Set(Array.isArray(state.running_project_ids) ? state.running_project_ids : []);
    runningSessions = Array.isArray(state.running_sessions) ? state.running_sessions : [];
    const now = Date.now();
    runningSessions.forEach((session) => {
      if (!runStartAtByProject.has(session.project_id)) {
        runStartAtByProject.set(session.project_id, now);
      }
      if (!lastOutputAtByProject.has(session.project_id)) {
        lastOutputAtByProject.set(session.project_id, now);
      }
    });

    if (projectManager && state.current_project_id && hasCurrentProjectEnabled) {
      projectManager.updateProjectEnabledState(state.current_project_id, currentProjectEnabled);
    }

    const stateSignature = JSON.stringify(state);
    if (stateSignature !== lastBackendStateSignature) {
      appendDebugLog('backend-state', state);
      lastBackendStateSignature = stateSignature;
    }

    if (previousCurrentRunning && !isCurrentProjectRunning()) {
      appendDebugLog('current project stopped');
      const stoppedProjectId = previousCurrentProjectId;
      if (stoppedProjectId) {
        recentOutputByProject.delete(stoppedProjectId);
        activeCompletionPromiseByProject.delete(stoppedProjectId);
        autoCompletionStopInFlightProjectIds.delete(stoppedProjectId);
        runStartAtByProject.delete(stoppedProjectId);
        waitingStateSeenAtByProject.delete(stoppedProjectId);
        lastOutputAtByProject.delete(stoppedProjectId);
        void triggerAutoNextLoop(stoppedProjectId);
      }
    }

    void inspectHardTimeoutForCurrentProject();
    void inspectIdleForCurrentProject();
    syncUI();
  } catch (err) {
    appendDebugLog('backend-state failed', err);
  }
}

/**
 * Polls and flushes new loop output chunks into the terminal panel.
 */
async function pollLoopOutput() {
  if (outputPollInFlight) {
    return;
  }
  if (runningProjectIds.size === 0) {
    return;
  }

  outputPollInFlight = true;

  try {
    const pollingSessions = runningSessions.slice();
    const responses = await Promise.all(
      pollingSessions.map(async (session) => {
        const chunks = await invoke('poll_loop_output', {
          project_id: session.project_id,
          session_id: session.session_id
        });
        return { session, chunks };
      })
    );

    responses.forEach(({ session, chunks }) => {
      if (!Array.isArray(chunks) || chunks.length === 0) {
        return;
      }
      chunks.forEach((chunk) => {
        const text = String(chunk);
        lastOutputAtByProject.set(session.project_id, Date.now());
        appendProjectTerminalOutput(session.project_id, text);
        void inspectOutputForAutoCompletion(session.project_id, text);
      });
    });
  } catch (err) {
    appendDebugLog('poll_loop_output failed', err);
  } finally {
    outputPollInFlight = false;
  }
}

/**
 * Poll output once for the selected project.
 */
async function pollCurrentProjectOutput() {
  const currentProject = getCurrentProject();
  if (!currentProject) {
    return;
  }
  const runningSession = getRunningSessionByProject(currentProject.id);

  try {
    const chunks = await invoke('poll_loop_output', {
      project_id: currentProject.id,
      session_id: runningSession?.session_id || null
    });
    if (Array.isArray(chunks) && chunks.length > 0) {
      chunks.forEach((chunk) => appendProjectTerminalOutput(currentProject.id, String(chunk)));
    }
  } catch (err) {
    appendDebugLog('poll_loop_output failed', err);
  }
}

/**
 * Starts periodic polling for runtime state and process output.
 */
function startPolling() {
  if (!outputPollTimer) {
    outputPollTimer = window.setInterval(() => {
      void pollLoopOutput();
    }, 250);
  }

  if (!statePollTimer) {
    statePollTimer = window.setInterval(() => {
      void refreshBackendDebugState();
    }, 3000);
  }

  if (!runtimeCountdownTimer) {
    runtimeCountdownTimer = window.setInterval(() => {
      updateRuntimeCountdownDisplay();
      void inspectHardTimeoutForCurrentProject();
      void inspectIdleForCurrentProject();
    }, 1000);
  }
}

/**
 * Stops periodic polling.
 */
function stopPolling() {
  if (outputPollTimer) {
    clearInterval(outputPollTimer);
    outputPollTimer = null;
  }
  if (statePollTimer) {
    clearInterval(statePollTimer);
    statePollTimer = null;
  }
  if (runtimeCountdownTimer) {
    clearInterval(runtimeCountdownTimer);
    runtimeCountdownTimer = null;
  }
}

/**
 * Synchronizes the visual state with the in-memory state flags.
 */
function syncUI() {
  const currentProject = getCurrentProject();
  const hasCurrentProject = Boolean(currentProject);
  const currentProjectRunning = hasCurrentProject && isProjectRunning(currentProject.id);
  const runningCount = runningProjectIds.size;
  toggleBtn.disabled = !hasCurrentProject || currentProjectRunning;
  toggleBtn.innerHTML = `<i data-lucide="${currentProjectEnabled ? 'toggle-right' : 'toggle-left'}"></i> ${currentProjectEnabled ? 'Disable Project' : 'Enable Project'}`;
  startBtn.disabled = !hasCurrentProject || !currentProjectEnabled || currentProjectRunning;
  stopBtn.disabled = !currentProjectRunning;
  sendBtn.disabled = !currentProjectRunning;
  terminalInput.disabled = !currentProjectRunning;
  workDirInput.disabled = currentProjectRunning;
  promptInput.disabled = currentProjectRunning;
  maxIterationsInput.disabled = currentProjectRunning;
  completionPromiseInput.disabled = currentProjectRunning;
  statusDiv.className = 'status';

  if (currentProjectRunning) {
    statusDiv.classList.add('running');
    statusDiv.textContent = `Status: Running (${runningCount} task${runningCount === 1 ? '' : 's'})`;
  } else if (!hasCurrentProject) {
    statusDiv.classList.add('disabled');
    statusDiv.textContent = 'Status: No Project Selected';
  } else if (runningCount > 0) {
    statusDiv.classList.add('enabled');
    statusDiv.textContent = `Status: Current Idle (${runningCount} task${runningCount === 1 ? '' : 's'} running)`;
  } else if (currentProjectEnabled) {
    statusDiv.classList.add('enabled');
    statusDiv.textContent = 'Status: Project Enabled';
  } else {
    statusDiv.classList.add('disabled');
    statusDiv.textContent = 'Status: Project Disabled';
  }

  renderRunningSessionsBar();

  // Refresh icons for modified buttons
  refreshPageIcons();

  // Update project running states
  if (projectManager) {
    projectManager.updateAllProjectsRunningState(Array.from(runningProjectIds));
  }
  updateRuntimeCountdownDisplay();
}

/**
 * Cancels pending debounced project auto-save timer.
 */
function cancelProjectAutoSave() {
  if (projectAutoSaveTimer) {
    clearTimeout(projectAutoSaveTimer);
    projectAutoSaveTimer = null;
  }
}

/**
 * Builds update payload from current right-side form values.
 */
function buildProjectFormUpdatePayload(currentProject) {
  const normalizedWorkDir = workDirInput.value.trim();
  const promptText = promptInput.value;
  const normalizedPrompt = promptText.trim();
  const maxIterationsRaw = maxIterationsInput.value.trim();
  const parsedIterations = maxIterationsRaw ? parseInt(maxIterationsRaw, 10) : null;
  const normalizedMaxIterations = Number.isInteger(parsedIterations) && parsedIterations > 0
    ? parsedIterations
    : null;
  const normalizedCompletionPromise = completionPromiseInput.value.trim() || null;

  return {
    name: currentProject.name,
    description: currentProject.description,
    workDirectory: normalizedWorkDir || currentProject.work_directory,
    maxIterations: normalizedMaxIterations,
    completionPromise: normalizedCompletionPromise,
    lastPrompt: normalizedPrompt ? promptText : null,
  };
}

/**
 * Returns whether right-side form values differ from current project state.
 */
function hasProjectFormChanges(currentProject, payload) {
  const currentMaxIterations = currentProject.max_iterations ?? null;
  const currentCompletionPromise = currentProject.completion_promise ?? null;
  const currentLastPrompt = currentProject.last_prompt ?? null;
  return (
    payload.workDirectory !== currentProject.work_directory ||
    payload.maxIterations !== currentMaxIterations ||
    payload.completionPromise !== currentCompletionPromise ||
    payload.lastPrompt !== currentLastPrompt
  );
}

/**
 * Flushes one project auto-save request immediately.
 */
async function flushProjectAutoSave(reason = 'manual-flush', options = {}) {
  const { force = false } = options;
  const currentProject = projectManager?.getCurrentProject();
  if (!currentProject || !projectManager) {
    return;
  }
  if (isCurrentProjectRunning() && !force) {
    return;
  }

  const payload = buildProjectFormUpdatePayload(currentProject);
  if (!hasProjectFormChanges(currentProject, payload)) {
    return;
  }

  if (projectAutoSaveInFlight) {
    projectAutoSavePending = true;
    return;
  }

  projectAutoSaveInFlight = true;
  try {
    await projectManager.updateProject(currentProject.id, payload, {
      reloadProjects: false,
      silent: true,
      closeModal: false
    });
    appendDebugLog('project auto-saved', { projectId: currentProject.id, reason });
  } catch (err) {
    appendDebugLog('project auto-save failed', err);
  } finally {
    projectAutoSaveInFlight = false;
    if (projectAutoSavePending) {
      projectAutoSavePending = false;
      queueProjectAutoSave('pending-retry', { force });
    }
  }
}

/**
 * Debounces project auto-save when right-side form changes.
 */
function queueProjectAutoSave(reason = 'input', options = {}) {
  const { force = false } = options;
  const currentProject = projectManager?.getCurrentProject();
  if (!currentProject || !projectManager) {
    return;
  }
  if (isCurrentProjectRunning() && !force) {
    return;
  }

  cancelProjectAutoSave();
  projectAutoSaveTimer = window.setTimeout(() => {
    projectAutoSaveTimer = null;
    void flushProjectAutoSave(reason, { force });
  }, PROJECT_AUTO_SAVE_DELAY_MS);
}

/**
 * Sends input to the running loop process.
 */
async function sendLoopInput(input, projectId = null, sessionId = null) {
  if (!projectId) {
    return;
  }
  const resolvedSessionId = sessionId || getRunningSessionByProject(projectId)?.session_id || null;
  try {
    await invokeWithDebug('send_loop_input', {
      input: input,
      append_newline: false, // Let terminal handle newlines
      project_id: projectId,
      session_id: resolvedSessionId,
    });
  } catch (err) {
    appendDebugLog('send input failed', err);
  }
}

/**
 * Handles project run requests
 */
async function handleProjectRun(project) {
  console.log('[handleProjectRun] project run requested:', project.name);

  // Update form with project data
  handleProjectChange(project);
  const projectId = project?.id || null;
  if (!projectId) {
    return;
  }

  if (isProjectRunning(projectId)) {
    await handleStop({ projectId });
    return;
  }

  if (!Boolean(project.enabled)) {
    try {
      const updatedProject = await invokeWithDebug('set_project_enabled', {
        project_id: projectId,
        enabled: true
      });
      currentProjectEnabled = Boolean(updatedProject.enabled);
      projectManager?.updateProjectEnabledState(projectId, updatedProject.enabled);
    } catch (err) {
      appendDebugLog('run-project enable failed', err);
      alert(`启用项目失败: ${serializeDebugValue(err)}`);
      return;
    }
  }

  await handleStart({ projectId });
}

/**
 * Handles project changes
 */
function handleProjectChange(project) {
  console.log('[handleProjectChange] project changed:', project?.name || 'none');
  cancelProjectAutoSave();
  appendDebugLog('project-selected', project ? {
    id: project.id,
    name: project.name,
    work_directory: project.work_directory,
    claude_setting_id: project.claude_setting_id || null,
    enabled: Boolean(project.enabled),
  } : null);

  // Update form fields with project data
  if (project) {
    currentProjectEnabled = Boolean(project.enabled);
    workDirInput.value = project.work_directory || '';
    promptInput.value = project.last_prompt || '';
    maxIterationsInput.value = project.max_iterations?.toString() || '';
    completionPromiseInput.value = project.completion_promise || '';
  } else {
    currentProjectEnabled = false;
    // Clear form when no project selected
    workDirInput.value = '';
    promptInput.value = '';
    maxIterationsInput.value = '';
    completionPromiseInput.value = '';
  }

  renderSelectedProjectTerminalHistory(project);
  syncUI();
  void refreshBackendDebugState().then(() => pollCurrentProjectOutput());
}

/**
 * Handles projects list update
 */
function handleProjectsUpdate(projects) {
  console.log('[handleProjectsUpdate] projects updated:', projects.length);
  // Could add additional logic here if needed
}

/**
 * Handles project toggle (enable/disable from project card switch)
 */
async function handleProjectToggle(projectId, newEnabled) {
  console.log('[handleProjectToggle] toggling project enabled:', projectId, newEnabled);
  try {
    const updatedProject = await invokeWithDebug('set_project_enabled', {
      project_id: projectId,
      enabled: newEnabled
    });
    if (projectManager) {
      projectManager.updateProjectEnabledState(projectId, updatedProject.enabled);
      const currentProject = projectManager.getCurrentProject();
      if (currentProject && currentProject.id === projectId) {
        currentProjectEnabled = Boolean(updatedProject.enabled);
      }
    }
    syncUI();
    await refreshBackendDebugState();
  } catch (err) {
    appendDebugLog('project toggle failed', err);
    // Revert the toggle UI on failure
    if (projectManager) {
      projectManager.updateProjectEnabledState(projectId, !newEnabled);
    }
    alert(`切换项目状态失败: ${serializeDebugValue(err)}`);
  }
}

/**
 * Initializes runtime binding and initial project state.
 */
async function init() {
  refreshPageIcons();
  appendDebugLog('init started');

  try {
    await initTerminal();
    invoke = getInvoke();
    appendDebugLog('tauri runtime detected');

    // Initialize project manager
    projectManager = new ProjectManager(invoke);
    projectManager.onProjectChange = handleProjectChange;
    projectManager.onProjectsUpdate = handleProjectsUpdate;
    projectManager.onProjectRun = handleProjectRun;
    projectManager.onProjectToggle = handleProjectToggle;
    await projectManager.initialize();
    appendDebugLog('project manager initialized');
    initializeRuntimeTimeoutControls();

    currentProjectEnabled = Boolean(projectManager.getCurrentProject()?.enabled);
    syncUI();

    // Initial icon render
    refreshPageIcons();

    startPolling();
    await refreshBackendDebugState();
    await pollLoopOutput();
  } catch (err) {
    appendDebugLog('init failed', err);
    alert(`Initialization failed: ${serializeDebugValue(err)}`);
  }
}

/**
 * Handles enable/disable button clicks.
 */
async function handleToggle() {
  const currentProject = projectManager?.getCurrentProject();
  appendDebugLog('toggle button clicked', {
    current_project_id: currentProject?.id || null,
    current_project_enabled: currentProjectEnabled,
    current_project_running: isCurrentProjectRunning(),
    running_count: runningProjectIds.size
  });

  if (!currentProject) {
    alert('请先选择一个项目');
    return false;
  }

  try {
    const newEnabled = !currentProjectEnabled;
    const updatedProject = await invokeWithDebug('set_project_enabled', {
      project_id: currentProject.id,
      enabled: newEnabled
    });
    currentProjectEnabled = Boolean(updatedProject.enabled);
    if (projectManager) {
      projectManager.updateProjectEnabledState(updatedProject.id, updatedProject.enabled);
    }
    syncUI();
    await refreshBackendDebugState();
    return true;
  } catch (err) {
    appendDebugLog('toggle failed', err);
    alert(`Toggle failed: ${serializeDebugValue(err)}`);
    return false;
  }
}

/**
 * Handles start button clicks.
 */
async function handleStart(options = {}) {
  const {
    projectId = null,
    preserveTerminalHistory = false,
    triggerSource = 'manual'
  } = options;
  const currentProject = projectManager?.getCurrentProject();
  const targetProjectId = projectId || currentProject?.id || null;

  appendDebugLog('start button clicked', {
    project_id: targetProjectId,
    trigger_source: triggerSource,
    currentProjectEnabled,
    running_count: runningProjectIds.size
  });

  if (!currentProject || !targetProjectId || currentProject.id !== targetProjectId) {
    alert('请先选择一个项目');
    return;
  }
  if (!currentProjectEnabled) {
    alert('当前项目未启用，请先启用当前项目');
    return;
  }
  if (isProjectRunning(targetProjectId)) {
    appendDebugLog('start skipped because project already running', { project_id: targetProjectId });
    return;
  }

  // Ensure latest right-side edits are persisted before run.
  await flushProjectAutoSave('before-start', { force: true });

  if (!preserveTerminalHistory) {
    terminalHistoryByProject.set(targetProjectId, '');
    renderSelectedProjectTerminalHistory(currentProject);
  }
  appendProjectTerminalOutput(targetProjectId, '\r\n[system] starting loop process...\r\n');
  syncUI();
  workDirInput.disabled = true;
  promptInput.disabled = true;
  maxIterationsInput.disabled = true;
  completionPromiseInput.disabled = true;

  const workDir = workDirInput.value || currentProject.work_directory;
  const prompt = promptInput.value || null;
  const parsedIterations = maxIterationsInput.value ? parseInt(maxIterationsInput.value, 10) : null;
  const maxIterations = Number.isInteger(parsedIterations) && parsedIterations > 0
    ? parsedIterations
    : currentProject.max_iterations;
  const completionPromise = completionPromiseInput.value || currentProject.completion_promise;
  const normalizedCompletionPromise = typeof completionPromise === 'string'
    ? completionPromise.trim()
    : '';
  if (normalizedCompletionPromise) {
    activeCompletionPromiseByProject.set(targetProjectId, normalizedCompletionPromise);
  } else {
    activeCompletionPromiseByProject.delete(targetProjectId);
  }
  runStartAtByProject.set(targetProjectId, Date.now());
  lastOutputAtByProject.set(targetProjectId, Date.now());
  recentOutputByProject.set(targetProjectId, '');
  autoCompletionStopInFlightProjectIds.delete(targetProjectId);
  waitingStateSeenAtByProject.delete(targetProjectId);

  appendDebugLog('start-context', {
    project_id: currentProject.id,
    project_name: currentProject.name,
    project_work_directory: currentProject.work_directory,
    form_work_directory: workDirInput.value || '',
    effective_work_directory: workDir,
    project_claude_setting_id: currentProject.claude_setting_id || null,
  });

  try {
    await invokeWithDebug('inspect_claude_runtime_context', { work_dir: workDir });
  } catch (err) {
    appendDebugLog('inspect_claude_runtime_context failed', err);
  }

  try {
    await invokeWithDebug('start_loop', {
      project_id: targetProjectId,
      work_dir: workDir,
      prompt,
      max_iterations: maxIterations,
      completion_promise: completionPromise
    });
    await refreshBackendDebugState();
    await pollLoopOutput();

    // Focus terminal for direct input
    if (terminalComponent) {
      terminalComponent.focus();
    }
  } catch (err) {
    appendDebugLog('start failed', err);
    alert(`Start failed: ${serializeDebugValue(err)}`);
    syncUI();
    workDirInput.disabled = false;
    promptInput.disabled = false;
    maxIterationsInput.disabled = false;
    completionPromiseInput.disabled = false;
  }
}

/**
 * Handles stop button clicks.
 */
async function handleStop(options = {}) {
  const { projectId = null, sessionId = null, reason = 'manual' } = options;
  const currentProject = projectManager?.getCurrentProject();
  const targetSession = sessionId
    ? getRunningSessionById(sessionId)
    : getRunningSessionByProject(projectId || currentProject?.id || null);
  const targetProjectId = targetSession?.project_id || projectId || currentProject?.id || null;
  if (!targetProjectId && !targetSession) {
    return;
  }

  appendDebugLog('stop button clicked', {
    project_id: targetProjectId,
    reason,
    currentProjectEnabled,
    running_count: runningProjectIds.size
  });

  if (targetProjectId && !isProjectRunning(targetProjectId) && !targetSession) {
    appendDebugLog('stop skipped because project not running', { project_id: targetProjectId });
    return;
  }

  syncUI();
  workDirInput.disabled = false;
  promptInput.disabled = false;
  maxIterationsInput.disabled = false;
  completionPromiseInput.disabled = false;
  if (reason === 'manual' && targetProjectId) {
    manualStopProjectIds.add(targetProjectId);
  }

  try {
    await invokeWithDebug('stop_loop', {
      project_id: targetProjectId,
      session_id: targetSession?.session_id || sessionId || null
    });
    await refreshBackendDebugState();
    if (currentProject && currentProject.id === targetProjectId) {
      await pollCurrentProjectOutput();
    } else if (targetProjectId) {
      const chunks = await invoke('poll_loop_output', { project_id: targetProjectId });
      if (Array.isArray(chunks) && chunks.length > 0) {
        chunks.forEach((chunk) => appendProjectTerminalOutput(targetProjectId, String(chunk)));
      }
    }
  } catch (err) {
    appendDebugLog('stop failed', err);
    alert(`Stop failed: ${serializeDebugValue(err)}`);
  } finally {
    if (targetProjectId) {
      autoCompletionStopInFlightProjectIds.delete(targetProjectId);
      waitingStateSeenAtByProject.delete(targetProjectId);
    }
  }
}

/**
 * Schedules one automatic next loop run when a project exits naturally.
 */
async function triggerAutoNextLoop(projectId) {
  if (!projectId) {
    return;
  }
  if (!AUTO_NEXT_LOOP_ENABLED) {
    return;
  }
  if (autoRestartInFlight) {
    appendDebugLog('auto-next skipped because another auto-next is running', { project_id: projectId });
    return;
  }
  if (manualStopProjectIds.has(projectId)) {
    manualStopProjectIds.delete(projectId);
    appendDebugLog('auto-next skipped because stop was manual', { project_id: projectId });
    return;
  }

  const currentProject = getCurrentProject();
  if (!currentProject || currentProject.id !== projectId) {
    appendDebugLog('auto-next skipped because project is not selected in main panel', { project_id: projectId });
    return;
  }
  if (!currentProjectEnabled) {
    appendDebugLog('auto-next skipped because current project is disabled', { project_id: projectId });
    return;
  }

  autoRestartInFlight = true;
  try {
    appendProjectTerminalOutput(
      projectId,
      `\r\n[system] loop exited, auto-starting next run in ${Math.round(AUTO_NEXT_LOOP_DELAY_MS / 1000)}s...\r\n`
    );
    await new Promise((resolve) => window.setTimeout(resolve, AUTO_NEXT_LOOP_DELAY_MS));
    await refreshBackendDebugState();
    if (isProjectRunning(projectId)) {
      appendDebugLog('auto-next canceled because project became running again', { project_id: projectId });
      return;
    }
    if (!currentProjectEnabled) {
      appendDebugLog('auto-next canceled because project became disabled', { project_id: projectId });
      return;
    }
    await handleStart({
      projectId,
      preserveTerminalHistory: true,
      triggerSource: 'auto-next'
    });
  } catch (err) {
    appendDebugLog('auto-next failed', err);
  } finally {
    autoRestartInFlight = false;
  }
}

/**
 * Detects completion markers in process output and force-stops current run.
 * This handles the case where Claude keeps the session alive in "waiting for input".
 */
async function inspectOutputForAutoCompletion(projectId, chunk) {
  if (!projectId || !chunk) {
    return;
  }
  if (autoCompletionStopInFlightProjectIds.has(projectId)) {
    return;
  }

  const previous = recentOutputByProject.get(projectId) || '';
  const merged = (previous + chunk).slice(-8000);
  recentOutputByProject.set(projectId, merged);
  const normalizedMerged = stripAnsi(merged);

  const completionPromise = activeCompletionPromiseByProject.get(projectId) || '';
  const customMatched = Boolean(completionPromise) && normalizedMerged.includes(completionPromise);
  const waitingMatched = AUTO_COMPLETION_WAITING_MARKERS.some((marker) => normalizedMerged.includes(marker));
  if (!waitingMatched) {
    waitingStateSeenAtByProject.delete(projectId);
    return;
  }
  if (!waitingStateSeenAtByProject.has(projectId)) {
    waitingStateSeenAtByProject.set(projectId, Date.now());
  }

  const startedAt = runStartAtByProject.get(projectId) || 0;
  if (startedAt > 0 && (Date.now() - startedAt) < AUTO_COMPLETION_MIN_RUNTIME_MS) {
    return;
  }
  if (!isProjectRunning(projectId)) {
    return;
  }

  const waitingSeenAt = waitingStateSeenAtByProject.get(projectId) || 0;
  const waitingLongEnough = waitingSeenAt > 0 && (Date.now() - waitingSeenAt) >= AUTO_COMPLETION_WAITING_GRACE_MS;
  const shouldStop = customMatched || waitingLongEnough;
  if (!shouldStop) {
    return;
  }

  autoCompletionStopInFlightProjectIds.add(projectId);
  appendDebugLog('auto-completion marker detected', {
    project_id: projectId,
    marker: customMatched ? completionPromise : 'waiting-state-grace'
  });
  appendProjectTerminalOutput(projectId, '\r\n[system] completion marker detected, stopping current run...\r\n');
  await handleStop({ projectId, reason: 'auto-completion' });
}

/**
 * Hard-timeout fallback: one run exceeded max runtime, force stop immediately.
 */
async function inspectHardTimeoutForCurrentProject() {
  if (autoHardStopMs <= 0) {
    return;
  }
  const currentProject = getCurrentProject();
  if (!currentProject) {
    return;
  }
  const projectId = currentProject.id;
  if (!isProjectRunning(projectId)) {
    return;
  }
  if (autoCompletionStopInFlightProjectIds.has(projectId)) {
    return;
  }

  const startedAt = runStartAtByProject.get(projectId) || 0;
  if (startedAt === 0) {
    return;
  }
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs < autoHardStopMs) {
    return;
  }

  autoCompletionStopInFlightProjectIds.add(projectId);
  appendDebugLog('hard-timeout auto-stop', {
    project_id: projectId,
    elapsed_ms: elapsedMs,
    threshold_ms: autoHardStopMs
  });
  appendProjectTerminalOutput(projectId, '\r\n[system] hard timeout reached, stopping current run...\r\n');
  await handleStop({ projectId, reason: 'auto-hard-timeout' });
}

/**
 * Idle fallback: if one run stays alive but has no output for too long,
 * force-stop it so auto-next can continue.
 */
async function inspectIdleForCurrentProject() {
  if (autoIdleNextLoopMs <= 0) {
    return;
  }
  const currentProject = getCurrentProject();
  if (!currentProject) {
    return;
  }
  const projectId = currentProject.id;
  if (!isProjectRunning(projectId)) {
    return;
  }
  if (autoCompletionStopInFlightProjectIds.has(projectId)) {
    return;
  }

  const startedAt = runStartAtByProject.get(projectId) || 0;
  if (startedAt === 0) {
    return;
  }
  const now = Date.now();
  if ((now - startedAt) < AUTO_COMPLETION_MIN_RUNTIME_MS) {
    return;
  }

  const lastOutputAt = lastOutputAtByProject.get(projectId) || startedAt;
  const idleMs = now - lastOutputAt;
  if (idleMs < autoIdleNextLoopMs) {
    return;
  }

  autoCompletionStopInFlightProjectIds.add(projectId);
  appendDebugLog('idle-timeout auto-stop', {
    project_id: projectId,
    idle_ms: idleMs,
    threshold_ms: autoIdleNextLoopMs
  });
  appendProjectTerminalOutput(projectId, '\r\n[system] idle timeout reached, stopping current run...\r\n');
  await handleStop({ projectId, reason: 'auto-idle-timeout' });
}

/**
 * Sends user input from the input field to the running loop session.
 */
async function handleSendInput() {
  const text = terminalInput.value;
  if (!text.trim()) {
    return;
  }
  const currentProject = getCurrentProject();
  if (!currentProject || !isProjectRunning(currentProject.id)) {
    return;
  }

  try {
    const runningSession = getRunningSessionByProject(currentProject.id);
    await sendLoopInput(text + '\n', currentProject.id, runningSession?.session_id || null); // Add newline for form input
    appendProjectTerminalOutput(currentProject.id, `\r\n[user] ${text}\r\n`);
    terminalInput.value = '';
  } catch (err) {
    appendDebugLog('send input failed', err);
    alert(`Send input failed: ${serializeDebugValue(err)}`);
  }
}

/**
 * Handles global JavaScript errors.
 */
function handleWindowError(event) {
  appendDebugLog('window error', {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  });
}

/**
 * Handles unhandled promise rejections.
 */
function handleUnhandledRejection(event) {
  appendDebugLog('unhandled rejection', event.reason);
}

// Event listeners
toggleBtn.addEventListener('click', handleToggle);
startBtn.addEventListener('click', handleStart);
stopBtn.addEventListener('click', handleStop);
sendBtn.addEventListener('click', handleSendInput);
tabTerminal.addEventListener('click', () => switchLogTab('terminal'));
tabDebug.addEventListener('click', () => switchLogTab('debug'));
terminalInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    handleSendInput();
  }
});
[workDirInput, promptInput, maxIterationsInput, completionPromiseInput].forEach((inputElement) => {
  if (!inputElement) {
    return;
  }
  inputElement.addEventListener('input', () => queueProjectAutoSave('form-input'));
  inputElement.addEventListener('change', () => queueProjectAutoSave('form-change'));
});
if (idleNextTimeoutInput) {
  idleNextTimeoutInput.addEventListener('change', () => applyIdleNextTimeoutInput());
  idleNextTimeoutInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyIdleNextTimeoutInput();
    }
  });
}
if (hardStopTimeoutInput) {
  hardStopTimeoutInput.addEventListener('change', () => applyHardStopTimeoutInput());
  hardStopTimeoutInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyHardStopTimeoutInput();
    }
  });
}
window.addEventListener('error', handleWindowError);
window.addEventListener('unhandledrejection', handleUnhandledRejection);

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  cancelProjectAutoSave();
  stopPolling();
  if (terminalComponent) {
    terminalComponent.destroy();
  }
});

// Initialize application
init();
