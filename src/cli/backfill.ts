/**
 * CLI: backfill
 * Process unsynced conversations from ~/.claude/projects
 */

import { readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getDatabase } from '../db.js';

async function main() {
  const db = getDatabase();

  const projectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(projectsDir)) {
    console.log('No Claude projects directory found');
    db.close();
    return;
  }

  let processed = 0;
  let skipped = 0;

  const projects = readdirSync(projectsDir);
  for (const project of projects) {
    const projectPath = join(projectsDir, project);
    const stat = statSync(projectPath);
    if (!stat.isDirectory()) continue;

    const files = readdirSync(projectPath).filter((f) => f.endsWith('.jsonl'));
    for (const file of files) {
      const sessionId = file.replace('.jsonl', '');

      // Check if already processed
      const existing = db.queryNodes({ session_id: sessionId, limit: 1 });
      if (existing.length > 0) {
        skipped++;
        continue;
      }

      // Queue for processing (will be handled by synthesis worker)
      console.log(`Would process: ${project}/${file}`);
      processed++;
    }
  }

  console.log(`\nBackfill complete: ${processed} to process, ${skipped} skipped`);
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
