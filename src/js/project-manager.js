/**
 * Project Manager for Ralph Loop Editor
 * Handles all project-related operations and UI management
 */

import { createIcons, Play, Pause, Edit2, Trash2 } from 'lucide';

export class ProjectManager {
  constructor(invokeFunction) {
    this.invoke = invokeFunction;
    this.projects = [];
    this.currentProject = null;
    this.globalEnabled = false; // tracks global enabled state
    this.onProjectChange = null;
    this.onProjectsUpdate = null;
    this.onProjectRun = null;
    this.onProjectToggle = null; // callback(newEnabled)
    this.pendingDeleteProject = null;
    this.isDeletingProject = false;

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
      projectSaveBtn: document.getElementById('project-save-btn'),
      projectCancelBtn: document.getElementById('project-cancel-btn'),
      modalCloseBtn: document.getElementById('modal-close-btn'),
      currentProjectName: document.getElementById('current-project-name'),
      deleteConfirmModal: document.getElementById('delete-confirm-modal'),
      deleteProjectName: document.getElementById('delete-project-name'),
      deleteConfirmBtn: document.getElementById('delete-confirm-btn'),
      deleteCancelBtn: document.getElementById('delete-cancel-btn'),
      deleteCloseBtn: document.getElementById('delete-close-btn')
    };

    console.log('[ProjectManager] DOM elements initialized');
  }

  /**
   * Setup event listeners
   */
  setupEventListeners() {
    const { elements } = this;

    // New project button
    if (elements.newProjectBtn) {
      elements.newProjectBtn.addEventListener('click', () => this.showNewProjectModal());
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

    console.log('[ProjectManager] event listeners setup complete');
  }

  /**
   * Load all projects from backend
   */
  async loadProjects() {
    try {
      console.log('[ProjectManager] loading projects...');
      this.projects = await this.invoke('get_projects');
      console.log('[ProjectManager] loaded', this.projects.length, 'projects');
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
      this.currentProject = await this.invoke('get_current_project');
      console.log('[ProjectManager] current project:', this.currentProject?.name || 'none');
      this.updateCurrentProjectDisplay();

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
  async updateProject(projectId, projectData) {
    try {
      console.log('[ProjectManager] updating project:', projectId);
      const project = await this.invoke('update_project', {
        project_id: projectId,
        name: projectData.name,
        description: projectData.description,
        work_directory: projectData.workDirectory,
        max_iterations: projectData.maxIterations || null,
        completion_promise: projectData.completionPromise || null,
      });

      console.log('[ProjectManager] project updated:', project.id);
      await this.loadProjects(); // Reload all projects

      // Update current project if it was the one being edited
      if (this.currentProject && this.currentProject.id === projectId) {
        this.currentProject = project;
        this.updateCurrentProjectDisplay();
        if (this.onProjectChange) {
          this.onProjectChange(this.currentProject);
        }
      }

      this.hideModal();
      this.showSuccess('项目更新成功');

      return project;
    } catch (error) {
      console.error('[ProjectManager] failed to update project:', error);
      this.showError('更新项目失败: ' + error);
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
    } catch (error) {
      console.error('[ProjectManager] failed to set current project:', error);
      this.showError('设置当前项目失败: ' + error);
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

    const isEnabled = this.globalEnabled;
    const toggleId = `toggle-${project.id}`;

    div.innerHTML = `
      <div class="project-header">
        <div class="project-info">
          <div class="project-name">${escapeHtml(project.name)}</div>
          <div class="project-description">${escapeHtml(project.description)}</div>
          <div class="project-work-dir">${escapeHtml(project.work_directory)}</div>
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
        // Notify callback (main.js will call set_enabled and sync all switches)
        if (this.onProjectToggle) {
          this.onProjectToggle(newEnabled);
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
        this.showEditProjectModal(project);
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
    this.setCurrentProject(project.id).then(() => {
      // Trigger run callback
      if (this.onProjectRun) {
        this.onProjectRun(project);
      }

      // The actual start will be handled by the main application
      this.showSuccess(`项目 "${project.name}" 已设置为当前项目，可以开始运行`);
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
  updateAllProjectsRunningState(runningProjectId) {
    // Reset all projects to not running
    this.projects.forEach(project => {
      this.updateProjectRunningState(project.id, false);
    });

    // Set current project as running if provided
    if (runningProjectId) {
      this.updateProjectRunningState(runningProjectId, true);
    }
  }

  /**
   * Sync all project card toggle switches to the given global enabled state
   */
  syncToggleStates(isEnabled) {
    this.globalEnabled = isEnabled;
    document.querySelectorAll('.project-toggle-wrap').forEach(wrap => {
      const input = wrap.querySelector('input[type="checkbox"]');
      const label = wrap.querySelector('.project-toggle-label');
      if (input) input.checked = isEnabled;
      if (label) label.textContent = isEnabled ? '启用' : '禁用';
      wrap.classList.toggle('active', isEnabled);
    });
  }

  /**
   * Update toggle switch display for a project (legacy - now uses syncToggleStates)
   */
  updateProjectEnabledState(projectId, isEnabled) {
    this.syncToggleStates(isEnabled);
  }

  /**
   * Show modal for new project
   */
  showNewProjectModal() {
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

    this.editingProject = null;
    this.showModal();
  }

  /**
   * Show modal for editing project
   */
  showEditProjectModal(project) {
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
      workDirectory: elements.projectWorkDirInput?.value || ''
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

    try {
      if (this.editingProject) {
        await this.updateProject(this.editingProject.id, projectData);
      } else {
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

    await this.loadProjects();
    await this.loadCurrentProject();
    this.refreshIcons();

    console.log('[ProjectManager] initialization complete');
  }
}

export default ProjectManager;
