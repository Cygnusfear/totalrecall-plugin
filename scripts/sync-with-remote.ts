#!/usr/bin/env bun
/**
 * Bidirectional sync: Local <-> Remote Total Recall databases
 *
 * Usage:
 *   bun scripts/sync-with-remote.ts [user@host]
 *   bun scripts/sync-with-remote.ts ramram@168.119.4.15
 *   bun scripts/sync-with-remote.ts --dry-run ramram@168.119.4.15
 *
 * What it does:
 *   1. Checkpoints remote WAL for safe copy
 *   2. SCPs remote DB locally
 *   3. Merges both directions (last-write-wins on conflicts)
 *   4. SCPs merged DB back to remote
 *   5. Optionally regenerates embeddings for new nodes
 */

import { Database } from 'bun:sqlite';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, copyFileSync } from 'fs';
import path from 'path';
import os from 'os';

const LOCAL_DB_PATH = path.join(os.homedir(), '.config/totalrecall/synthesis.sqlite');
const REMOTE_DB_RELATIVE = '.config/totalrecall/synthesis.sqlite';
const TMP_DIR = '/tmp/totalrecall-sync';

interface SyncStats {
  localToRemote: number;
  remoteToLocal: number;
  conflicts: number;
  skipped: number;
}

function ensureTmpDir() {
  if (!existsSync(TMP_DIR)) {
    mkdirSync(TMP_DIR, { recursive: true });
  }
}

function backupLocal() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${LOCAL_DB_PATH}.backup-${timestamp}`;
  copyFileSync(LOCAL_DB_PATH, backupPath);
  console.log(`  Backed up local DB to ${backupPath}`);
  return backupPath;
}

function checkpointRemoteWal(remote: string) {
  console.log('Checkpointing remote WAL...');
  try {
    execSync(
      `ssh ${remote} 'sqlite3 ~/${REMOTE_DB_RELATIVE} "PRAGMA wal_checkpoint(TRUNCATE)"'`,
      { stdio: 'pipe' }
    );
    console.log('  Remote WAL checkpointed');
  } catch (e) {
    console.log('  Warning: Could not checkpoint remote WAL (sqlite3 may not be installed)');
    console.log('  Continuing anyway - WAL mode should handle concurrent reads safely');
  }
}

function pullRemoteDb(remote: string): string {
  const remotePath = `${remote}:~/${REMOTE_DB_RELATIVE}`;
  const localCopy = path.join(TMP_DIR, 'remote-synthesis.sqlite');

  console.log(`Pulling remote DB from ${remotePath}...`);
  execSync(`scp ${remotePath} ${localCopy}`, { stdio: 'pipe' });
  console.log(`  Downloaded to ${localCopy}`);

  return localCopy;
}

function pushRemoteDb(remote: string, localPath: string) {
  const remotePath = `${remote}:~/${REMOTE_DB_RELATIVE}`;

  console.log(`Pushing merged DB to ${remotePath}...`);
  execSync(`scp ${localPath} ${remotePath}`, { stdio: 'pipe' });
  console.log('  Upload complete');
}

function getLastSyncTime(db: Database): number {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_metadata (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);
    const row = db.prepare("SELECT value FROM sync_metadata WHERE key = 'last_sync'").get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : 0;
  } catch {
    return 0;
  }
}

function setLastSyncTime(db: Database, timestamp: number) {
  db.prepare("INSERT OR REPLACE INTO sync_metadata (key, value) VALUES ('last_sync', ?)").run(timestamp.toString());
}

function mergeNodes(
  sourceDb: Database,
  targetDb: Database,
  lastSync: number,
  direction: string
): { merged: number; conflicts: number } {
  // Get nodes changed since last sync
  const changedNodes = sourceDb.prepare(`
    SELECT id, node_type, one_liner, summary, full_synthesis,
           entity_name, entity_aliases, temporal_context,
           first_seen, last_updated, status, assigned_agent, priority,
           source_session_id, source_agent_id, source_repo,
           access_count, last_accessed, created_at, updated_at
    FROM synthesis_nodes
    WHERE created_at > ? OR updated_at > ?
  `).all(lastSync, lastSync) as any[];

  if (changedNodes.length === 0) {
    return { merged: 0, conflicts: 0 };
  }

  // Insert with conflict resolution (last-write-wins)
  const insertStmt = targetDb.prepare(`
    INSERT INTO synthesis_nodes (
      id, node_type, one_liner, summary, full_synthesis,
      entity_name, entity_aliases, temporal_context,
      first_seen, last_updated, status, assigned_agent, priority,
      source_session_id, source_agent_id, source_repo,
      access_count, last_accessed, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      node_type = excluded.node_type,
      one_liner = excluded.one_liner,
      summary = excluded.summary,
      full_synthesis = excluded.full_synthesis,
      entity_name = excluded.entity_name,
      entity_aliases = excluded.entity_aliases,
      temporal_context = excluded.temporal_context,
      last_updated = excluded.last_updated,
      status = excluded.status,
      assigned_agent = excluded.assigned_agent,
      priority = excluded.priority,
      access_count = MAX(synthesis_nodes.access_count, excluded.access_count),
      last_accessed = MAX(synthesis_nodes.last_accessed, excluded.last_accessed),
      updated_at = excluded.updated_at
    WHERE excluded.updated_at > synthesis_nodes.updated_at
  `);

  let merged = 0;
  let conflicts = 0;

  for (const node of changedNodes) {
    // Check if exists and would be a conflict
    const existing = targetDb.prepare('SELECT updated_at FROM synthesis_nodes WHERE id = ?').get(node.id) as { updated_at: number } | undefined;

    if (existing && existing.updated_at >= node.updated_at) {
      conflicts++;
      continue; // Skip - target has newer version
    }

    insertStmt.run(
      node.id, node.node_type, node.one_liner, node.summary, node.full_synthesis,
      node.entity_name, node.entity_aliases, node.temporal_context,
      node.first_seen, node.last_updated, node.status, node.assigned_agent, node.priority,
      node.source_session_id, node.source_agent_id, node.source_repo,
      node.access_count, node.last_accessed, node.created_at, node.updated_at
    );
    merged++;
  }

  console.log(`  ${direction}: ${merged} nodes merged, ${conflicts} conflicts (target had newer)`);
  return { merged, conflicts };
}

function mergeEdges(
  sourceDb: Database,
  targetDb: Database,
  lastSync: number,
  direction: string
): number {
  const changedEdges = sourceDb.prepare(`
    SELECT from_node_id, to_node_id, edge_type, weight, context, created_at
    FROM synthesis_edges
    WHERE created_at > ?
  `).all(lastSync) as any[];

  if (changedEdges.length === 0) {
    return 0;
  }

  const insertStmt = targetDb.prepare(`
    INSERT OR IGNORE INTO synthesis_edges (from_node_id, to_node_id, edge_type, weight, context, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let merged = 0;
  for (const edge of changedEdges) {
    try {
      const result = insertStmt.run(edge.from_node_id, edge.to_node_id, edge.edge_type, edge.weight, edge.context, edge.created_at);
      if (result.changes > 0) merged++;
    } catch {
      // Skip - foreign key constraint (node doesn't exist)
    }
  }

  console.log(`  ${direction}: ${merged} edges merged`);
  return merged;
}

function mergeRawContent(
  sourceDb: Database,
  targetDb: Database,
  lastSync: number,
  direction: string
): number {
  const changed = sourceDb.prepare(`
    SELECT id, session_id, synthesis_node_id, content_type, content,
           agent_id, timestamp, message_index, created_at
    FROM raw_content
    WHERE created_at > ?
  `).all(lastSync) as any[];

  if (changed.length === 0) {
    return 0;
  }

  const insertStmt = targetDb.prepare(`
    INSERT OR IGNORE INTO raw_content (
      id, session_id, synthesis_node_id, content_type, content,
      agent_id, timestamp, message_index, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let merged = 0;
  for (const row of changed) {
    const result = insertStmt.run(
      row.id, row.session_id, row.synthesis_node_id, row.content_type, row.content,
      row.agent_id, row.timestamp, row.message_index, row.created_at
    );
    if (result.changes > 0) merged++;
  }

  console.log(`  ${direction}: ${merged} raw_content entries merged`);
  return merged;
}

async function sync(remote: string, dryRun: boolean) {
  console.log('=== Total Recall Bidirectional Sync ===\n');
  console.log(`Local:  ${LOCAL_DB_PATH}`);
  console.log(`Remote: ${remote}:~/${REMOTE_DB_RELATIVE}`);
  console.log(`Mode:   ${dryRun ? 'DRY RUN (no changes will be made)' : 'LIVE'}\n`);

  ensureTmpDir();

  // Backup local before any changes
  if (!dryRun) {
    console.log('Creating backup...');
    backupLocal();
  }

  // Checkpoint and pull remote
  checkpointRemoteWal(remote);
  const remoteDbPath = pullRemoteDb(remote);

  // Open both databases
  const localDb = new Database(LOCAL_DB_PATH);
  const remoteDb = new Database(remoteDbPath);

  // Get last sync time (from local metadata)
  const lastSync = getLastSyncTime(localDb);
  console.log(`\nLast sync: ${lastSync === 0 ? 'never' : new Date(lastSync).toISOString()}\n`);

  // Get current counts
  const localCount = (localDb.prepare('SELECT COUNT(*) as c FROM synthesis_nodes').get() as { c: number }).c;
  const remoteCount = (remoteDb.prepare('SELECT COUNT(*) as c FROM synthesis_nodes').get() as { c: number }).c;
  console.log(`Current counts: local=${localCount}, remote=${remoteCount}\n`);

  if (dryRun) {
    // Just show what would happen
    const localNew = localDb.prepare('SELECT COUNT(*) as c FROM synthesis_nodes WHERE created_at > ? OR updated_at > ?').get(lastSync, lastSync) as { c: number };
    const remoteNew = remoteDb.prepare('SELECT COUNT(*) as c FROM synthesis_nodes WHERE created_at > ? OR updated_at > ?').get(lastSync, lastSync) as { c: number };

    console.log('Would merge:');
    console.log(`  Local -> Remote: up to ${localNew.c} nodes`);
    console.log(`  Remote -> Local: up to ${remoteNew.c} nodes`);
    console.log('\nRun without --dry-run to execute sync');

    localDb.close();
    remoteDb.close();
    return;
  }

  // Merge: Remote -> Local
  console.log('Merging Remote -> Local...');
  mergeNodes(remoteDb, localDb, lastSync, 'Remote -> Local');
  mergeEdges(remoteDb, localDb, lastSync, 'Remote -> Local');
  mergeRawContent(remoteDb, localDb, lastSync, 'Remote -> Local');

  // Merge: Local -> Remote
  console.log('\nMerging Local -> Remote...');
  mergeNodes(localDb, remoteDb, lastSync, 'Local -> Remote');
  mergeEdges(localDb, remoteDb, lastSync, 'Local -> Remote');
  mergeRawContent(localDb, remoteDb, lastSync, 'Local -> Remote');

  // Update sync timestamp
  const now = Date.now();
  setLastSyncTime(localDb, now);
  setLastSyncTime(remoteDb, now);

  // Close local, keep remote open for push
  localDb.close();
  remoteDb.close();

  // Push merged remote back
  console.log('');
  pushRemoteDb(remote, remoteDbPath);

  // Final counts
  const finalLocalDb = new Database(LOCAL_DB_PATH, { readonly: true });
  const finalRemoteDb = new Database(remoteDbPath, { readonly: true });
  const finalLocalCount = (finalLocalDb.prepare('SELECT COUNT(*) as c FROM synthesis_nodes').get() as { c: number }).c;
  const finalRemoteCount = (finalRemoteDb.prepare('SELECT COUNT(*) as c FROM synthesis_nodes').get() as { c: number }).c;
  finalLocalDb.close();
  finalRemoteDb.close();

  console.log('\n=== Sync Complete ===');
  console.log(`Final counts: local=${finalLocalCount}, remote=${finalRemoteCount}`);
  console.log(`\nNote: Embeddings are NOT synced (architecture-specific).`);
  console.log(`Run embedding regeneration on each side if needed.`);
}

// Main
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const remote = args.find(a => !a.startsWith('--')) || 'ramram@168.119.4.15';

sync(remote, dryRun).catch((e) => {
  console.error('Sync failed:', e);
  process.exit(1);
});
