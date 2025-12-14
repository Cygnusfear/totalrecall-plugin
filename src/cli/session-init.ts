/**
 * CLI: session-init
 * DEPRECATED: This file is now a no-op.
 *
 * Previously created garbage "Session started: timestamp" nodes.
 * Hooks should NEVER create synthesis nodes directly.
 * All nodes should be created by the background synthesis worker via LLM.
 */

async function main() {
  // No-op - we don't create garbage session start nodes anymore
  // The session-graft hook already injects context without creating nodes
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
