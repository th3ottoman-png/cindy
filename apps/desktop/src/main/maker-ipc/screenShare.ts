import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IpcMain } from 'electron';
import {
  redactSensitiveText,
  findRedactionSpans,
  getScreenShareRedactionCss,
  type RedactionOptions,
  type RedactionSpan,
} from '@cindy/maker-core/screen-redaction';
import { MAKER_INVOKE, MAKER_PUSH } from './channels';

export interface ScreenShareConfig {
  enabled: boolean;
  maskStyle: 'badge' | 'bullets' | 'redacted';
}

const DEFAULT_CONFIG: ScreenShareConfig = {
  enabled: false,
  maskStyle: 'badge',
};

export interface ScreenShareHostDeps {
  getHarnessDir?: () => string;
  pushEvent?: (channel: string, payload: unknown) => void;
}

export class ScreenShareHost {
  private harnessDir: string;
  private pushEventFn?: (channel: string, payload: unknown) => void;
  private inMemoryConfig: ScreenShareConfig | null = null;

  constructor(deps: ScreenShareHostDeps = {}) {
    this.harnessDir = deps.getHarnessDir ? deps.getHarnessDir() : path.join(os.homedir(), '.cindy-harness');
    this.pushEventFn = deps.pushEvent;
  }

  private getConfigFilePath(): string {
    return path.join(this.harnessDir, 'screen-share.json');
  }

  getConfig(): ScreenShareConfig {
    if (this.inMemoryConfig) {
      return { ...this.inMemoryConfig };
    }

    const filePath = this.getConfigFilePath();
    if (!fs.existsSync(filePath)) {
      this.inMemoryConfig = { ...DEFAULT_CONFIG };
      return { ...this.inMemoryConfig };
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.inMemoryConfig = {
        enabled: Boolean(parsed.enabled),
        maskStyle: parsed.maskStyle === 'bullets' || parsed.maskStyle === 'redacted' ? parsed.maskStyle : 'badge',
      };
      return { ...this.inMemoryConfig };
    } catch {
      this.inMemoryConfig = { ...DEFAULT_CONFIG };
      return { ...this.inMemoryConfig };
    }
  }

  setConfig(patch: Partial<ScreenShareConfig>): ScreenShareConfig {
    const current = this.getConfig();
    const updated: ScreenShareConfig = {
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
      maskStyle:
        patch.maskStyle === 'bullets' || patch.maskStyle === 'redacted' || patch.maskStyle === 'badge'
          ? patch.maskStyle
          : current.maskStyle,
    };

    this.inMemoryConfig = updated;

    // Persist atomically to harness directory
    try {
      if (!fs.existsSync(this.harnessDir)) {
        fs.mkdirSync(this.harnessDir, { recursive: true });
      }
      const filePath = this.getConfigFilePath();
      const tmpPath = `${filePath}.tmp-${Date.now()}`;
      fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2), 'utf8');
      fs.renameSync(tmpPath, filePath);
    } catch {
      // In-memory fallback if disk fails
    }

    // Push event to renderer
    this.pushEventFn?.(MAKER_PUSH.SCREEN_SHARE_CHANGED, updated);

    return { ...updated };
  }

  redact(text: string, options?: RedactionOptions): string {
    return redactSensitiveText(text, options);
  }

  findSpans(text: string): RedactionSpan[] {
    return findRedactionSpans(text);
  }

  getCss(): string {
    return getScreenShareRedactionCss();
  }
}

let singletonHost: ScreenShareHost | null = null;

export function getScreenShareHost(deps?: ScreenShareHostDeps): ScreenShareHost {
  if (!singletonHost || deps) {
    singletonHost = new ScreenShareHost(deps);
  }
  return singletonHost;
}

export function registerScreenShareHandlers(
  ipc: IpcMain,
  getHost: () => ScreenShareHost,
  pushEvent?: (channel: string, payload: unknown) => void,
  assertSenderTrusted?: (event: { senderFrame?: unknown }) => void,
): void {
  ipc.handle(MAKER_INVOKE.SCREEN_SHARE_GET_CONFIG, async (event) => {
    assertSenderTrusted?.(event);
    const host = getHost();
    return host.getConfig();
  });

  ipc.handle(
    MAKER_INVOKE.SCREEN_SHARE_SET_CONFIG,
    async (event, patch: Partial<ScreenShareConfig>) => {
      assertSenderTrusted?.(event);
      const host = getHost();
      const updated = host.setConfig(patch);
      pushEvent?.(MAKER_PUSH.SCREEN_SHARE_CHANGED, updated);
      return updated;
    },
  );
}
