#!/usr/bin/env npx tsx
/**
 * Ingest journalctl logs into Total Recall
 *
 * Usage:
 *   # On bhakti, pipe journalctl to this script:
 *   sudo journalctl -u ramdock-coordinator --since "10:30" --until "14:40" | npx tsx scripts/ingest-journalctl.ts
 *
 *   # Or from local with SSH:
 *   ssh ramram@bhakti 'sudo journalctl -u ramdock-coordinator --since "10:30" --until "14:40"' | npx tsx scripts/ingest-journalctl.ts --remote
 */

import Database from 'better-sqlite3';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';

const DB_PATH = process.env.TOTALRECALL_DB_PATH || join(homedir(), '.config/totalrecall/synthesis.sqlite');
const SESSION_ID = `journalctl-recovery-${Date.now()}`;

interface RawContent {
  id: string;
  session_id: string;
  content_type: 'message' | 'conversation';
  content: string;
  timestamp: number;
  created_at: number;
}

async function main() {
  const isRemote = process.argv.includes('--remote');
  const dbPath = isRemote ? '/tmp/totalrecall-sync/remote-fresh.sqlite' : DB_PATH;

  console.log(`Ingesting into: ${dbPath}`);
  console.log(`Session ID: ${SESSION_ID}`);

  const db = new Database(dbPath);

  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  const rawContents: RawContent[] = [];
  let currentChunk: string[] = [];
  let chunkTimestamp: number | null = null;
  let lineCount = 0;
  let claudeOutputCount = 0;

  // Parse journalctl lines
  for await (const line of rl) {
    lineCount++;

    // Extract timestamp from journalctl format: "Dec 04 12:48:05 bhakti node[304281]: [Claude stdout]: ..."
    const timestampMatch = line.match(/^(\w+ \d+ \d+:\d+:\d+)/);
    const claudeMatch = line.match(/\[Claude stdout\]: (.*)$/);

    if (claudeMatch) {
      claudeOutputCount++;
      const content = claudeMatch[1];

      // Parse timestamp
      if (timestampMatch) {
        const dateStr = `2025 ${timestampMatch[1]}`;
        const ts = new Date(dateStr).getTime();

        // If we have a chunk and this is a new timestamp, save the chunk
        if (currentChunk.length > 0 && chunkTimestamp && ts - chunkTimestamp > 60000) {
          // More than 1 minute gap, save as separate entry
          rawContents.push({
            id: randomUUID(),
            session_id: SESSION_ID,
            content_type: 'message',
            content: currentChunk.join('\n'),
            timestamp: chunkTimestamp,
            created_at: Date.now(),
          });
          currentChunk = [];
        }

        chunkTimestamp = ts;
      }

      if (content.trim()) {
        currentChunk.push(content);
      }
    }
  }

  // Save final chunk
  if (currentChunk.length > 0 && chunkTimestamp) {
    rawContents.push({
      id: randomUUID(),
      session_id: SESSION_ID,
      content_type: 'message',
      content: currentChunk.join('\n'),
      timestamp: chunkTimestamp,
      created_at: Date.now(),
    });
  }

  console.log(`\nParsed ${lineCount} lines, found ${claudeOutputCount} Claude outputs`);
  console.log(`Created ${rawContents.length} raw content entries`);

  if (rawContents.length === 0) {
    console.log('No content to ingest');
    db.close();
    return;
  }

  // Insert raw content
  const insertRaw = db.prepare(`
    INSERT INTO raw_content (id, session_id, content_type, content, timestamp, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((contents: RawContent[]) => {
    for (const c of contents) {
      insertRaw.run(c.id, c.session_id, c.content_type, c.content, c.timestamp, c.created_at);
    }
  });

  insertMany(rawContents);
  console.log(`Inserted ${rawContents.length} raw content entries`);

  // Queue for synthesis - batch into chunks of ~10 messages
  const CHUNK_SIZE = 10;
  const insertQueue = db.prepare(`
    INSERT INTO synthesis_queue (session_id, chunk_type, raw_content_ids, context, message_count, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `);

  let queued = 0;
  for (let i = 0; i < rawContents.length; i += CHUNK_SIZE) {
    const chunk = rawContents.slice(i, i + CHUNK_SIZE);
    const ids = JSON.stringify(chunk.map(c => c.id));

    insertQueue.run(
      SESSION_ID,
      'session_chunk',
      ids,
      'Recovered from journalctl logs - coordinator session data',
      chunk.length,
      Date.now()
    );
    queued++;
  }

  console.log(`Queued ${queued} synthesis jobs`);

  // Show preview
  console.log('\n--- Preview of first 3 entries ---');
  for (const entry of rawContents.slice(0, 3)) {
    console.log(`\n[${new Date(entry.timestamp).toISOString()}]`);
    console.log(entry.content.substring(0, 200) + (entry.content.length > 200 ? '...' : ''));
  }

  db.close();
  console.log('\nDone! SynthesisWorker will process the queue.');
}

main().catch((e) => {
  console.error('Error:', e);
  process.exit(1);
});
