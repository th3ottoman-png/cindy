import type { IpcMain } from 'electron';
import {
  structureBrainDumpPrompt,
  type StructuredPromptResult,
} from '@cindy/maker-core/prompt-structurer';
import { MAKER_INVOKE } from './channels';

export interface PromptStructurerHostDeps {
  refineWithModel?: (text: string) => Promise<string | null>;
}

export class PromptStructurerHost {
  private refineWithModelFn?: (text: string) => Promise<string | null>;

  constructor(deps: PromptStructurerHostDeps = {}) {
    this.refineWithModelFn = deps.refineWithModel;
  }

  async refinePrompt(rawText: string): Promise<StructuredPromptResult> {
    // Attempt local routed model if provided
    if (this.refineWithModelFn) {
      try {
        const modelOutput = await this.refineWithModelFn(rawText);
        if (modelOutput && modelOutput.trim()) {
          const structured = structureBrainDumpPrompt(modelOutput);
          if (structured.structuredMarkdown) {
            return structured;
          }
        }
      } catch {
        // Fall back to deterministic structurer per AGENTS.md §6
      }
    }

    return structureBrainDumpPrompt(rawText);
  }
}

let singletonHost: PromptStructurerHost | null = null;

export function getPromptStructurerHost(deps?: PromptStructurerHostDeps): PromptStructurerHost {
  if (!singletonHost || deps) {
    singletonHost = new PromptStructurerHost(deps);
  }
  return singletonHost;
}

export function registerPromptStructurerHandlers(
  ipc: IpcMain,
  getHost: () => PromptStructurerHost,
  assertSenderTrusted?: (event: { senderFrame?: unknown }) => void,
): void {
  ipc.handle(
    MAKER_INVOKE.PROMPT_STRUCTURER_REFINE,
    async (event, params: { text: string }) => {
      assertSenderTrusted?.(event);
      const host = getHost();
      return host.refinePrompt(params?.text || '');
    },
  );
}
