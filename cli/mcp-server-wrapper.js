#!/usr/bin/env bun
/**
 * Total Recall MCP Server Wrapper
 *
 * This acts as a thin proxy to the coordinator's MCP server.
 * It handles:
 * 1. Auto-installing dependencies on first run
 * 2. Proxying MCP protocol to the coordinator
 * 3. Graceful fallback if coordinator is unavailable
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Determine plugin root directory
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(__dirname, '..');

// Helper function to run bun install
function runBunInstall() {
  return new Promise((resolve, reject) => {
    console.error('Installing totalrecall dependencies (first run only)...');
    console.error('This may take 30-60 seconds...');

    const child = spawn('bun', ['install'], {
      cwd: PLUGIN_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (data) => {
      process.stderr.write(data);
    });

    child.stderr.on('data', (data) => {
      process.stderr.write(data);
    });

    child.on('exit', (code) => {
      if (code === 0) {
        console.error('Dependencies installed successfully.');
        resolve();
      } else {
        console.error('ERROR: Failed to install dependencies.');
        console.error(`Please run manually: cd "${PLUGIN_ROOT}" && bun install`);
        reject(new Error(`bun install failed with exit code ${code}`));
      }
    });

    child.on('error', (err) => {
      console.error(`ERROR: Failed to run bun install: ${err.message}`);
      reject(err);
    });
  });
}

async function main() {
  try {
    // Check if node_modules exists
    const nodeModulesPath = join(PLUGIN_ROOT, 'node_modules');
    if (!existsSync(nodeModulesPath)) {
      await runBunInstall();
    }

    // Start the MCP server (run TypeScript directly with bun)
    const mcpServerPath = join(PLUGIN_ROOT, 'src', 'mcp-server.ts');

    if (!existsSync(mcpServerPath)) {
      console.error(`ERROR: MCP server not found at ${mcpServerPath}`);
      process.exit(1);
    }

    // Use bun to run TypeScript directly
    const child = spawn('bun', [mcpServerPath], {
      stdio: 'inherit',
      shell: false,
      env: {
        ...process.env,
        TOTALRECALL_BASE_URL: process.env.TOTALRECALL_BASE_URL || 'http://localhost:3847'
      }
    });

    // Forward signals to the child process
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    process.on('SIGINT', () => child.kill('SIGINT'));

    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
      } else {
        process.exit(code || 0);
      }
    });

    child.on('error', (err) => {
      console.error(`ERROR: Failed to start MCP server: ${err.message}`);
      process.exit(1);
    });

  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Unexpected error: ${error.message}`);
  process.exit(1);
});
