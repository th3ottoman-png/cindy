import { getScreenShareRedactionCss } from '@cindy/maker-core/screen-redaction';

export interface ScreenShareState {
  enabled: boolean;
  maskStyle: 'badge' | 'bullets' | 'redacted';
}

type Listener = (state: ScreenShareState) => void;

class ScreenShareStore {
  private state: ScreenShareState = {
    enabled: false,
    maskStyle: 'badge',
  };
  private listeners: Set<Listener> = new Set();
  private styleInjected = false;
  private initialized = false;

  constructor() {
    this.ensureStyleInjected();
  }

  private ensureStyleInjected(): void {
    if (this.styleInjected || typeof document === 'undefined') return;
    try {
      const styleEl = document.createElement('style');
      styleEl.id = 'screen-share-privacy-styles';
      styleEl.textContent = getScreenShareRedactionCss();
      document.head.appendChild(styleEl);
      this.styleInjected = true;
    } catch {
      // In non-browser / test environments
    }
  }

  private applyBodyClass(enabled: boolean): void {
    if (typeof document === 'undefined' || !document.body) return;
    if (enabled) {
      document.body.classList.add('screen-share-privacy-active');
    } else {
      document.body.classList.remove('screen-share-privacy-active');
    }
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    if (typeof window !== 'undefined' && window.electronAPI?.maker?.screenShare) {
      try {
        const config = await window.electronAPI.maker.screenShare.getConfig();
        if (config) {
          this.state = {
            enabled: Boolean(config.enabled),
            maskStyle: config.maskStyle || 'badge',
          };
          this.applyBodyClass(this.state.enabled);
          this.notify();
        }
      } catch {
        // Fallback to initial state
      }

      window.electronAPI.maker.screenShare.onChanged((updated) => {
        if (updated) {
          this.state = {
            enabled: Boolean(updated.enabled),
            maskStyle: updated.maskStyle || 'badge',
          };
          this.applyBodyClass(this.state.enabled);
          this.notify();
        }
      });
    }
  }

  getState(): ScreenShareState {
    return { ...this.state };
  }

  async setEnabled(enabled: boolean): Promise<ScreenShareState> {
    this.state = {
      ...this.state,
      enabled,
    };
    this.applyBodyClass(enabled);
    this.notify();

    if (typeof window !== 'undefined' && window.electronAPI?.maker?.screenShare) {
      try {
        const res = await window.electronAPI.maker.screenShare.setConfig({ enabled });
        if (res) {
          this.state = {
            enabled: Boolean(res.enabled),
            maskStyle: res.maskStyle || 'badge',
          };
          this.applyBodyClass(this.state.enabled);
          this.notify();
        }
      } catch {
        // Local state preserved
      }
    }

    return { ...this.state };
  }

  async toggle(): Promise<ScreenShareState> {
    return this.setEnabled(!this.state.enabled);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const s = this.getState();
    for (const fn of this.listeners) {
      try {
        fn(s);
      } catch {}
    }
  }
}

export const screenShareStore = new ScreenShareStore();
