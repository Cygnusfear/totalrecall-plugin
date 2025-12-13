/**
 * CLI: queue-synthesis
 * Called by Stop hook to queue current session content for background synthesis
 */

import { getDatabase } from '../db.js';
import { randomUUID } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { readHookInput } from './hook-utils.js';

interface JsonlEntry {
  type: string;
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string }>;
  };
  timestamp?: string;
}

function parseJsonl(content: string): JsonlEntry[] {
  return content
    .trim()
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry): entry is JsonlEntry => entry !== null);
}

function extractText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content;
  return content
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text!)
    .join('\n');
}

async function main() {
  const db = getDatabase();

  // Read hook input from stdin (Claude Code delivers data this way)
  const input = await readHookInput();
  if (!input || !input.transcript_path) {
    console.log('No hook input or transcript_path');
    db.close();
    return;
  }

  const transcriptPath = input.transcript_path;
  if (!existsSync(transcriptPath)) {
    console.log('Transcript file does not exist:', transcriptPath);
    db.close();
    return;
  }

  const sessionId = input.session_id || transcriptPath.split('/').pop()?.replace('.jsonl', '') || `session-${Date.now()}`;

  // Read and parse transcript
  const content = readFileSync(transcriptPath, 'utf-8');
  const entries = parseJsonl(content);

  if (entries.length === 0) {
    console.log('No entries in transcript');
    db.close();
    return;
  }

  // Create raw content entries
  const rawContentIds: string[] = [];
  const now = Date.now();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type === 'message' && entry.message) {
      const id = randomUUID();
      const contentText = extractText(entry.message.content);

      db.createRawContent({
        id,
        session_id: sessionId,
        synthesis_node_id: null,
        content_type: 'message',
        content: `[${entry.message.role}]: ${contentText}`,
        agent_id: null,
        timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : now,
        message_index: i,
      });

      rawContentIds.push(id);
    }
  }

  if (rawContentIds.length === 0) {
    console.log('No messages to queue');
    db.close();
    return;
  }

  // Create queue item for background synthesis
  const queueItem = db.createSynthesisQueueItem({
    session_id: sessionId,
    agent_id: null,
    chunk_type: 'session_chunk',
    raw_content_ids: JSON.stringify(rawContentIds),
    context: null,
    message_count: rawContentIds.length,
    status: 'pending',
    retry_count: 0,
    error: null,
    synthesis_node_id: null,
    created_at: now,
  });

  console.log(`Queued ${rawContentIds.length} messages for synthesis (queue item ${queueItem.id})`);
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
