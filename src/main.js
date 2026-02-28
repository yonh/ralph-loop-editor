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
let enabled = false;
let running = false;
let outputPollTimer = null;
let statePollTimer = null;
let lastBackendStateSignature = '';

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
const terminalOutput = document.getElementById('terminal-output');
const terminalInput = document.getElementById('terminal-input');
const sendBtn = document.getElementById('send-btn');
const debugLog = document.getElementById('debug-log');
const tabTerminal = document.getElementById('tab-terminal');
const tabDebug = document.getElementById('tab-debug');
const panelTerminal = document.getElementById('panel-terminal');
const panelDebug = document.getElementById('panel-debug');

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
 * Initializes the terminal component.
 */
async function initTerminal() {
  try {
    terminalComponent = new TerminalComponent(terminalOutput);

    // Set resize callback to notify backend of terminal size changes
    terminalComponent.setResizeCallback(async (cols, rows) => {
      try {
        // Notify backend of new terminal size for PTY adjustment
        await invoke('resize_pty', { cols, rows });
      } catch (err) {
        // Ignore resize errors - backend might not support this command
        console.debug('PTY resize notification failed:', err);
      }
    });

    await terminalComponent.init();

    // Setup input handling
    terminalComponent.setupInput((data) => {
      // Forward terminal input to backend when running
      if (running) {
        sendLoopInput(data);
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
    const previousRunning = running;
    enabled = Boolean(state.enabled);
    running = Boolean(state.loop_running);

    const stateSignature = JSON.stringify(state);
    if (stateSignature !== lastBackendStateSignature) {
      appendDebugLog('backend-state', state);
      lastBackendStateSignature = stateSignature;
    }

    if (previousRunning && !running) {
      workDirInput.disabled = false;
      promptInput.disabled = false;
      maxIterationsInput.disabled = false;
      completionPromiseInput.disabled = false;
    }

    syncUI();
  } catch (err) {
    appendDebugLog('backend-state failed', err);
  }
}

/**
 * Polls and flushes new loop output chunks into the terminal panel.
 */
async function pollLoopOutput() {
  try {
    const chunks = await invoke('poll_loop_output');
    if (Array.isArray(chunks) && chunks.length > 0) {
      chunks.forEach((chunk) => appendTerminalOutput(String(chunk)));
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
}

/**
 * Synchronizes the visual state with the in-memory state flags.
 */
function syncUI() {
  toggleBtn.innerHTML = `<i data-lucide="${enabled ? 'toggle-right' : 'toggle-left'}"></i> ${enabled ? 'Disable' : 'Enable'}`;
  startBtn.disabled = !enabled || running;
  stopBtn.disabled = !enabled || !running;
  sendBtn.disabled = !running;
  terminalInput.disabled = !running;
  statusDiv.className = 'status';

  if (running) {
    statusDiv.classList.add('running');
    statusDiv.textContent = 'Status: Running';
  } else if (enabled) {
    statusDiv.classList.add('enabled');
    statusDiv.textContent = 'Status: Enabled';
  } else {
    statusDiv.classList.add('disabled');
    statusDiv.textContent = 'Status: Disabled';
  }

  // Refresh icons for modified buttons
  refreshPageIcons();

  // Update project running states
  if (projectManager) {
    const currentProject = projectManager.getCurrentProject();
    const runningProjectId = running && currentProject ? currentProject.id : null;
    projectManager.updateAllProjectsRunningState(runningProjectId);
    // Sync all project card toggle switches to the current global enabled state
    projectManager.syncToggleStates(enabled);
  }
}

/**
 * Sends input to the running loop process.
 */
async function sendLoopInput(input) {
  try {
    await invokeWithDebug('send_loop_input', {
      input: input,
      appendNewline: false, // Let terminal handle newlines
    });
  } catch (err) {
    appendDebugLog('send input failed', err);
  }
}

/**
 * Handles project run requests
 */
function handleProjectRun(project) {
  console.log('[handleProjectRun] project run requested:', project.name);

  // Update form with project data
  handleProjectChange(project);

  // Start the loop if enabled
  if (enabled) {
    handleStart();
  } else {
    // Enable first, then start
    handleToggle().then(() => {
      setTimeout(handleStart, 500);
    }).catch(err => {
      console.error('[handleProjectRun] failed to enable:', err);
    });
  }
}

/**
 * Handles project changes
 */
function handleProjectChange(project) {
  console.log('[handleProjectChange] project changed:', project?.name || 'none');

  // Update form fields with project data
  if (project) {
    workDirInput.value = project.work_directory || '';
    promptInput.value = project.last_prompt || '';
    maxIterationsInput.value = project.max_iterations?.toString() || '';
    completionPromiseInput.value = project.completion_promise || '';
  } else {
    // Clear form when no project selected
    workDirInput.value = '';
    promptInput.value = '';
    maxIterationsInput.value = '';
    completionPromiseInput.value = '';
  }

  // Save current prompt to project when running
  if (running && project) {
    const currentPrompt = promptInput.value;
    if (currentPrompt && currentPrompt !== project.last_prompt) {
      // Update project with new prompt
      projectManager.updateProject(project.id, {
        name: project.name,
        description: project.description,
        workDirectory: project.work_directory,
        maxIterations: project.max_iterations,
        completionPromise: project.completion_promise
      }).then(() => {
        console.log('[handleProjectChange] project prompt updated');
      }).catch(err => {
        console.error('[handleProjectChange] failed to update project prompt:', err);
      });
    }
  }
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
async function handleProjectToggle(newEnabled) {
  console.log('[handleProjectToggle] toggling enabled:', newEnabled);
  try {
    enabled = await invokeWithDebug('set_enabled', { enabled: newEnabled });
    syncUI();
    await refreshBackendDebugState();
  } catch (err) {
    appendDebugLog('project toggle failed', err);
    // Revert the toggle UI on failure
    if (projectManager) {
      projectManager.syncToggleStates(!newEnabled);
    }
    alert(`切换项目状态失败: ${serializeDebugValue(err)}`);
  }
}

/**
 * Initializes runtime binding and initial enabled state.
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

    enabled = await invokeWithDebug('get_enabled');
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
  appendDebugLog('toggle button clicked', { enabled, running });
  try {
    const newEnabled = !enabled;
    enabled = await invokeWithDebug('set_enabled', { enabled: newEnabled });
    syncUI();
    await refreshBackendDebugState();
  } catch (err) {
    appendDebugLog('toggle failed', err);
    alert(`Toggle failed: ${serializeDebugValue(err)}`);
  }
}

/**
 * Handles start button clicks.
 */
async function handleStart() {
  appendDebugLog('start button clicked', { enabled, running });

  // Check if there's a current project
  const currentProject = projectManager?.getCurrentProject();
  if (!currentProject) {
    alert('请先选择一个项目');
    return;
  }

  if (terminalComponent && terminalComponent.isInitialized()) {
    terminalComponent.clear();
  } else {
    terminalOutput.textContent = '';
  }

  appendTerminalOutput('\r\n[system] starting loop process...\r\n');
  running = true;
  syncUI();
  workDirInput.disabled = true;
  promptInput.disabled = true;
  maxIterationsInput.disabled = true;
  completionPromiseInput.disabled = true;

  const workDir = workDirInput.value || currentProject.work_directory;
  const prompt = promptInput.value || null;
  const maxIterations = maxIterationsInput.value ? parseInt(maxIterationsInput.value, 10) : currentProject.max_iterations;
  const completionPromise = completionPromiseInput.value || currentProject.completion_promise;

  // Update project with current prompt if it has changed
  if (prompt && prompt !== currentProject.last_prompt) {
    try {
      await projectManager.updateProject(currentProject.id, {
        name: currentProject.name,
        description: currentProject.description,
        workDirectory: currentProject.work_directory,
        maxIterations: currentProject.max_iterations,
        completionPromise: currentProject.completion_promise
      });
      // Update the prompt in the project
      currentProject.last_prompt = prompt;
    } catch (err) {
      console.error('[handleStart] failed to update project prompt:', err);
    }
  }

  try {
    await invokeWithDebug('start_loop', {
      workDir,
      prompt,
      maxIterations,
      completionPromise
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
    running = false;
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
async function handleStop() {
  appendDebugLog('stop button clicked', { enabled, running });
  running = false;
  syncUI();
  workDirInput.disabled = false;
  promptInput.disabled = false;
  maxIterationsInput.disabled = false;
  completionPromiseInput.disabled = false;

  try {
    await invokeWithDebug('stop_loop');
    await refreshBackendDebugState();
    await pollLoopOutput();
  } catch (err) {
    appendDebugLog('stop failed', err);
    alert(`Stop failed: ${serializeDebugValue(err)}`);
  }
}

/**
 * Sends user input from the input field to the running loop session.
 */
async function handleSendInput() {
  const text = terminalInput.value;
  if (!text.trim()) {
    return;
  }

  try {
    await sendLoopInput(text + '\n'); // Add newline for form input
    appendTerminalOutput(`\r\n[user] ${text}\r\n`);
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
window.addEventListener('error', handleWindowError);
window.addEventListener('unhandledrejection', handleUnhandledRejection);

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  stopPolling();
  if (terminalComponent) {
    terminalComponent.destroy();
  }
});

// Initialize application
init();
