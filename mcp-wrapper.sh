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

# NixOS: Set LD_LIBRARY_PATH for native modules that need libstdc++
GCC_LIB=$(find /nix/store -maxdepth 1 -name "*-gcc-*-lib" -type d 2>/dev/null | head -1)
if [[ -n "$GCC_LIB" ]]; then
    export LD_LIBRARY_PATH="${GCC_LIB}/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

exec bun "${SCRIPT_DIR}/dist/mcp-server.js" "$@"
