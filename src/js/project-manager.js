/**
 * Project Manager for Ralph Loop Editor
 * Handles all project-related operations and UI management
 */

import { createIcons, Play, Pause, Edit2, Trash2 } from 'lucide';

const DEFAULT_CLAUDE_SETTING_TEMPLATE = `{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "",
    "ANTHROPIC_BASE_URL": "",
    "ANTHROPIC_MODEL": ""
  },
  "permissions": {
    "allow": []
  },
  "model": "",
  "enabledPlugins": {},
  "skipDangerousModePermissionPrompt": true
}`;

export class ProjectManager {
  constructor(invokeFunction) {
    this.invoke = invokeFunction;
    this.projects = [];
    this.currentProject = null;
    this.claudeSettings = [];
    this.onProjectChange = null;
    this.onProjectsUpdate = null;
    this.onProjectRun = null;
    this.onProjectToggle = null; // callback(projectId, newEnabled)
    this.onClaudeSettingsChange = null;
    this.pendingDeleteProject = null;
    this.isDeletingProject = false;
    this.deletingClaudeSettingIds = new Set();

    // Lucide icons map
    this.icons = {
      Play,
      Pause,
      Edit2,
      Trash2
    };

    // DOM element references
    this.elements = {};

    console.log('[ProjectManager] initialized');
  }

  /**
   * Refresh icons in a scoped root.
   */
  refreshIcons(element = null) {
    try {
      createIcons({
        icons: this.icons,
        nameAttr: 'data-lucide',
        attrs: {
          'stroke-width': 2,
        },
        ...(element ? { root: element } : {})
      });
    } catch (err) {
      console.error('[ProjectManager] Failed to refresh icons:', err);
    }
  }

  /**
   * Initialize DOM element references
   */
  initializeElements() {
    this.elements = {
      projectList: document.getElementById('project-list'),
      newProjectBtn: document.getElementById('new-project-btn'),
      projectModal: document.getElementById('project-modal'),
      projectForm: document.getElementById('project-form'),
      modalTitle: document.getElementById('modal-title'),
      projectNameInput: document.getElementById('project-name'),
      projectDescriptionInput: document.getElementById('project-description'),
      projectWorkDirInput: document.getElementById('project-work-dir'),
      projectEnabledInput: document.getElementById('project-enabled'),
      projectSaveBtn: document.getElementById('project-save-btn'),
      projectCancelBtn: document.getElementById('project-cancel-btn'),
      modalCloseBtn: document.getElementById('modal-close-btn'),
      currentProjectName: document.getElementById('current-project-name'),
      deleteConfirmModal: document.getElementById('delete-confirm-modal'),
      deleteProjectName: document.getElementById('delete-project-name'),
      deleteConfirmBtn: document.getElementById('delete-confirm-btn'),
      deleteCancelBtn: document.getElementById('delete-cancel-btn'),
      deleteCloseBtn: document.getElementById('delete-close-btn'),
      projectClaudeSettingSelect: document.getElementById('project-claude-setting-select'),
      projectOverwriteClaudeSettingsInput: document.getElementById('project-overwrite-claude-setting'),
      projectOpenSettingModalBtn: document.getElementById('project-open-setting-modal-btn'),
      manageClaudeSettingsBtn: document.getElementById('manage-claude-settings-btn'),
      settingsModal: document.getElementById('claude-settings-modal'),
      settingsModalCloseBtn: document.getElementById('claude-settings-close-btn'),
      settingsModalCancelBtn: document.getElementById('claude-settings-cancel-btn'),
      settingsModalNewBtn: document.getElementById('claude-settings-new-btn'),
      settingsModalSaveBtn: document.getElementById('claude-settings-save-btn'),
      settingsNameInput: document.getElementById('claude-settings-name'),
      settingsContentInput: document.getElementById('claude-settings-content'),
      settingsList: document.getElementById('claude-settings-list'),
      settingsQuickConfigNameInput: document.getElementById('claude-quick-config-name'),
      settingsQuickModelInput: document.getElementById('claude-quick-model'),
      settingsQuickBaseUrlInput: document.getElementById('claude-quick-base-url'),
      settingsQuickAuthTokenInput: document.getElementById('claude-quick-auth-token'),
      settingsQuickSaveBtn: document.getElementById('claude-quick-save-btn')
    };

    this.settingsModalReturnToProject = false;
    this.editingClaudeSettingId = null;
    console.log('[ProjectManager] DOM elements initialized');
  }

  /**
   * Setup event listeners
   */
  setupEventListeners() {
    const { elements } = this;

    // New project button
    if (elements.newProjectBtn) {
      elements.newProjectBtn.addEventListener('click', () => {
        void this.showNewProjectModal();
      });
    }

    // Modal buttons
    if (elements.projectSaveBtn) {
      elements.projectSaveBtn.addEventListener('click', () => this.handleSaveProject());
    }

    if (elements.projectCancelBtn) {
      elements.projectCancelBtn.addEventListener('click', () => this.hideModal());
    }

    if (elements.modalCloseBtn) {
      elements.modalCloseBtn.addEventListener('click', () => this.hideModal());
    }

    // Close modal on outside click
    if (elements.projectModal) {
      elements.projectModal.addEventListener('click', (e) => {
        if (e.target === elements.projectModal) {
          this.hideModal();
        }
      });
    }

    if (elements.projectOpenSettingModalBtn) {
      elements.projectOpenSettingModalBtn.addEventListener('click', () => {
        this.showClaudeSettingsModal({ returnToProject: true });
      });
    }

    // Delete confirmation modal buttons
    if (elements.deleteConfirmBtn) {
      elements.deleteConfirmBtn.addEventListener('click', () => {
        void this.confirmDeleteProject();
      });
    }

    if (elements.deleteCancelBtn) {
      elements.deleteCancelBtn.addEventListener('click', () => this.hideDeleteConfirmModal());
    }

    if (elements.deleteCloseBtn) {
      elements.deleteCloseBtn.addEventListener('click', () => this.hideDeleteConfirmModal());
    }

    // Close delete modal on outside click
    if (elements.deleteConfirmModal) {
      elements.deleteConfirmModal.addEventListener('click', (e) => {
        if (e.target === elements.deleteConfirmModal) {
          this.hideDeleteConfirmModal();
        }
      });
    }

    // Form submission
    if (elements.projectForm) {
      elements.projectForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.handleSaveProject();
      });
    }

    if (elements.manageClaudeSettingsBtn) {
      elements.manageClaudeSettingsBtn.addEventListener('click', () => {
        this.showClaudeSettingsModal({ returnToProject: false });
      });
    }

    if (elements.projectClaudeSettingSelect) {
      elements.projectClaudeSettingSelect.addEventListener('change', () => {
        this.syncOverwriteCheckboxState();
      });
    }

    if (elements.settingsModalSaveBtn) {
      elements.settingsModalSaveBtn.addEventListener('click', () => {
        void this.handleSaveClaudeSettingFromModal();
      });
    }

    if (elements.settingsQuickSaveBtn) {
      elements.settingsQuickSaveBtn.addEventListener('click', () => {
        void this.handleSaveQuickModelConfigFromModal();
      });
    }

    if (elements.settingsModalCancelBtn) {
      elements.settingsModalCancelBtn.addEventListener('click', () => this.hideClaudeSettingsModal());
    }

    if (elements.settingsModalNewBtn) {
      elements.settingsModalNewBtn.addEventListener('click', () => this.resetClaudeSettingsEditor());
    }

    if (elements.settingsModalCloseBtn) {
      elements.settingsModalCloseBtn.addEventListener('click', () => this.hideClaudeSettingsModal());
    }

    if (elements.settingsModal) {
      elements.settingsModal.addEventListener('click', (e) => {
        if (e.target === elements.settingsModal) {
          this.hideClaudeSettingsModal();
        }
      });
    }

    console.log('[ProjectManager] event listeners setup complete');
  }

  /**
   * Load Claude setting files from backend.
   */
  async loadClaudeSettings(selectedSettingId = '', options = {}) {
    const { refreshProjectList = false } = options;
    try {
      this.claudeSettings = await this.invoke('get_claude_settings_files');
      if (
        this.editingClaudeSettingId &&
        !this.claudeSettings.some((setting) => setting.id === this.editingClaudeSettingId)
      ) {
        this.editingClaudeSettingId = null;
        this.syncSettingsModalSaveButtonLabel();
      }
      this.renderClaudeSettingOptions(selectedSettingId);
      this.renderClaudeSettingsList();
      if (this.onClaudeSettingsChange) {
        this.onClaudeSettingsChange(this.claudeSettings);
      }
      if (refreshProjectList) {
        this.renderProjectList();
      }
    } catch (error) {
      console.error('[ProjectManager] failed to load Claude settings:', error);
      this.showError('加载 Claude setting 文件失败: ' + error);
    }
  }

  /**
   * Render Claude setting options into select element.
   */
  renderClaudeSettingOptions(selectedSettingId = '') {
    const { projectClaudeSettingSelect } = this.elements;
    if (!projectClaudeSettingSelect) {
      return;
    }

    const fallbackSelectedId = selectedSettingId || projectClaudeSettingSelect.value || '';
    projectClaudeSettingSelect.innerHTML = '';

    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = '不使用 Claude setting 文件';
    projectClaudeSettingSelect.appendChild(defaultOption);

    this.claudeSettings.forEach((setting) => {
      const option = document.createElement('option');
      option.value = setting.id;
      option.textContent = setting.name;
      option.selected = setting.id === fallbackSelectedId;
      projectClaudeSettingSelect.appendChild(option);
    });

    this.syncOverwriteCheckboxState();
  }

  /**
   * Render setting list in settings modal.
   */
  renderClaudeSettingsList() {
    const { settingsList } = this.elements;
    if (!settingsList) {
      return;
    }

    settingsList.innerHTML = '';
    if (this.claudeSettings.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'setting-list-empty';
      empty.textContent = '还没有 setting 文件';
      settingsList.appendChild(empty);
      return;
    }

    this.claudeSettings.forEach((setting) => {
      const item = document.createElement('div');
      item.className = 'setting-list-item';
      if (setting.id === this.editingClaudeSettingId) {
        item.classList.add('active');
      }

      const nameElement = document.createElement('div');
      nameElement.className = 'setting-list-name';
      nameElement.textContent = setting.name;

      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'setting-list-delete-btn';
      deleteButton.textContent = '删除';
      deleteButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        void this.handleDeleteClaudeSetting(setting);
      });

      item.appendChild(nameElement);
      item.appendChild(deleteButton);
      item.addEventListener('click', () => {
        void this.loadClaudeSettingForEdit(setting.id);
      });
      settingsList.appendChild(item);
    });
  }

  /**
   * Resolve setting name from selected id.
   */
  getClaudeSettingName(settingId) {
    if (!settingId) {
      return '';
    }
    const matched = this.claudeSettings.find((setting) => setting.id === settingId);
    return matched?.name || '';
  }

  /**
   * Disable overwrite switch when no setting file is selected.
   */
  syncOverwriteCheckboxState() {
    const { projectClaudeSettingSelect, projectOverwriteClaudeSettingsInput } = this.elements;
    if (!projectClaudeSettingSelect || !projectOverwriteClaudeSettingsInput) {
      return;
    }

    const hasSelectedSetting = Boolean(projectClaudeSettingSelect.value);
    projectOverwriteClaudeSettingsInput.disabled = !hasSelectedSetting;
    if (!hasSelectedSetting) {
      projectOverwriteClaudeSettingsInput.checked = false;
    }
  }

  /**
   * Shows independent Claude settings modal.
   */
  showClaudeSettingsModal({ returnToProject = false } = {}) {
    const { settingsModal } = this.elements;
    this.settingsModalReturnToProject = returnToProject;
    this.resetClaudeSettingsEditor();
    void this.loadClaudeSettings(this.elements.projectClaudeSettingSelect?.value || '');
    if (settingsModal) {
      settingsModal.classList.remove('hidden');
      settingsModal.classList.add('visible');
    }
  }

  /**
   * Hides independent Claude settings modal.
   */
  hideClaudeSettingsModal() {
    const { settingsModal } = this.elements;
    if (settingsModal) {
      settingsModal.classList.remove('visible');
      settingsModal.classList.add('hidden');
    }
    this.settingsModalReturnToProject = false;
  }

  /**
   * Resets settings editor to create-new mode.
   */
  resetClaudeSettingsEditor() {
    const { settingsNameInput, settingsContentInput } = this.elements;
    this.editingClaudeSettingId = null;
    if (settingsNameInput) {
      settingsNameInput.value = '';
    }
    if (settingsContentInput) {
      settingsContentInput.value = DEFAULT_CLAUDE_SETTING_TEMPLATE;
    }
    this.syncSettingsModalSaveButtonLabel();
    this.renderClaudeSettingsList();
  }

  /**
   * Loads one existing setting into editor for update.
   */
  async loadClaudeSettingForEdit(settingId) {
    try {
      const setting = await this.invoke('get_claude_settings_file_content', { setting_id: settingId });
      this.editingClaudeSettingId = setting.id;
      if (this.elements.settingsNameInput) {
        this.elements.settingsNameInput.value = setting.name || '';
      }
      if (this.elements.settingsContentInput) {
        this.elements.settingsContentInput.value = setting.content || '';
      }
      this.syncSettingsModalSaveButtonLabel();
      this.renderClaudeSettingsList();
    } catch (error) {
      console.error('[ProjectManager] failed to load setting for edit:', error);
      this.showError('加载 setting 文件失败: ' + error);
    }
  }

  /**
   * Deletes one Claude setting after confirmation.
   */
  async handleDeleteClaudeSetting(setting) {
    if (!setting?.id || this.deletingClaudeSettingIds.has(setting.id)) {
      return;
    }
    const shouldDelete = await this.requestConfirm(`确认删除 setting "${setting.name}" 吗？`);
    if (!shouldDelete) {
      return;
    }
    this.deletingClaudeSettingIds.add(setting.id);
    try {
      await this.invoke('delete_claude_settings_file', { setting_id: setting.id });
      const previousSelectedId = this.elements.projectClaudeSettingSelect?.value || '';
      const nextSelectedId = previousSelectedId === setting.id ? '' : previousSelectedId;
      await this.loadClaudeSettings(nextSelectedId, { refreshProjectList: true });
      await this.loadProjects();
      await this.loadCurrentProject();
      if (this.editingClaudeSettingId === setting.id) {
        this.resetClaudeSettingsEditor();
      }
      this.showSuccess(`setting 文件 "${setting.name}" 已删除`);
    } catch (error) {
      console.error('[ProjectManager] failed to delete setting file:', error);
      this.showError('删除 setting 文件失败: ' + error);
    } finally {
      this.deletingClaudeSettingIds.delete(setting.id);
    }
  }

  async requestConfirm(message) {
    const promptText = String(message || '').trim() || '确认继续吗？';

    try {
      const hasTauriRuntime = Boolean(
        typeof window !== 'undefined' && (window.__TAURI__ || window.__TAURI_INTERNALS__)
      );
      if (!hasTauriRuntime && typeof window !== 'undefined' && typeof window.confirm === 'function') {
        return window.confirm(promptText);
      }
    } catch (error) {
      console.warn('[ProjectManager] window.confirm unavailable, fallback to custom confirm:', error);
    }

    if (typeof document === 'undefined' || !document.body) {
      return true;
    }

    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.position = 'fixed';
      overlay.style.inset = '0';
      overlay.style.background = 'rgba(15, 23, 42, 0.45)';
      overlay.style.display = 'flex';
      overlay.style.alignItems = 'center';
      overlay.style.justifyContent = 'center';
      overlay.style.zIndex = '99999';

      const panel = document.createElement('div');
      panel.style.width = 'min(420px, calc(100vw - 24px))';
      panel.style.background = '#ffffff';
      panel.style.borderRadius = '12px';
      panel.style.boxShadow = '0 20px 40px rgba(15, 23, 42, 0.25)';
      panel.style.padding = '16px';
      panel.style.color = '#0f172a';

      const text = document.createElement('div');
      text.textContent = promptText;
      text.style.fontSize = '14px';
      text.style.lineHeight = '1.5';
      text.style.marginBottom = '14px';

      const actions = document.createElement('div');
      actions.style.display = 'flex';
      actions.style.justifyContent = 'flex-end';
      actions.style.gap = '8px';

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.textContent = '取消';
      cancelBtn.style.border = '1px solid #cbd5e1';
      cancelBtn.style.background = '#ffffff';
      cancelBtn.style.color = '#334155';
      cancelBtn.style.padding = '6px 12px';
      cancelBtn.style.borderRadius = '8px';
      cancelBtn.style.cursor = 'pointer';

      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.textContent = '确认';
      confirmBtn.style.border = 'none';
      confirmBtn.style.background = '#ef4444';
      confirmBtn.style.color = '#ffffff';
      confirmBtn.style.padding = '6px 12px';
      confirmBtn.style.borderRadius = '8px';
      confirmBtn.style.cursor = 'pointer';

      const cleanup = (result) => {
        document.removeEventListener('keydown', onKeyDown);
        overlay.remove();
        resolve(result);
      };

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          cleanup(false);
        }
      };

      cancelBtn.addEventListener('click', () => cleanup(false));
      confirmBtn.addEventListener('click', () => cleanup(true));
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
          cleanup(false);
        }
      });
      document.addEventListener('keydown', onKeyDown);

      actions.appendChild(cancelBtn);
      actions.appendChild(confirmBtn);
      panel.appendChild(text);
      panel.appendChild(actions);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
      confirmBtn.focus();
    });
  }

  buildClaudeSettingContentFromQuickModel() {
    const model = String(this.elements.settingsQuickModelInput?.value || '').trim();
    const baseUrl = String(this.elements.settingsQuickBaseUrlInput?.value || '').trim();
    const authToken = String(this.elements.settingsQuickAuthTokenInput?.value || '').trim();
    const setting = {
      env: {
        ANTHROPIC_AUTH_TOKEN: authToken,
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_MODEL: model
      },
      permissions: {
        allow: []
      },
      model,
      enabledPlugins: {},
      skipDangerousModePermissionPrompt: true
    };
    return JSON.stringify(setting, null, 2);
  }

  async handleSaveQuickModelConfigFromModal() {
    const {
      settingsQuickConfigNameInput,
      settingsQuickModelInput,
      settingsQuickSaveBtn,
      settingsNameInput,
      settingsContentInput
    } = this.elements;
    const configName = String(settingsQuickConfigNameInput?.value || '').trim();
    const model = String(settingsQuickModelInput?.value || '').trim();

    if (!configName) {
      this.showError('请先输入配置名称');
      return;
    }
    if (!model) {
      this.showError('请先输入模型标识（model）');
      return;
    }

    const content = this.buildClaudeSettingContentFromQuickModel();
    if (settingsQuickSaveBtn) {
      settingsQuickSaveBtn.disabled = true;
      settingsQuickSaveBtn.textContent = '保存中...';
    }

    try {
      let setting = null;
      try {
        setting = await this.invoke('create_claude_settings_file', {
          name: configName,
          content,
          overwrite: false
        });
      } catch (error) {
        const message = String(error || '');
        if (!message.includes('已存在同名 setting 文件')) {
          throw error;
        }
        const shouldOverwrite = await this.requestConfirm(`配置 "${configName}" 已存在，是否覆盖？`);
        if (!shouldOverwrite) {
          return;
        }
        setting = await this.invoke('create_claude_settings_file', {
          name: configName,
          content,
          overwrite: true
        });
      }

      if (!setting?.id) {
        throw new Error('保存配置失败：返回结果为空');
      }

      await this.loadClaudeSettings(setting.id, { refreshProjectList: true });
      this.editingClaudeSettingId = setting.id;
      if (settingsNameInput) {
        settingsNameInput.value = setting.name || configName;
      }
      if (settingsContentInput) {
        settingsContentInput.value = content;
      }
      this.syncSettingsModalSaveButtonLabel();
      this.renderClaudeSettingsList();
      this.showSuccess(`大模型配置已保存为 "${setting.name}"`);
    } catch (error) {
      console.error('[ProjectManager] failed to save quick model config:', error);
      this.showError('保存大模型配置失败: ' + error);
    } finally {
      if (settingsQuickSaveBtn) {
        settingsQuickSaveBtn.disabled = false;
        settingsQuickSaveBtn.textContent = '保存为 Claude Setting';
      }
    }
  }

  /**
   * Create one Claude setting file from settings modal.
   */
  async handleSaveClaudeSettingFromModal() {
    const { settingsNameInput, settingsContentInput, projectClaudeSettingSelect } = this.elements;
    const name = settingsNameInput?.value?.trim() || '';
    const content = settingsContentInput?.value?.trim() || '';

    if (!name) {
      this.showError('setting 名称不能为空');
      return;
    }
    if (!content) {
      this.showError('setting 文件内容不能为空');
      return;
    }

    try {
      const wasEditing = Boolean(this.editingClaudeSettingId);
      let setting = null;
      if (this.editingClaudeSettingId) {
        setting = await this.invoke('update_claude_settings_file', {
          setting_id: this.editingClaudeSettingId,
          name,
          content
        });
      } else {
        setting = await this.invoke('create_claude_settings_file', {
          name,
          content,
          overwrite: false
        });
      }

      await this.loadClaudeSettings(setting.id, { refreshProjectList: true });
      this.editingClaudeSettingId = setting.id;
      this.syncSettingsModalSaveButtonLabel();
      this.renderClaudeSettingsList();
      if (this.settingsModalReturnToProject && projectClaudeSettingSelect) {
        projectClaudeSettingSelect.value = setting.id;
        this.syncOverwriteCheckboxState();
        this.hideClaudeSettingsModal();
      }
      this.showSuccess(wasEditing ? `setting 文件 "${setting.name}" 已保存` : `setting 文件 "${setting.name}" 创建成功`);
    } catch (error) {
      const message = String(error || '');
      if (!this.editingClaudeSettingId && message.includes('已存在同名 setting 文件')) {
        const shouldOverwrite = await this.requestConfirm(`setting "${name}" 已存在，是否覆盖？`);
        if (!shouldOverwrite) {
          return;
        }
        try {
          const setting = await this.invoke('create_claude_settings_file', {
            name,
            content,
            overwrite: true
          });
          await this.loadClaudeSettings(setting.id, { refreshProjectList: true });
          this.editingClaudeSettingId = setting.id;
          this.syncSettingsModalSaveButtonLabel();
          this.renderClaudeSettingsList();
          if (this.settingsModalReturnToProject && projectClaudeSettingSelect) {
            projectClaudeSettingSelect.value = setting.id;
            this.syncOverwriteCheckboxState();
            this.hideClaudeSettingsModal();
          }
          this.showSuccess(`setting 文件 "${setting.name}" 已覆盖`);
        } catch (overwriteError) {
          console.error('[ProjectManager] failed to overwrite setting file:', overwriteError);
          this.showError('覆盖 setting 文件失败: ' + overwriteError);
        }
        return;
      }

      console.error('[ProjectManager] failed to create setting file:', error);
      this.showError('创建 setting 文件失败: ' + error);
    }
  }

  /**
   * Sync save button text according to create/edit mode.
   */
  syncSettingsModalSaveButtonLabel() {
    const { settingsModalSaveBtn } = this.elements;
    if (!settingsModalSaveBtn) {
      return;
    }
    settingsModalSaveBtn.textContent = this.editingClaudeSettingId ? '更新 Setting' : '保存 Setting';
  }

  /**
   * Load all projects from backend
   */
  async loadProjects() {
    try {
      console.log('[ProjectManager] loading projects...');
      const loadedProjects = await this.invoke('get_projects');
      this.projects = Array.isArray(loadedProjects) ? loadedProjects : [];
      console.log('[ProjectManager] loaded', this.projects.length, 'projects');

      if (this.projects.length === 0 && this.currentProject) {
        this.currentProject = null;
        this.updateCurrentProjectDisplay();
        if (this.onProjectChange) {
          this.onProjectChange(null);
        }
      }

      this.renderProjectList();

      if (this.onProjectsUpdate) {
        this.onProjectsUpdate(this.projects);
      }
    } catch (error) {
      console.error('[ProjectManager] failed to load projects:', error);
      this.showError('加载项目失败: ' + error);
    }
  }

  /**
   * Load current project
   */
  async loadCurrentProject() {
    try {
      console.log('[ProjectManager] loading current project...');
      const loadedCurrentProject = await this.invoke('get_current_project');
      const hasProjects = this.projects.length > 0;
      if (!hasProjects || !loadedCurrentProject) {
        this.currentProject = null;
      } else {
        const matchedProject = this.projects.find((project) => project.id === loadedCurrentProject.id);
        if (!matchedProject) {
          console.warn(
            '[ProjectManager] current project not found in project list, fallback to empty selection:',
            loadedCurrentProject.id
          );
          this.currentProject = null;
        } else {
          this.currentProject = matchedProject;
        }
      }
      console.log('[ProjectManager] current project:', this.currentProject?.name || 'none');
      this.updateCurrentProjectDisplay();
      this.renderProjectList();

      if (this.onProjectChange) {
        this.onProjectChange(this.currentProject);
      }
    } catch (error) {
      console.error('[ProjectManager] failed to load current project:', error);
      this.showError('加载当前项目失败: ' + error);
    }
  }

  /**
   * Create a new project
   */
  async createProject(projectData) {
    try {
      console.log('[ProjectManager] creating project:', projectData.name);
      const project = await this.invoke('create_project', {
        name: projectData.name,
        description: projectData.description,
        work_directory: projectData.workDirectory,
        claude_setting_id: projectData.claudeSettingId || null,
        overwrite_claude_settings: Boolean(projectData.overwriteClaudeSettings),
        enabled: Boolean(projectData.enabled),
      });

      console.log('[ProjectManager] project created:', project.id);
      await this.loadProjects(); // Reload all projects
      this.hideModal();
      this.showSuccess('项目创建成功');

      return project;
    } catch (error) {
      console.error('[ProjectManager] failed to create project:', error);
      this.showError('创建项目失败: ' + error);
      throw error;
    }
  }

  /**
   * Update an existing project
   */
  async updateProject(projectId, projectData, options = {}) {
    const { reloadProjects = true, silent = false, closeModal = true } = options;
    try {
      console.log('[ProjectManager] updating project:', projectId);
      const payload = {
        project_id: projectId,
        name: projectData.name,
        description: projectData.description,
        work_directory: projectData.workDirectory,
        max_iterations: projectData.maxIterations || null,
        completion_promise: projectData.completionPromise || null,
      };
      if (Object.prototype.hasOwnProperty.call(projectData, 'lastPrompt')) {
        payload.last_prompt = projectData.lastPrompt;
      }
      if (Object.prototype.hasOwnProperty.call(projectData, 'claudeSettingId')) {
        payload.claude_setting_id = projectData.claudeSettingId;
      }
      if (Object.prototype.hasOwnProperty.call(projectData, 'overwriteClaudeSettings')) {
        payload.overwrite_claude_settings = Boolean(projectData.overwriteClaudeSettings);
      }
      if (Object.prototype.hasOwnProperty.call(projectData, 'enabled')) {
        payload.enabled = Boolean(projectData.enabled);
      }
      const project = await this.invoke('update_project', payload);

      console.log('[ProjectManager] project updated:', project.id);
      if (reloadProjects) {
        await this.loadProjects(); // Reload all projects
      } else {
        this.projects = this.projects.map((item) => (item.id === projectId ? project : item));
        this.renderProjectList();
        if (this.onProjectsUpdate) {
          this.onProjectsUpdate(this.projects);
        }
      }

      // Update current project if it was the one being edited
      if (this.currentProject && this.currentProject.id === projectId) {
        this.currentProject = project;
        this.updateCurrentProjectDisplay();
        if (this.onProjectChange) {
          this.onProjectChange(this.currentProject);
        }
      }

      if (closeModal) {
        this.hideModal();
      }
      if (!silent) {
        this.showSuccess('项目更新成功');
      }

      return project;
    } catch (error) {
      console.error('[ProjectManager] failed to update project:', error);
      if (!silent) {
        this.showError('更新项目失败: ' + error);
      }
      throw error;
    }
  }

  /**
   * Open delete confirmation for a project.
   */
  requestDeleteProject(project) {
    this.pendingDeleteProject = project;
    this.showDeleteConfirmModal(project);
  }

  /**
   * Confirm and execute project deletion.
   */
  async confirmDeleteProject() {
    if (!this.pendingDeleteProject || this.isDeletingProject) {
      return;
    }

    this.isDeletingProject = true;
    this.setDeleteConfirmLoading(true);

    const projectId = this.pendingDeleteProject.id;
    const deleted = await this.performDeleteProject(projectId);

    this.isDeletingProject = false;
    this.setDeleteConfirmLoading(false);

    if (deleted) {
      this.hideDeleteConfirmModal();
    }
  }

  /**
   * Execute delete command and sync UI.
   */
  async performDeleteProject(projectId) {
    try {
      console.log('[ProjectManager] deleting project:', projectId);
      await this.invoke('delete_project', { project_id: projectId });

      console.log('[ProjectManager] project deleted:', projectId);
      await this.loadProjects(); // Reload all projects

      // Clear current project if it was the one being deleted
      if (this.currentProject && this.currentProject.id === projectId) {
        this.currentProject = null;
        this.updateCurrentProjectDisplay();
        if (this.onProjectChange) {
          this.onProjectChange(null);
        }
      }

      this.showSuccess('项目删除成功');
      return true;
    } catch (error) {
      console.error('[ProjectManager] failed to delete project:', error);
      this.showError('删除项目失败: ' + error);
      return false;
    }
  }

  /**
   * Set current project
   */
  async setCurrentProject(projectId) {
    try {
      console.log('[ProjectManager] setting current project:', projectId);
      const project = await this.invoke('set_current_project', { project_id: projectId });

      this.currentProject = project;
      this.updateCurrentProjectDisplay();
      this.renderProjectList(); // Update list to show current selection

      if (this.onProjectChange) {
        this.onProjectChange(this.currentProject);
      }

      console.log('[ProjectManager] current project set:', project.name);
      return project;
    } catch (error) {
      console.error('[ProjectManager] failed to set current project:', error);
      this.showError('设置当前项目失败: ' + error);
      return null;
    }
  }

  /**
   * Render project list in sidebar
   */
  renderProjectList() {
    const { projectList } = this.elements;
    if (!projectList) return;

    projectList.innerHTML = '';

    this.projects.forEach(project => {
      const projectElement = this.createProjectElement(project);
      projectList.appendChild(projectElement);
    });

    this.refreshIcons(projectList);

    console.log('[ProjectManager] project list rendered with', this.projects.length, 'items');
  }

  /**
   * Create DOM element for a project
   */
  createProjectElement(project) {
    const div = document.createElement('div');
    div.className = 'project-item';
    div.dataset.projectId = project.id;

    const isCurrent = this.currentProject && this.currentProject.id === project.id;
    if (isCurrent) {
      div.classList.add('current');
    }

    // Escape HTML to prevent XSS
    const escapeHtml = (text) => {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    };

    const isEnabled = Boolean(project.enabled);
    const toggleId = `toggle-${project.id}`;
    const enabledBadge = isEnabled
      ? '<span class="project-enabled-badge enabled">已启用</span>'
      : '<span class="project-enabled-badge disabled">未启用</span>';

    div.innerHTML = `
      <div class="project-header">
        <div class="project-info">
          <div class="project-name-row">
            <div class="project-name">${escapeHtml(project.name)}</div>
            ${enabledBadge}
          </div>
          <div class="project-description">${escapeHtml(project.description)}</div>
          <div class="project-work-dir">${escapeHtml(project.work_directory)}</div>
          ${project.claude_setting_id ? `<div class="project-work-dir">Setting: ${escapeHtml(this.getClaudeSettingName(project.claude_setting_id) || project.claude_setting_id)}</div>` : ''}
        </div>
        <div class="project-toggle-wrap${isEnabled ? ' active' : ''}">
          <span class="project-toggle-label">${isEnabled ? '启用' : '禁用'}</span>
          <label class="toggle-switch" title="切换启用/禁用" for="${toggleId}">
            <input type="checkbox" id="${toggleId}"${isEnabled ? ' checked' : ''}>
            <span class="toggle-track"></span>
          </label>
        </div>
      </div>
      <div class="project-actions">
        <button class="project-run-btn" title="运行项目">
          <i data-lucide="play"></i>
        </button>
        <button class="project-edit-btn" title="编辑项目">
          <i data-lucide="edit-2"></i>
        </button>
        <button class="project-delete-btn" title="删除项目">
          <i data-lucide="trash-2"></i>
        </button>
      </div>
    `;

    // Add event listeners
    const runBtn = div.querySelector('.project-run-btn');
    const editBtn = div.querySelector('.project-edit-btn');
    const deleteBtn = div.querySelector('.project-delete-btn');
    const toggleInput = div.querySelector(`#${toggleId}`);
    const toggleWrap = div.querySelector('.project-toggle-wrap');
    const toggleLabel = div.querySelector('.project-toggle-label');

    if (toggleInput) {
      toggleInput.addEventListener('change', (e) => {
        e.stopPropagation();
        const newEnabled = e.target.checked;
        // Notify callback (main.js will persist one project's enabled state)
        if (this.onProjectToggle) {
          this.onProjectToggle(project.id, newEnabled);
        }
      });
    }

    if (runBtn) {
      runBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.handleRunProject(project);
      });
    }

    if (editBtn) {
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void this.showEditProjectModal(project);
      });
    }

    if (deleteBtn) {
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.requestDeleteProject(project);
      });
    }

    // Click on project item to select it (but not on toggle area)
    div.addEventListener('click', (e) => {
      if (!e.target.closest('.project-toggle-wrap')) {
        this.setCurrentProject(project.id);
      }
    });

    return div;
  }

  /**
   * Handle run project button
   */
  handleRunProject(project) {
    console.log('[ProjectManager] running project:', project.name);

    // Set as current project first
    this.setCurrentProject(project.id).then((selectedProject) => {
      if (!selectedProject) {
        return;
      }
      // Trigger run callback
      if (this.onProjectRun) {
        this.onProjectRun(selectedProject);
      }

      this.showSuccess(`项目 "${selectedProject.name}" 已切换到主控区`);
    });
  }

  /**
   * Update project running state
   */
  updateProjectRunningState(projectId, isRunning) {
    const projectElements = document.querySelectorAll(`[data-project-id="${projectId}"]`);
    projectElements.forEach(element => {
      const runBtn = element.querySelector('.project-run-btn');
      if (runBtn) {
        if (isRunning) {
          runBtn.innerHTML = '<i data-lucide="pause"></i>';
          runBtn.title = '停止项目';
          runBtn.classList.add('running');
        } else {
          runBtn.innerHTML = '<i data-lucide="play"></i>';
          runBtn.title = '运行项目';
          runBtn.classList.remove('running');
        }
        this.refreshIcons(runBtn);
      }
    });
  }

  /**
   * Update all projects running state
   */
  updateAllProjectsRunningState(runningProjectIds = []) {
    const normalizedIds = Array.isArray(runningProjectIds)
      ? runningProjectIds
      : (runningProjectIds ? [runningProjectIds] : []);
    const runningSet = new Set(normalizedIds);

    // Reset all projects to not running
    this.projects.forEach(project => {
      this.updateProjectRunningState(project.id, false);
    });

    // Mark all running projects
    runningSet.forEach((projectId) => this.updateProjectRunningState(projectId, true));
  }

  /**
   * Update toggle switch display for one project and sync local cache.
   */
  updateProjectEnabledState(projectId, isEnabled) {
    const normalized = Boolean(isEnabled);
    this.projects = this.projects.map((project) => (
      project.id === projectId ? { ...project, enabled: normalized } : project
    ));

    if (this.currentProject && this.currentProject.id === projectId) {
      this.currentProject = { ...this.currentProject, enabled: normalized };
    }

    const projectElements = document.querySelectorAll(`[data-project-id="${projectId}"]`);
    projectElements.forEach((element) => {
      const toggleWrap = element.querySelector('.project-toggle-wrap');
      const toggleInput = element.querySelector('input[type="checkbox"]');
      const toggleLabel = element.querySelector('.project-toggle-label');
      const enabledBadge = element.querySelector('.project-enabled-badge');
      if (toggleInput) {
        toggleInput.checked = normalized;
      }
      if (toggleLabel) {
        toggleLabel.textContent = normalized ? '启用' : '禁用';
      }
      if (enabledBadge) {
        enabledBadge.textContent = normalized ? '已启用' : '未启用';
        enabledBadge.classList.toggle('enabled', normalized);
        enabledBadge.classList.toggle('disabled', !normalized);
      }
      if (toggleWrap) {
        toggleWrap.classList.toggle('active', normalized);
      }
    });
  }

  /**
   * Show modal for new project
   */
  async showNewProjectModal() {
    const { elements } = this;

    if (elements.modalTitle) {
      elements.modalTitle.textContent = '新建项目';
    }

    if (elements.projectForm) {
      elements.projectForm.reset();
    }

    if (elements.projectNameInput) {
      elements.projectNameInput.value = '';
    }

    if (elements.projectDescriptionInput) {
      elements.projectDescriptionInput.value = '';
    }

    if (elements.projectWorkDirInput) {
      elements.projectWorkDirInput.value = '';
    }

    if (elements.projectClaudeSettingSelect) {
      elements.projectClaudeSettingSelect.value = '';
    }

    if (elements.projectOverwriteClaudeSettingsInput) {
      elements.projectOverwriteClaudeSettingsInput.checked = false;
    }
    if (elements.projectEnabledInput) {
      elements.projectEnabledInput.checked = false;
    }

    await this.loadClaudeSettings('');

    this.editingProject = null;
    this.showModal();
  }

  /**
   * Show modal for editing project
   */
  async showEditProjectModal(project) {
    const { elements } = this;

    if (elements.modalTitle) {
      elements.modalTitle.textContent = '编辑项目';
    }

    if (elements.projectNameInput) {
      elements.projectNameInput.value = project.name;
    }

    if (elements.projectDescriptionInput) {
      elements.projectDescriptionInput.value = project.description;
    }

    if (elements.projectWorkDirInput) {
      elements.projectWorkDirInput.value = project.work_directory;
    }

    await this.loadClaudeSettings(project.claude_setting_id || '');
    if (elements.projectOverwriteClaudeSettingsInput) {
      elements.projectOverwriteClaudeSettingsInput.checked = false;
    }
    if (elements.projectEnabledInput) {
      elements.projectEnabledInput.checked = Boolean(project.enabled);
    }

    this.editingProject = project;
    this.showModal();
  }

  /**
   * Handle save project (create or update)
   */
  async handleSaveProject() {
    const { elements } = this;

    const projectData = {
      name: elements.projectNameInput?.value || '',
      description: elements.projectDescriptionInput?.value || '',
      workDirectory: elements.projectWorkDirInput?.value || '',
      claudeSettingId: elements.projectClaudeSettingSelect?.value || '',
      overwriteClaudeSettings: Boolean(elements.projectOverwriteClaudeSettingsInput?.checked),
      enabled: Boolean(elements.projectEnabledInput?.checked)
    };

    // Basic validation
    if (!projectData.name.trim()) {
      this.showError('项目名称不能为空');
      return;
    }

    if (!projectData.workDirectory.trim()) {
      this.showError('工作目录不能为空');
      return;
    }

    if (projectData.overwriteClaudeSettings && !projectData.claudeSettingId) {
      this.showError('勾选覆盖 .claude 配置时必须先选择 Claude setting 文件');
      return;
    }

    try {
      if (this.editingProject) {
        await this.updateProject(this.editingProject.id, projectData);
      } else {
        projectData.claudeSettingId = projectData.claudeSettingId || null;
        await this.createProject(projectData);
      }
    } catch (error) {
      // Error is already handled in create/update methods
    }
  }

  /**
   * Update current project display
   */
  updateCurrentProjectDisplay() {
    const { currentProjectName } = this.elements;

    if (currentProjectName) {
      if (this.currentProject) {
        currentProjectName.textContent = this.currentProject.name;
        currentProjectName.classList.remove('no-project');
      } else {
        currentProjectName.textContent = '未选择项目';
        currentProjectName.classList.add('no-project');
      }
    }
  }

  /**
   * Show modal
   */
  showModal() {
    const { projectModal } = this.elements;
    if (projectModal) {
      projectModal.classList.remove('hidden');
      projectModal.classList.add('visible');

      // Focus name input
      setTimeout(() => {
        if (this.elements.projectNameInput) {
          this.elements.projectNameInput.focus();
        }
      }, 100);
    }
  }

  /**
   * Hide modal
   */
  hideModal() {
    const { projectModal } = this.elements;
    if (projectModal) {
      projectModal.classList.remove('visible');
      projectModal.classList.add('hidden');
    }
  }

  /**
   * Show delete confirmation modal.
   */
  showDeleteConfirmModal(project) {
    const { deleteConfirmModal, deleteProjectName } = this.elements;
    if (!deleteConfirmModal) {
      return;
    }

    if (deleteProjectName) {
      deleteProjectName.textContent = project?.name || '';
    }

    this.setDeleteConfirmLoading(false);
    deleteConfirmModal.classList.remove('hidden');
    deleteConfirmModal.classList.add('visible');
  }

  /**
   * Hide delete confirmation modal.
   */
  hideDeleteConfirmModal() {
    if (this.isDeletingProject) {
      return;
    }

    const { deleteConfirmModal, deleteProjectName } = this.elements;
    if (deleteConfirmModal) {
      deleteConfirmModal.classList.remove('visible');
      deleteConfirmModal.classList.add('hidden');
    }

    if (deleteProjectName) {
      deleteProjectName.textContent = '';
    }

    this.pendingDeleteProject = null;
  }

  /**
   * Update delete confirmation UI loading state.
   */
  setDeleteConfirmLoading(loading) {
    const { deleteConfirmBtn, deleteCancelBtn, deleteCloseBtn } = this.elements;
    if (deleteConfirmBtn) {
      deleteConfirmBtn.disabled = loading;
      deleteConfirmBtn.textContent = loading ? '删除中...' : '确认删除';
    }
    if (deleteCancelBtn) {
      deleteCancelBtn.disabled = loading;
    }
    if (deleteCloseBtn) {
      deleteCloseBtn.disabled = loading;
    }
  }

  /**
   * Show success message
   */
  showSuccess(message) {
    console.log('[ProjectManager] success:', message);
    // You could implement a toast notification here
    alert(message); // Simple implementation for now
  }

  /**
   * Show error message
   */
  showError(message) {
    console.error('[ProjectManager] error:', message);
    // You could implement a toast notification here
    alert(message); // Simple implementation for now
  }

  /**
   * Get current project data
   */
  getCurrentProject() {
    return this.currentProject;
  }

  /**
   * Get all projects
   */
  getProjects() {
    return this.projects;
  }

  /**
   * Initialize the project manager
   */
  async initialize() {
    console.log('[ProjectManager] initializing...');

    this.initializeElements();
    this.setupEventListeners();
    await this.loadClaudeSettings();

    await this.loadProjects();
    await this.loadCurrentProject();

    // Auto-select first project if no current project is set
    console.log('[ProjectManager] checking auto-select: currentProject =', this.currentProject, 'projects.length =', this.projects.length);
    if (!this.currentProject && this.projects.length > 0) {
      console.log('[ProjectManager] no current project, auto-selecting first project:', this.projects[0].name, 'id =', this.projects[0].id);
      await this.setCurrentProject(this.projects[0].id);
    } else {
      console.log('[ProjectManager] auto-select skipped: currentProject exists =', !!this.currentProject, 'projects.length =', this.projects.length);
    }

    this.refreshIcons();

    console.log('[ProjectManager] initialization complete, currentProject =', this.currentProject?.name || 'none');
  }
}

export default ProjectManager;
