/**
 * Main application entry point for Ralph Loop Editor
 * Integrates xterm.js terminal component with Tauri backend
 */

import {
  createIcons,
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
  Trash2,
  Settings,
  WandSparkles
} from 'lucide';
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
  Trash2,
  Settings,
  WandSparkles
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
const APP_UI_SETTINGS_STORAGE_KEY = 'ralph_loop_ui_settings_v1';
const TASK_PLAN_START_MARKER = '### 详细任务列表（自动生成）';
const TASK_PLAN_END_MARKER = '### 任务列表结束';
const DEFAULT_PROMPT_OPTIMIZE_PRESET = `请将以下任务目标改写为可执行的工程提示词，并确保包含详细任务列表与验收要求。
任务目标：
{{input_prompt}}

输出要求：
1. 先给出分阶段的详细任务列表（每步可验证）
2. 失败时必须定位原因并修复后重试
3. 输出变更摘要、测试结果、风险与下一步建议`;
const DEFAULT_APP_UI_SETTINGS = Object.freeze({
  defaultPrompt: '',
  defaultMaxIterations: 20,
  defaultClaudeSettingId: '',
  optimizePreset: DEFAULT_PROMPT_OPTIMIZE_PRESET,
  optimizeProvider: 'anthropic',
  optimizeBaseUrl: '',
  optimizeModel: 'claude-sonnet-4-5',
  optimizeApiKey: ''
});
const TERMINAL_FOCUS_CONTROL_SEQUENCES = new Set(['\u001b[I', '\u001b[O']);
const terminalHistoryByProject = new Map();
let autoIdleNextLoopMs = DEFAULT_AUTO_IDLE_NEXT_LOOP_MS;
let autoHardStopMs = DEFAULT_AUTO_HARD_STOP_MS;
let runtimeCountdownTimer = null;
let appUISettings = { ...DEFAULT_APP_UI_SETTINGS };
let taskPlanModalResolver = null;
let toastHideTimer = null;

function replaceTemplateToken(template, token, value) {
  return String(template || '').split(token).join(value);
}

function normalizeAppUISettings(rawSettings = {}) {
  const parsedDefaultIterations = parseInt(String(rawSettings.defaultMaxIterations || ''), 10);
  const normalizedIterations = Number.isInteger(parsedDefaultIterations) && parsedDefaultIterations > 0
    ? Math.min(parsedDefaultIterations, 100)
    : DEFAULT_APP_UI_SETTINGS.defaultMaxIterations;

  return {
    defaultPrompt: typeof rawSettings.defaultPrompt === 'string' ? rawSettings.defaultPrompt : '',
    defaultMaxIterations: normalizedIterations,
    defaultClaudeSettingId: typeof rawSettings.defaultClaudeSettingId === 'string'
      ? rawSettings.defaultClaudeSettingId.trim()
      : '',
    optimizePreset: typeof rawSettings.optimizePreset === 'string' && rawSettings.optimizePreset.trim()
      ? rawSettings.optimizePreset
      : DEFAULT_APP_UI_SETTINGS.optimizePreset,
    optimizeProvider: String(rawSettings.optimizeProvider || DEFAULT_APP_UI_SETTINGS.optimizeProvider)
      .trim()
      .toLowerCase() === 'openai'
      ? 'openai'
      : 'anthropic',
    optimizeBaseUrl: typeof rawSettings.optimizeBaseUrl === 'string'
      ? rawSettings.optimizeBaseUrl.trim()
      : '',
    optimizeModel: typeof rawSettings.optimizeModel === 'string' && rawSettings.optimizeModel.trim()
      ? rawSettings.optimizeModel.trim()
      : DEFAULT_APP_UI_SETTINGS.optimizeModel,
    optimizeApiKey: typeof rawSettings.optimizeApiKey === 'string'
      ? rawSettings.optimizeApiKey.trim()
      : ''
  };
}

function loadAppUISettingsFromStorage() {
  try {
    const raw = window.localStorage.getItem(APP_UI_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_APP_UI_SETTINGS };
    }
    const parsed = JSON.parse(raw);
    return normalizeAppUISettings(parsed);
  } catch (error) {
    console.warn('Failed to parse app ui settings, fallback to default:', error);
    return { ...DEFAULT_APP_UI_SETTINGS };
  }
}

function saveAppUISettingsToStorage(settings) {
  window.localStorage.setItem(APP_UI_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

function initializeAppUISettings() {
  appUISettings = loadAppUISettingsFromStorage();
}

function generateDetailedTaskList(promptText) {
  const normalizedPrompt = String(promptText || '').replace(/\r/g, '').trim();
  const promptSegments = normalizedPrompt
    .split(/\n|[。！？.!?]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 4);

  const primaryGoal = promptSegments[0] || '明确目标并定义可验证交付物';
  const tasks = [
    `澄清目标与验收标准：${primaryGoal}`,
    '扫描仓库上下文：阅读 README、任务说明与关键源码入口',
    '拆分可执行子任务并标记先后顺序（每步都可验证）'
  ];

  if (/修复|报错|错误|bug|异常|失败/i.test(normalizedPrompt)) {
    tasks.push('复现问题并定位根因，记录触发条件与影响范围');
  } else {
    tasks.push('先完成最小可运行版本，再逐步扩展功能');
  }

  if (/接口|api|服务|后端|数据库/i.test(normalizedPrompt)) {
    tasks.push('实现或修正接口与数据层，并补齐必要的输入校验');
  }

  if (/页面|前端|ui|交互/i.test(normalizedPrompt)) {
    tasks.push('实现界面与交互逻辑，覆盖关键状态与边界场景');
  }

  tasks.push('运行构建与测试，针对失败项定位并修复，直到通过');
  tasks.push('整理变更摘要、测试结果、风险点与后续建议');

  const uniqueTasks = [];
  tasks.forEach((task) => {
    if (!uniqueTasks.includes(task)) {
      uniqueTasks.push(task);
    }
  });

  return uniqueTasks.slice(0, 10);
}

function buildTaskListText(tasks = []) {
  return tasks.map((task, index) => `${index + 1}. ${task}`).join('\n');
}

function escapeRegExp(pattern) {
  return pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function upsertTaskListIntoPrompt(promptText, tasks = []) {
  const normalizedPrompt = String(promptText || '').trim();
  const taskListText = buildTaskListText(tasks);
  const taskBlock = `${TASK_PLAN_START_MARKER}\n${taskListText}\n${TASK_PLAN_END_MARKER}`;
  const matcher = new RegExp(
    `${escapeRegExp(TASK_PLAN_START_MARKER)}[\\s\\S]*?${escapeRegExp(TASK_PLAN_END_MARKER)}`,
    'm'
  );

  if (!normalizedPrompt) {
    return taskBlock;
  }
  if (matcher.test(normalizedPrompt)) {
    return normalizedPrompt.replace(matcher, taskBlock);
  }
  return `${normalizedPrompt}\n\n${taskBlock}`;
}

function buildPromptOptimizationRequest(rawPrompt) {
  const inputPrompt = String(rawPrompt || '').trim() || appUISettings.defaultPrompt.trim();
  const normalizedInputPrompt = inputPrompt || '读取任务目标并完成实现，逐步验证后输出总结。';
  const tasks = generateDetailedTaskList(normalizedInputPrompt);
  const generatedTaskListText = buildTaskListText(tasks);
  const preset = String(appUISettings.optimizePreset || '').trim() || DEFAULT_PROMPT_OPTIMIZE_PRESET;
  const resolvedPreset = replaceTemplateToken(
    replaceTemplateToken(preset, '{{input_prompt}}', normalizedInputPrompt),
    '{{generated_task_list}}',
    generatedTaskListText
  );

  const requestPrompt = `你是资深 AI 编程任务提示词优化器。请把输入任务改写为“可直接用于 Ralph Loop”的高质量提示词。

原始任务目标：
${normalizedInputPrompt}

优化预设（可遵循）：
${resolvedPreset}

建议任务列表：
${generatedTaskListText}

输出硬性要求：
1. 只输出“最终优化后的提示词正文”，不要解释或前后缀。
2. 必须包含“详细任务列表”分节，步骤需要可验证。
3. 包含失败重试策略、验收标准、以及最终总结输出要求。`;

  return {
    requestPrompt,
    sourcePrompt: normalizedInputPrompt,
    tasks
  };
}

function unwrapAiOptimizedPrompt(rawOutput) {
  const text = String(rawOutput || '').trim();
  if (!text) {
    return '';
  }

  const blockMatch = text.match(/```(?:\w+)?\n([\s\S]*?)```/);
  let normalized = blockMatch ? blockMatch[1].trim() : text;
  normalized = normalized.replace(/^优化后提示词[:：]?\s*/i, '').trim();
  return normalized;
}

async function runOptimizePromptInvoke(promptText, timeoutMs = 30_000) {
  const provider = String(appUISettings.optimizeProvider || 'anthropic').toLowerCase();
  const model = String(appUISettings.optimizeModel || '').trim();
  const apiKey = String(appUISettings.optimizeApiKey || '').trim();
  const baseUrl = String(appUISettings.optimizeBaseUrl || '').trim() || null;
  if (!apiKey) {
    throw new Error('请先在全局设置填写 AI 优化 API Key');
  }
  if (!model) {
    throw new Error('请先在全局设置填写 AI 优化模型');
  }

  const invokePromise = invokeWithDebug('optimize_prompt_api', {
    provider,
    api_key: apiKey,
    base_url: baseUrl,
    model,
    prompt: promptText,
    timeout_seconds: Math.max(5, Math.round(timeoutMs / 1000))
  });
  const timeoutPromise = new Promise((_, reject) => {
    window.setTimeout(() => reject(new Error(`优化请求超时（前端 ${Math.round(timeoutMs / 1000)}s）`)), timeoutMs);
  });
  return Promise.race([invokePromise, timeoutPromise]);
}

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
const appToast = document.getElementById('app-toast');
const runningSessionsContainer = document.getElementById('running-sessions');
const runningSessionsList = document.getElementById('running-sessions-list');
const promptAiOptimizeBtn = document.getElementById('prompt-ai-optimize-btn');
const promptGuideBtn = document.getElementById('prompt-guide-btn');
const promptGuideModal = document.getElementById('prompt-guide-modal');
const promptGuideCloseBtn = document.getElementById('prompt-guide-close-btn');
const promptGuideOkBtn = document.getElementById('prompt-guide-ok-btn');
const appSettingsBtn = document.getElementById('app-settings-btn');
const appSettingsModal = document.getElementById('app-settings-modal');
const appSettingsCloseBtn = document.getElementById('app-settings-close-btn');
const appSettingsCancelBtn = document.getElementById('app-settings-cancel-btn');
const appSettingsSaveBtn = document.getElementById('app-settings-save-btn');
const appDefaultPromptInput = document.getElementById('app-default-prompt');
const appDefaultMaxIterationsInput = document.getElementById('app-default-max-iterations');
const appDefaultClaudeSettingSelect = document.getElementById('app-default-claude-setting');
const appOptimizePresetInput = document.getElementById('app-optimize-preset');
const appOptimizeProviderSelect = document.getElementById('app-optimize-provider');
const appOptimizeBaseUrlInput = document.getElementById('app-optimize-base-url');
const appOptimizeModelInput = document.getElementById('app-optimize-model');
const appOptimizeApiKeyInput = document.getElementById('app-optimize-api-key');
const taskPlanModal = document.getElementById('task-plan-modal');
const taskPlanCloseBtn = document.getElementById('task-plan-close-btn');
const taskPlanCancelBtn = document.getElementById('task-plan-cancel-btn');
const taskPlanConfirmBtn = document.getElementById('task-plan-confirm-btn');
const taskPlanSummary = document.getElementById('task-plan-summary');
const taskPlanList = document.getElementById('task-plan-list');

function openPromptGuideModal() {
  if (!promptGuideModal) {
    return;
  }
  promptGuideModal.classList.remove('hidden');
  promptGuideModal.classList.add('visible');
}

function closePromptGuideModal() {
  if (!promptGuideModal) {
    return;
  }
  promptGuideModal.classList.remove('visible');
  promptGuideModal.classList.add('hidden');
}

async function refreshAppDefaultClaudeSettingOptions(selectedId = appUISettings.defaultClaudeSettingId) {
  if (!appDefaultClaudeSettingSelect || !invoke) {
    return;
  }
  try {
    const settings = await invoke('get_claude_settings_files');
    appDefaultClaudeSettingSelect.innerHTML = '';
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = '不指定（保持项目配置）';
    appDefaultClaudeSettingSelect.appendChild(defaultOption);
    settings.forEach((setting) => {
      const option = document.createElement('option');
      option.value = setting.id;
      option.textContent = setting.name;
      appDefaultClaudeSettingSelect.appendChild(option);
    });
    const hasSelectedOption = settings.some((setting) => setting.id === selectedId);
    appDefaultClaudeSettingSelect.value = hasSelectedOption ? selectedId : '';
  } catch (error) {
    appendDebugLog('加载默认 Claude Setting 选项失败', error);
  }
}

function applyAppSettingsToForm() {
  const currentProject = getCurrentProject();
  if (!currentProject) {
    if (promptInput && !promptInput.value.trim() && appUISettings.defaultPrompt.trim()) {
      promptInput.value = appUISettings.defaultPrompt;
    }
    if (maxIterationsInput && !maxIterationsInput.value.trim()) {
      maxIterationsInput.value = String(appUISettings.defaultMaxIterations);
    }
    return;
  }

  if (promptInput && !String(currentProject.last_prompt || '').trim()) {
    promptInput.value = appUISettings.defaultPrompt || '';
  }
  if (maxIterationsInput && !Number.isInteger(currentProject.max_iterations)) {
    maxIterationsInput.value = String(appUISettings.defaultMaxIterations);
  }
}

async function openAppSettingsModal() {
  if (!appSettingsModal) {
    return;
  }
  if (appDefaultPromptInput) {
    appDefaultPromptInput.value = appUISettings.defaultPrompt;
  }
  if (appDefaultMaxIterationsInput) {
    appDefaultMaxIterationsInput.value = String(appUISettings.defaultMaxIterations);
  }
  if (appOptimizePresetInput) {
    appOptimizePresetInput.value = appUISettings.optimizePreset;
  }
  if (appOptimizeProviderSelect) {
    appOptimizeProviderSelect.value = appUISettings.optimizeProvider || 'anthropic';
  }
  if (appOptimizeBaseUrlInput) {
    appOptimizeBaseUrlInput.value = appUISettings.optimizeBaseUrl || '';
  }
  if (appOptimizeModelInput) {
    appOptimizeModelInput.value = appUISettings.optimizeModel || '';
  }
  if (appOptimizeApiKeyInput) {
    appOptimizeApiKeyInput.value = appUISettings.optimizeApiKey || '';
  }
  await refreshAppDefaultClaudeSettingOptions(appUISettings.defaultClaudeSettingId);
  appSettingsModal.classList.remove('hidden');
  appSettingsModal.classList.add('visible');
}

function closeAppSettingsModal() {
  if (!appSettingsModal) {
    return;
  }
  appSettingsModal.classList.remove('visible');
  appSettingsModal.classList.add('hidden');
}

function saveAppSettingsFromModal() {
  if (
    !appDefaultPromptInput
    || !appDefaultMaxIterationsInput
    || !appOptimizePresetInput
    || !appDefaultClaudeSettingSelect
  ) {
    return;
  }

  const draftSettings = normalizeAppUISettings({
    defaultPrompt: appDefaultPromptInput.value,
    defaultMaxIterations: appDefaultMaxIterationsInput.value,
    defaultClaudeSettingId: appDefaultClaudeSettingSelect.value,
    optimizePreset: appOptimizePresetInput.value,
    optimizeProvider: appOptimizeProviderSelect?.value || 'anthropic',
    optimizeBaseUrl: appOptimizeBaseUrlInput?.value || '',
    optimizeModel: appOptimizeModelInput?.value || '',
    optimizeApiKey: appOptimizeApiKeyInput?.value || ''
  });
  appUISettings = draftSettings;
  saveAppUISettingsToStorage(appUISettings);
  applyAppSettingsToForm();
  closeAppSettingsModal();
  appendDebugLog('全局设置已更新', appUISettings);
}

async function applyDefaultClaudeSettingIfNeeded(project) {
  if (!project || !projectManager || !appUISettings.defaultClaudeSettingId) {
    return project;
  }
  if (project.claude_setting_id) {
    return project;
  }
  try {
    const updated = await projectManager.updateProject(
      project.id,
      {
        name: project.name,
        description: project.description,
        workDirectory: project.work_directory,
        maxIterations: project.max_iterations,
        completionPromise: project.completion_promise,
        lastPrompt: project.last_prompt,
        claudeSettingId: appUISettings.defaultClaudeSettingId,
        overwriteClaudeSettings: false,
        enabled: project.enabled
      },
      {
        reloadProjects: false,
        silent: true,
        closeModal: false
      }
    );
    appendDebugLog('已自动应用默认 Claude Setting', {
      project_id: project.id,
      setting_id: appUISettings.defaultClaudeSettingId
    });
    return updated;
  } catch (error) {
    appendDebugLog('自动应用默认 Claude Setting 失败', error);
    return project;
  }
}

function closeTaskPlanModal(confirmed = false) {
  if (!taskPlanModal) {
    return;
  }
  taskPlanModal.classList.remove('visible');
  taskPlanModal.classList.add('hidden');
  if (taskPlanModalResolver) {
    const resolve = taskPlanModalResolver;
    taskPlanModalResolver = null;
    resolve(Boolean(confirmed));
  }
}

function openTaskPlanModal(projectName, sourcePrompt, taskItems) {
  if (!taskPlanModal || !taskPlanSummary || !taskPlanList) {
    return Promise.resolve(true);
  }
  if (taskPlanModalResolver) {
    taskPlanModalResolver(false);
    taskPlanModalResolver = null;
  }
  taskPlanSummary.textContent = `项目：${projectName}\n目标：${sourcePrompt || '未提供，已使用默认提示词'}`;
  taskPlanList.innerHTML = '';
  taskItems.forEach((task) => {
    const item = document.createElement('li');
    item.textContent = task;
    taskPlanList.appendChild(item);
  });

  taskPlanModal.classList.remove('hidden');
  taskPlanModal.classList.add('visible');
  return new Promise((resolve) => {
    taskPlanModalResolver = resolve;
  });
}

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
    `Tauri 运行时不可用。has__TAURI__=${hasTauri}, has__TAURI_INTERNALS__=${hasInternals}.`
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
 * Extracts one readable error message from nested/unknown error payloads.
 */
function extractErrorMessage(error) {
  const parsePossibleJsonMessage = (text) => {
    const normalized = String(text || '').trim();
    if (!normalized) {
      return '';
    }

    const candidates = [];
    if (normalized.startsWith('{') && normalized.endsWith('}')) {
      candidates.push(normalized);
    } else {
      const firstBrace = normalized.indexOf('{');
      const lastBrace = normalized.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        candidates.push(normalized.slice(firstBrace, lastBrace + 1));
      }
    }

    for (const rawCandidate of candidates) {
      try {
        const parsed = JSON.parse(rawCandidate);
        const nestedMessage =
          (typeof parsed?.error?.message === 'string' && parsed.error.message) ||
          (typeof parsed?.msg === 'string' && parsed.msg) ||
          (typeof parsed?.message === 'string' && parsed.message) ||
          '';
        if (nestedMessage) {
          const code = parsed?.error?.code ?? parsed?.code;
          return code !== undefined && code !== null && code !== ''
            ? `code=${String(code)}, ${nestedMessage}`
            : nestedMessage;
        }
      } catch (_err) {
        // Ignore non-JSON text and continue.
      }
    }
    return '';
  };

  if (error == null) {
    return '未知错误';
  }
  if (typeof error === 'string') {
    const parsedMessage = parsePossibleJsonMessage(error);
    return parsedMessage || error.trim() || '未知错误';
  }
  if (error instanceof Error) {
    const parsedMessage = parsePossibleJsonMessage(error.message);
    return parsedMessage || error.message || `${error.name}: 未知错误`;
  }
  if (typeof error === 'object') {
    const directMessage = typeof error.message === 'string' ? error.message : '';
    if (directMessage) {
      const parsedMessage = parsePossibleJsonMessage(directMessage);
      return parsedMessage || directMessage;
    }
    const nestedMessage = typeof error.error?.message === 'string' ? error.error.message : '';
    if (nestedMessage) {
      return nestedMessage;
    }
    const msg = typeof error.msg === 'string' ? error.msg : '';
    if (msg) {
      const code = typeof error.code !== 'undefined' ? String(error.code) : '';
      return code ? `code=${code}, msg=${msg}` : msg;
    }
    try {
      const dumped = JSON.stringify(error);
      return dumped && dumped !== '{}' ? dumped : '未知错误对象';
    } catch (_err) {
      return String(error);
    }
  }
  return String(error);
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

function showToast(message, variant = 'error', durationMs = 4500) {
  const text = String(message || '').trim();
  if (!text) {
    return;
  }
  if (!appToast) {
    alert(text);
    return;
  }

  appToast.textContent = text;
  appToast.classList.remove('success');
  if (variant === 'success') {
    appToast.classList.add('success');
  }
  appToast.classList.add('show');

  if (toastHideTimer) {
    window.clearTimeout(toastHideTimer);
  }
  toastHideTimer = window.setTimeout(() => {
    appToast.classList.remove('show');
    toastHideTimer = null;
  }, Math.max(1200, Number(durationMs) || 4500));
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
      ? `空闲倒计时: 等待运行 (${formatDurationSeconds(Math.ceil(autoIdleNextLoopMs / 1000))})`
      : '空闲倒计时: 已关闭';
    const hardBase = autoHardStopMs > 0
      ? `硬中断倒计时: 等待运行 (${formatDurationSeconds(Math.ceil(autoHardStopMs / 1000))})`
      : '硬中断倒计时: 已关闭';
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
    ? `空闲倒计时: ${formatDurationSeconds(Math.max(0, Math.ceil((idleRemainingMs || 0) / 1000)))}`
    : '空闲倒计时: 已关闭';
  hardStopCountdown.textContent = autoHardStopMs > 0
    ? `硬中断倒计时: ${formatDurationSeconds(Math.max(0, Math.ceil((hardRemainingMs || 0) / 1000)))}`
    : '硬中断倒计时: 已关闭';
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
    appendDebugLog('空闲切换超时已更新', {
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
    appendDebugLog('硬中断超时已更新', {
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
  appendDebugLog('运行超时控制已初始化', {
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
  toggleBtn.innerHTML = `<i data-lucide="${currentProjectEnabled ? 'toggle-right' : 'toggle-left'}"></i> ${currentProjectEnabled ? '禁用项目' : '启用项目'}`;
  startBtn.disabled = !hasCurrentProject || !currentProjectEnabled || currentProjectRunning;
  stopBtn.disabled = !currentProjectRunning;
  sendBtn.disabled = !currentProjectRunning;
  terminalInput.disabled = !currentProjectRunning;
  workDirInput.disabled = currentProjectRunning;
  promptInput.disabled = currentProjectRunning;
  maxIterationsInput.disabled = currentProjectRunning;
  completionPromiseInput.disabled = currentProjectRunning;

  if (statusDiv) {
    statusDiv.className = 'status';

    if (currentProjectRunning) {
      statusDiv.classList.add('running');
      statusDiv.textContent = `状态: 运行中 (${runningCount} 个任务)`;
    } else if (!hasCurrentProject) {
      statusDiv.classList.add('disabled');
      statusDiv.textContent = '状态: 未选择项目';
    } else if (runningCount > 0) {
      statusDiv.classList.add('enabled');
      statusDiv.textContent = `状态: 当前项目空闲 (另有 ${runningCount} 个任务运行)`;
    } else if (currentProjectEnabled) {
      statusDiv.classList.add('enabled');
      statusDiv.textContent = '状态: 项目已启用';
    } else {
      statusDiv.classList.add('disabled');
      statusDiv.textContent = '状态: 项目已禁用';
    }
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
    promptInput.value = project.last_prompt || appUISettings.defaultPrompt || '';
    maxIterationsInput.value = project.max_iterations?.toString() || String(appUISettings.defaultMaxIterations);
    completionPromiseInput.value = project.completion_promise || '';
  } else {
    currentProjectEnabled = false;
    // Clear form when no project selected
    workDirInput.value = '';
    promptInput.value = appUISettings.defaultPrompt || '';
    maxIterationsInput.value = String(appUISettings.defaultMaxIterations);
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
    initializeAppUISettings();
    appendDebugLog('tauri runtime detected');

    // Initialize project manager
    projectManager = new ProjectManager(invoke);
    projectManager.onProjectChange = handleProjectChange;
    projectManager.onProjectsUpdate = handleProjectsUpdate;
    projectManager.onProjectRun = handleProjectRun;
    projectManager.onProjectToggle = handleProjectToggle;
    projectManager.onClaudeSettingsChange = () => {
      void refreshAppDefaultClaudeSettingOptions();
    };
    await projectManager.initialize();
    appendDebugLog('project manager initialized');
    initializeRuntimeTimeoutControls();
    await refreshAppDefaultClaudeSettingOptions();
    applyAppSettingsToForm();

    currentProjectEnabled = Boolean(projectManager.getCurrentProject()?.enabled);
    syncUI();

    // Initial icon render
    refreshPageIcons();

    startPolling();
    await refreshBackendDebugState();
    await pollLoopOutput();
  } catch (err) {
    appendDebugLog('init failed', err);
    alert(`初始化失败: ${serializeDebugValue(err)}`);
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
    alert(`切换失败: ${serializeDebugValue(err)}`);
    return false;
  }
}

async function handlePromptAiOptimize() {
  if (!promptInput) {
    return;
  }

  const currentProject = getCurrentProject();
  const workDir = workDirInput.value || currentProject?.work_directory || '.';
  const {
    requestPrompt,
    tasks
  } = buildPromptOptimizationRequest(promptInput.value);

  if (promptAiOptimizeBtn) {
    promptAiOptimizeBtn.disabled = true;
    promptAiOptimizeBtn.textContent = '优化中...';
  }

  try {
    appendDebugLog('提示词优化请求已发送', {
      protocol: 'claude-cli',
      work_dir: workDir
    });
    const aiOutput = await runOptimizePromptInvoke(requestPrompt, 30_000);
    const unwrappedPrompt = unwrapAiOptimizedPrompt(aiOutput);
    if (!unwrappedPrompt) {
      throw new Error('AI 返回为空，未生成可用提示词');
    }
    const finalPrompt = upsertTaskListIntoPrompt(unwrappedPrompt, tasks);

    promptInput.value = finalPrompt;
    if (!String(maxIterationsInput.value || '').trim()) {
      maxIterationsInput.value = String(appUISettings.defaultMaxIterations);
    }
    queueProjectAutoSave('prompt-ai-optimize', { force: true });
    appendDebugLog('提示词已通过 Claude AI 优化', {
      source_prompt_preview: String(promptInput.value || '').slice(0, 120),
      optimized_length: finalPrompt.length,
      generated_task_count: tasks.length
    });
  } catch (error) {
    const errorMessage = extractErrorMessage(error);
    appendDebugLog('AI 优化失败（直接返回）', {
      message: errorMessage,
      raw: error
    });
    showToast(`AI 优化失败: ${errorMessage}`, 'error', 6000);
  } finally {
    if (promptAiOptimizeBtn) {
      promptAiOptimizeBtn.innerHTML = '<i data-lucide="wand-sparkles"></i> AI 优化';
      promptAiOptimizeBtn.disabled = false;
      refreshPageIcons();
    }
  }
}

/**
 * Handles start button clicks.
 */
async function handleStart(options = {}) {
  const {
    projectId = null,
    preserveTerminalHistory = false,
    triggerSource = 'manual',
    skipTaskPlanReview = false
  } = options;
  let currentProject = projectManager?.getCurrentProject();
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

  if (!skipTaskPlanReview) {
    const promptSeed = String(promptInput.value || '').trim()
      || appUISettings.defaultPrompt.trim()
      || currentProject.description
      || currentProject.name;
    const taskItems = generateDetailedTaskList(promptSeed);
    const approved = await openTaskPlanModal(currentProject.name, promptSeed, taskItems);
    if (!approved) {
      appendDebugLog('start canceled in task-plan review', { project_id: targetProjectId });
      return;
    }

    const promptBaseline = String(promptInput.value || '').trim()
      ? promptInput.value
      : (appUISettings.defaultPrompt || promptSeed);
    const promptWithTaskList = upsertTaskListIntoPrompt(promptBaseline, taskItems);
    if (promptInput.value !== promptWithTaskList) {
      promptInput.value = promptWithTaskList;
    }
    if (!String(maxIterationsInput.value || '').trim()) {
      maxIterationsInput.value = String(appUISettings.defaultMaxIterations);
    }

    queueProjectAutoSave('task-plan-generated', { force: true });
    return handleStart({
      ...options,
      skipTaskPlanReview: true
    });
  }

  // Ensure latest right-side edits are persisted before run.
  await flushProjectAutoSave('before-start', { force: true });
  currentProject = projectManager?.getCurrentProject() || currentProject;
  currentProject = await applyDefaultClaudeSettingIfNeeded(currentProject);
  currentProject = projectManager?.getCurrentProject() || currentProject;

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
    : (currentProject.max_iterations || appUISettings.defaultMaxIterations);
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
    alert(`启动失败: ${serializeDebugValue(err)}`);
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
    alert(`停止失败: ${serializeDebugValue(err)}`);
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
    alert(`发送输入失败: ${serializeDebugValue(err)}`);
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
if (promptAiOptimizeBtn) {
  promptAiOptimizeBtn.addEventListener('click', handlePromptAiOptimize);
}
if (promptGuideBtn) {
  promptGuideBtn.addEventListener('click', openPromptGuideModal);
}
if (promptGuideCloseBtn) {
  promptGuideCloseBtn.addEventListener('click', closePromptGuideModal);
}
if (promptGuideOkBtn) {
  promptGuideOkBtn.addEventListener('click', closePromptGuideModal);
}
if (promptGuideModal) {
  promptGuideModal.addEventListener('click', (event) => {
    if (event.target === promptGuideModal) {
      closePromptGuideModal();
    }
  });
}
if (appSettingsBtn) {
  appSettingsBtn.addEventListener('click', () => {
    void openAppSettingsModal();
  });
}
if (appSettingsCloseBtn) {
  appSettingsCloseBtn.addEventListener('click', closeAppSettingsModal);
}
if (appSettingsCancelBtn) {
  appSettingsCancelBtn.addEventListener('click', closeAppSettingsModal);
}
if (appSettingsSaveBtn) {
  appSettingsSaveBtn.addEventListener('click', saveAppSettingsFromModal);
}
if (appSettingsModal) {
  appSettingsModal.addEventListener('click', (event) => {
    if (event.target === appSettingsModal) {
      closeAppSettingsModal();
    }
  });
}
if (taskPlanCloseBtn) {
  taskPlanCloseBtn.addEventListener('click', () => closeTaskPlanModal(false));
}
if (taskPlanCancelBtn) {
  taskPlanCancelBtn.addEventListener('click', () => closeTaskPlanModal(false));
}
if (taskPlanConfirmBtn) {
  taskPlanConfirmBtn.addEventListener('click', () => closeTaskPlanModal(true));
}
if (taskPlanModal) {
  taskPlanModal.addEventListener('click', (event) => {
    if (event.target === taskPlanModal) {
      closeTaskPlanModal(false);
    }
  });
}
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') {
    return;
  }
  if (taskPlanModal?.classList.contains('visible')) {
    closeTaskPlanModal(false);
    return;
  }
  if (appSettingsModal?.classList.contains('visible')) {
    closeAppSettingsModal();
    return;
  }
  if (promptGuideModal?.classList.contains('visible')) {
    closePromptGuideModal();
  }
});
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
