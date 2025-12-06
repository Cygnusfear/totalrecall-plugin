/**
 * LLM client for background synthesis using Claude Haiku
 * Falls back to Claude CLI if SDK API call fails (e.g., out of credits)
 */

import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'child_process';
import type { NodeType } from './schema.js';

export interface SynthesisResult {
  node_type: NodeType;
  one_liner: string;
  summary: string;
  full_synthesis: string;
  temporal_context?: string;
  entity_name?: string;
}

export interface ConversationChunk {
  id: string;
  content: string;
  timestamp: number;
  agent_id: string | null;
}

export class LLMSynthesisClient {
  private client: Anthropic;
  private model: string;
  private cliModel: string;
  private useCliFallback: boolean;
  private cliTimeoutMs: number;

  constructor(
    apiKey: string,
    model: string = 'claude-3-5-haiku-20241022',
    options: { useCliFallback?: boolean; cliModel?: string; cliTimeoutMs?: number } = {}
  ) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
    this.useCliFallback = options.useCliFallback ?? true;
    // CLI uses different model naming - map to haiku
    this.cliModel = options.cliModel ?? 'haiku';
    // Default 5 minute timeout for CLI processes
    this.cliTimeoutMs = options.cliTimeoutMs ?? 300000;
  }

  async synthesize(
    chunks: ConversationChunk[],
    context?: {
      session_id?: string;
      task_context?: string;
      repo?: string;
    }
  ): Promise<SynthesisResult> {
    const prompt = this.buildPrompt(chunks, context);

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 2048,
        temperature: 0.3,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const responseText = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n');

      return this.parseResponse(responseText);
    } catch (error) {
      // Check if this is a recoverable API error (rate limit, credits, etc.)
      if (this.useCliFallback && this.isRecoverableApiError(error)) {
        console.error(
          `[LLMSynthesis] SDK API call failed, falling back to CLI: ${error instanceof Error ? error.message : String(error)}`
        );
        return this.synthesizeWithCli(prompt);
      }
      throw new Error(
        `LLM synthesis failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Check if an error is recoverable by falling back to CLI
   * (rate limits, credit issues, auth issues with SDK but not CLI)
   */
  private isRecoverableApiError(error: unknown): boolean {
    if (!(error instanceof Error)) return true; // Unknown errors - try CLI

    const message = error.message.toLowerCase();
    const errorName = error.name?.toLowerCase() || '';

    // Common API error patterns that CLI might handle differently
    const recoverablePatterns = [
      'rate limit',
      'rate_limit',
      'too many requests',
      '429',
      'credit',
      'billing',
      'quota',
      'insufficient',
      'overloaded',
      '529',
      '503',
      'service unavailable',
      'authentication',
      'unauthorized',
      '401',
      '403',
    ];

    return recoverablePatterns.some(
      (pattern) => message.includes(pattern) || errorName.includes(pattern)
    );
  }

  /**
   * Fallback synthesis using Claude CLI with timeout
   * Removes ANTHROPIC_API_KEY to force CLI to use subscription instead of API
   */
  private async synthesizeWithCli(prompt: string): Promise<SynthesisResult> {
    return new Promise((resolve, reject) => {
      const args = ['-p', prompt, '--model', this.cliModel, '--output-format', 'text'];

      // Remove API key to force CLI to use subscription auth
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;

      const child = spawn('claude', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });

      let stdout = '';
      let stderr = '';
      let completed = false;

      // Setup timeout to kill hung processes
      const timeout = setTimeout(() => {
        if (!completed) {
          console.error(`[LLMSynthesis] CLI timeout after ${this.cliTimeoutMs}ms, killing process`);

          // Try SIGTERM first for graceful shutdown
          child.kill('SIGTERM');

          // Force kill after 5 seconds if still running
          setTimeout(() => {
            if (!completed) {
              console.error('[LLMSynthesis] CLI did not respond to SIGTERM, sending SIGKILL');
              child.kill('SIGKILL');
            }
          }, 5000);

          reject(new Error(`CLI fallback timeout after ${this.cliTimeoutMs}ms`));
        }
      }, this.cliTimeoutMs);

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('error', (err) => {
        if (!completed) {
          completed = true;
          clearTimeout(timeout);
          reject(new Error(`CLI fallback failed to spawn: ${err.message}`));
        }
      });

      child.on('close', (code) => {
        if (!completed) {
          completed = true;
          clearTimeout(timeout);

          if (code !== 0) {
            reject(new Error(`CLI fallback exited with code ${code}: ${stderr}`));
            return;
          }

          try {
            const result = this.parseResponse(stdout);
            console.error('[LLMSynthesis] CLI fallback succeeded');
            resolve(result);
          } catch (parseError) {
            reject(
              new Error(
                `CLI fallback parse failed: ${parseError instanceof Error ? parseError.message : String(parseError)}`
              )
            );
          }
        }
      });
    });
  }

  private buildPrompt(
    chunks: ConversationChunk[],
    context?: {
      session_id?: string;
      task_context?: string;
      repo?: string;
    }
  ): string {
    const contextInfo = context
      ? `
Session ID: ${context.session_id || 'unknown'}
Task Context: ${context.task_context || 'none'}
Repository: ${context.repo || 'none'}
`
      : 'No additional context provided.';

    const conversationText = chunks
      .map((chunk, idx) => {
        const timestamp = new Date(chunk.timestamp).toISOString();
        const agent = chunk.agent_id || 'system';
        return `[${idx + 1}] (${timestamp}, ${agent}):\n${chunk.content}`;
      })
      .join('\n\n---\n\n');

    return `You are a memory synthesis agent for Total Recall, a synthesis-first memory system. Your task is to analyze conversation chunks and create structured synthesis nodes.

CONTEXT:
${contextInfo}

CONVERSATION CHUNK (${chunks.length} messages):
${conversationText}

---

SYNTHESIS INSTRUCTIONS:

Analyze this conversation chunk and create a structured synthesis that captures the key insights, decisions, learnings, or events.

1. **node_type**: Choose the most appropriate type:
   - "decision": A choice or decision was made
   - "learning": New insight, knowledge, or understanding gained
   - "entity": Discussion about a specific project, system, or component
   - "event": Something happened (deploy, bug, incident)
   - "task": Work item or task discussed/created
   - "summary": General session summary (use when no specific type fits)

2. **one_liner**: Create a ~50 token summary that captures the essence. Make it scannable and specific.

3. **summary**: Write a ~200 token detailed summary with key points, context, and rationale.

4. **full_synthesis**: Write a complete synthesis (300-500 tokens) that includes:
   - Full context and background
   - Detailed rationale and reasoning
   - Implications and follow-up considerations
   - Any important caveats or edge cases

5. **temporal_context**: (Optional) When did this occur?

6. **entity_name**: (Optional) If this is about a specific entity, provide its normalized name

IMPORTANT:
- Be specific and concrete, not vague
- Focus on WHY and implications, not just WHAT
- Capture technical details when relevant

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "node_type": "decision" | "learning" | "entity" | "event" | "task" | "summary",
  "one_liner": "string",
  "summary": "string",
  "full_synthesis": "string",
  "temporal_context": "string or null",
  "entity_name": "string or null"
}`;
  }

  private parseResponse(responseText: string): SynthesisResult {
    let cleaned = responseText.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    try {
      const parsed = JSON.parse(cleaned);

      if (!parsed.node_type || !parsed.one_liner || !parsed.summary || !parsed.full_synthesis) {
        throw new Error('Missing required fields in synthesis response');
      }

      const validTypes: NodeType[] = ['decision', 'learning', 'entity', 'event', 'task', 'summary'];
      if (!validTypes.includes(parsed.node_type)) {
        throw new Error(`Invalid node_type: ${parsed.node_type}`);
      }

      return {
        node_type: parsed.node_type,
        one_liner: parsed.one_liner,
        summary: parsed.summary,
        full_synthesis: parsed.full_synthesis,
        temporal_context: parsed.temporal_context || undefined,
        entity_name: parsed.entity_name || undefined,
      };
    } catch (error) {
      throw new Error(
        `Failed to parse synthesis response: ${error instanceof Error ? error.message : String(error)}\n\nResponse: ${responseText}`
      );
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.client.messages.create({
        model: this.model,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Test' }],
      });
      return true;
    } catch (error) {
      console.error('LLM synthesis client test failed:', error);
      return false;
    }
  }
}
