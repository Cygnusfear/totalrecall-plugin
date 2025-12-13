/**
 * Shared utilities for Claude Code hooks
 */

export interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  permission_mode?: string;
  prompt?: string;           // UserPromptSubmit only
  stop_hook_active?: boolean; // Stop only
  reason?: string;           // SessionEnd only
}

/**
 * Read hook input from stdin (Claude Code delivers all hook data this way)
 */
export async function readHookInput(): Promise<HookInput | null> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const stdinData = Buffer.concat(chunks).toString('utf-8').trim();
    if (!stdinData) {
      return null;
    }
    return JSON.parse(stdinData);
  } catch (error) {
    console.error('[hook-utils] Failed to read hook input:', error);
    return null;
  }
}
