/**
 * Topic Inference Service
 *
 * Extracts search topics from user prompts using Claude Haiku for improved
 * retrieval precision. Part of the Active Retrieval pipeline (Epic 3).
 *
 * Key insight from MIRIX: topic inference before search significantly improves
 * retrieval precision for conversational queries.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'crypto';

export interface TopicInferenceResult {
  topics: string[];
  confidence: number;
  reasoning: string;
  inferredIntent: 'recall' | 'search' | 'context' | 'unknown';
  latencyMs: number;
}

export interface TopicInferenceOptions {
  maxTopics?: number;
  includeOriginalQuery?: boolean;
  contextHint?: string;
  cacheTtlMs?: number;
}

interface CacheEntry {
  result: TopicInferenceResult;
  expiresAt: number;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_TOPICS = 4;

export class TopicInferenceService {
  private client: Anthropic;
  private model: string;
  private cache: Map<string, CacheEntry>;
  private enabled: boolean;

  constructor(
    apiKey: string,
    options: {
      model?: string;
      enabled?: boolean;
    } = {}
  ) {
    this.client = new Anthropic({ apiKey });
    this.model = options.model ?? 'claude-3-5-haiku-20241022';
    this.cache = new Map();
    this.enabled = options.enabled ?? (process.env.TOPIC_INFERENCE_ENABLED !== 'false');
  }

  /**
   * Infer search topics from a user prompt
   */
  async inferTopics(
    userPrompt: string,
    options: TopicInferenceOptions = {}
  ): Promise<TopicInferenceResult> {
    const startTime = Date.now();

    // If disabled, return original prompt as single topic
    if (!this.enabled) {
      return {
        topics: [userPrompt],
        confidence: 0.5,
        reasoning: 'Topic inference disabled',
        inferredIntent: 'unknown',
        latencyMs: Date.now() - startTime,
      };
    }

    const maxTopics = options.maxTopics ?? DEFAULT_MAX_TOPICS;
    const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

    // Check cache
    const cacheKey = this.getCacheKey(userPrompt, options.contextHint);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return {
        ...cached.result,
        latencyMs: Date.now() - startTime,
      };
    }

    try {
      const prompt = this.buildPrompt(userPrompt, maxTopics, options.contextHint);

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 512,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt }],
      });

      const responseText = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n');

      const result = this.parseResponse(responseText, userPrompt, options.includeOriginalQuery);
      result.latencyMs = Date.now() - startTime;

      // Cache the result
      this.cache.set(cacheKey, {
        result,
        expiresAt: Date.now() + cacheTtlMs,
      });

      // Cleanup expired entries periodically
      if (this.cache.size > 100) {
        this.cleanupCache();
      }

      return result;
    } catch (error) {
      // Fallback: return original prompt as single topic
      console.error(
        `[TopicInference] Failed, falling back to direct query: ${
          error instanceof Error ? error.message : String(error)
        }`
      );

      return {
        topics: [userPrompt],
        confidence: 0.5,
        reasoning: `Inference failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        inferredIntent: 'unknown',
        latencyMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Batch infer topics for multiple prompts (for testing/benchmarking)
   */
  async inferTopicsBatch(
    prompts: string[],
    options: TopicInferenceOptions = {}
  ): Promise<TopicInferenceResult[]> {
    // Process sequentially to avoid rate limits
    const results: TopicInferenceResult[] = [];
    for (const prompt of prompts) {
      results.push(await this.inferTopics(prompt, options));
    }
    return results;
  }

  /**
   * Clear the inference cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Set whether topic inference is enabled
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  private getCacheKey(prompt: string, contextHint?: string): string {
    const normalized = prompt.toLowerCase().trim();
    const input = contextHint ? `${normalized}|${contextHint}` : normalized;
    return createHash('sha256').update(input).digest('hex').slice(0, 16);
  }

  private cleanupCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt < now) {
        this.cache.delete(key);
      }
    }
  }

  private buildPrompt(
    userPrompt: string,
    maxTopics: number,
    contextHint?: string
  ): string {
    const contextSection = contextHint
      ? `\nCONTEXT HINT: ${contextHint}\n`
      : '';

    return `You are a search topic extraction agent for a code conversation memory system.

Your task is to extract 2-${maxTopics} focused search topics from a user's message to improve memory retrieval.
${contextSection}
USER MESSAGE:
"${userPrompt}"

---

INSTRUCTIONS:

1. Extract 2-${maxTopics} search topics that capture what the user is trying to recall or find.
2. Focus on:
   - Specific entities (projects, files, tools, people)
   - Technical concepts or decisions
   - Events or milestones
   - Actions or learnings
3. Transform conversational references into searchable terms:
   - "that auth thing" → "authentication", "auth implementation"
   - "what we decided about" → focus on the decision topic
   - "the bug from last week" → "bug", "error", relevant context
4. Determine the user's intent:
   - "recall": Trying to remember something specific
   - "search": Looking for general information
   - "context": Needs background understanding
   - "unknown": Unclear intent

IMPORTANT:
- Be specific, not generic
- Include the main subject even if phrased indirectly
- Don't include stop words or overly broad terms
- If the query is already specific, extract its key concepts

Return ONLY valid JSON:
{
  "topics": ["topic1", "topic2"],
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation of extracted topics",
  "intent": "recall" | "search" | "context" | "unknown"
}`;
  }

  private parseResponse(
    responseText: string,
    originalPrompt: string,
    includeOriginal?: boolean
  ): TopicInferenceResult {
    let cleaned = responseText.trim();

    // Remove markdown code blocks if present
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    // Try to find JSON object in response
    const jsonMatch = cleaned.match(/\{[\s\S]*"topics"[\s\S]*\}/);
    if (jsonMatch) {
      cleaned = jsonMatch[0];
    }

    try {
      const parsed = JSON.parse(cleaned);

      if (!Array.isArray(parsed.topics) || parsed.topics.length === 0) {
        throw new Error('No topics extracted');
      }

      let topics = parsed.topics.filter(
        (t: unknown): t is string => typeof t === 'string' && t.trim().length > 0
      );

      // Optionally include original prompt
      if (includeOriginal && !topics.includes(originalPrompt)) {
        topics = [originalPrompt, ...topics].slice(0, DEFAULT_MAX_TOPICS + 1);
      }

      const validIntents = ['recall', 'search', 'context', 'unknown'];
      const intent = validIntents.includes(parsed.intent) ? parsed.intent : 'unknown';

      return {
        topics,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.7,
        reasoning: parsed.reasoning || 'No reasoning provided',
        inferredIntent: intent as TopicInferenceResult['inferredIntent'],
        latencyMs: 0, // Will be set by caller
      };
    } catch (error) {
      throw new Error(
        `Failed to parse topic inference response: ${
          error instanceof Error ? error.message : String(error)
        }\n\nResponse: ${responseText}`
      );
    }
  }
}

/**
 * Create a TopicInferenceService instance with default configuration
 */
export function createTopicInferenceService(): TopicInferenceService | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[TopicInference] No ANTHROPIC_API_KEY found, service disabled');
    return null;
  }

  return new TopicInferenceService(apiKey, {
    enabled: process.env.TOPIC_INFERENCE_ENABLED !== 'false',
  });
}
