/**
 * Professional Terminal Component using xterm.js
 * Provides advanced terminal rendering with proper ANSI support
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

export class TerminalComponent {
  constructor(containerElement, options = {}) {
    this.container = containerElement;
    this.onTerminalResize = null; // Callback for terminal size changes
    this.options = {
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      cursorBlink: true,
      scrollback: 5000,
      convertEol: false,
      theme: {
        background: '#0f172a',
        foreground: '#e2e8f0',
        cursor: '#e2e8f0',
        black: '#1e293b',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#eab308',
        blue: '#3b82f6',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#cbd5e1',
        brightBlack: '#475569',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#facc15',
        brightBlue: '#60a5fa',
        brightMagenta: '#c084fc',
        brightCyan: '#22d3ee',
        brightWhite: '#f1f5f9'
      },
      ...options
    };
    
    this.terminal = null;
    this.fitAddon = null;
    this.webLinksAddon = null;
    this.initialized = false;
  }

  /**
   * Initialize the terminal instance
   */
  async init() {
    try {
      this.terminal = new Terminal(this.options);
      
      // Load addons
      this.fitAddon = new FitAddon();
      this.webLinksAddon = new WebLinksAddon();
      
      this.terminal.loadAddon(this.fitAddon);
      this.terminal.loadAddon(this.webLinksAddon);
      
      // Open terminal in container
      this.terminal.open(this.container);
      
      // Fit terminal to container
      this.fitAddon.fit();
      
      // Setup resize handling
      this.setupResizeHandling();
      
      this.initialized = true;
      console.log('Terminal initialized successfully');
      
      return this.terminal;
    } catch (error) {
      console.error('Failed to initialize terminal:', error);
      throw error;
    }
  }

  /**
   * Setup window resize handling with debouncing for better performance
   */
  setupResizeHandling() {
    let resizeTimeout = null;
    
    // Debounced resize handler to prevent excessive calls
    const debouncedResize = () => {
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      resizeTimeout = setTimeout(() => {
        if (this.fitAddon && this.initialized) {
          // Force a layout recalculation before fitting
          this.container.style.display = 'none';
          this.container.offsetHeight; // Trigger reflow
          this.container.style.display = '';
          
          this.fitAddon.fit();
          
          // Notify backend of terminal size change for PTY adjustment
          const cols = this.getCols();
          const rows = this.getRows();
          if (cols > 0 && rows > 0) {
            this.onTerminalResize?.(cols, rows);
          }
        }
      }, 100);
    };
    
    // Observe container size changes
    const resizeObserver = new ResizeObserver(debouncedResize);
    resizeObserver.observe(this.container);
    
    // Handle window resize
    window.addEventListener('resize', debouncedResize);
    
    // Handle tab switching (when terminal becomes visible)
    const handleVisibilityChange = () => {
      if (!this.container.hidden && this.fitAddon && this.initialized) {
        setTimeout(debouncedResize, 50);
      }
    };
    
    // Observe visibility changes
    const visibilityObserver = new MutationObserver(handleVisibilityChange);
    visibilityObserver.observe(this.container, {
      attributes: true,
      attributeFilter: ['hidden']
    });
    
    // Initial fit after a short delay
    setTimeout(debouncedResize, 100);
  }

  /**
   * Write data to terminal
   * @param {string} data - Data to write
   */
  write(data) {
    if (this.terminal && this.initialized) {
      this.terminal.write(data);
    }
  }

  /**
   * Write data to terminal with newline
   * @param {string} data - Data to write
   */
  writeln(data) {
    if (this.terminal && this.initialized) {
      this.terminal.writeln(data);
    }
  }

  /**
   * Clear terminal
   */
  clear() {
    if (this.terminal && this.initialized) {
      this.terminal.clear();
    }
  }

  /**
   * Get terminal rows
   * @returns {number}
   */
  getRows() {
    return this.terminal ? this.terminal.rows : 0;
  }

  /**
   * Get terminal columns
   * @returns {number}
   */
  getCols() {
    return this.terminal ? this.terminal.cols : 0;
  }

  /**
   * Focus terminal
   */
  focus() {
    if (this.terminal && this.initialized) {
      this.terminal.focus();
    }
  }

  /**
   * Setup input handling
   * @param {Function} onInput - Callback for input data
   */
  setupInput(onInput) {
    if (this.terminal && this.initialized) {
      this.terminal.onData(onInput);
    }
  }

  /**
   * Setup key event handling
   * @param {Function} onKey - Callback for key events
   */
  setupKeyEvents(onKey) {
    if (this.terminal && this.initialized) {
      this.terminal.onKey(onKey);
    }
  }

  /**
   * Resize terminal to specific dimensions
   * @param {number} cols - Number of columns
   * @param {number} rows - Number of rows
   */
  resize(cols, rows) {
    if (this.terminal && this.initialized) {
      this.terminal.resize(cols, rows);
    }
  }

  /**
   * Destroy terminal and cleanup
   */
  destroy() {
    if (this.terminal) {
      this.terminal.dispose();
      this.terminal = null;
      this.fitAddon = null;
      this.webLinksAddon = null;
      this.initialized = false;
    }
  }

  /**
   * Check if terminal is initialized
   * @returns {boolean}
   */
  isInitialized() {
    return this.initialized;
  }

  /**
   * Set callback for terminal resize events
   * @param {Function} callback - Function called with (cols, rows)
   */
  setResizeCallback(callback) {
    this.onTerminalResize = callback;
  }

  /**
   * Get terminal instance
   * @returns {Terminal|null}
   */
  getTerminal() {
    return this.terminal;
  }

  /**
   * Force terminal to fit current container size
   */
  forceFit() {
    if (this.fitAddon && this.initialized) {
      this.fitAddon.fit();
    }
  }
}

export default TerminalComponent;
