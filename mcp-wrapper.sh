#!/usr/bin/env bash
# Total Recall MCP Server Wrapper
# Portable wrapper that works on NixOS and other systems

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source environment if available (bhakti-specific)
if [[ -f /run/secrets/rendered/coordinator-env ]]; then
    set -a
    source /run/secrets/rendered/coordinator-env
    set +a
fi

exec node "${SCRIPT_DIR}/dist/mcp-server.js" "$@"
