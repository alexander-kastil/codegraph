#!/bin/sh
set -e

WORKSPACE="${WORKSPACE_PATH:-/workspace}"
PORT="${CODEGRAPH_PORT:-3333}"
CODEGRAPH="node /app/dist/bin/codegraph.js"

# Detect whether workspace is a collection of repos (multi-repo mode) or a
# single project. Any subdirectory that contains a common project marker is
# treated as an independent repo to index.
is_repo() {
  dir="$1"
  [ -d "${dir}/.git" ] || [ -f "${dir}/package.json" ] || \
  [ -f "${dir}/go.mod" ] || [ -f "${dir}/Cargo.toml" ] || \
  [ -f "${dir}/pom.xml" ] || [ -f "${dir}/composer.json" ] || \
  [ -f "${dir}/pyproject.toml" ] || [ -f "${dir}/setup.py" ]
}

REPOS_FOUND=0
for dir in "$WORKSPACE"/*/; do
  [ -d "$dir" ] || continue
  is_repo "$dir" || continue
  REPOS_FOUND=$((REPOS_FOUND + 1))
done

if [ "$REPOS_FOUND" -gt 0 ]; then
  # ── Multi-repo mode ────────────────────────────────────────────────────────
  echo "[CodeGraph] Multi-repo workspace: $REPOS_FOUND repo(s) found under $WORKSPACE"

  for dir in "$WORKSPACE"/*/; do
    [ -d "$dir" ] || continue
    is_repo "$dir" || continue
    name=$(basename "$dir")
    if [ ! -f "${dir}.codegraph/codegraph.db" ]; then
      echo "[CodeGraph] Initializing $name..."
      $CODEGRAPH init "$dir" 2>/dev/null || { echo "[CodeGraph] WARNING: init failed for $name"; continue; }
      echo "[CodeGraph] Indexing $name..."
      $CODEGRAPH index "$dir" --quiet 2>/dev/null || echo "[CodeGraph] WARNING: index failed for $name"
    else
      echo "[CodeGraph] $name: existing index found, skipping init"
    fi
  done

  echo "[CodeGraph] Starting MCP HTTP server on :$PORT (workspace: $WORKSPACE)..."
  exec $CODEGRAPH serve --http --port "$PORT" --workspace "$WORKSPACE"
else
  # ── Single-repo mode (legacy) ──────────────────────────────────────────────
  if [ ! -f "$WORKSPACE/.codegraph/codegraph.db" ]; then
    echo "[CodeGraph] Initializing $WORKSPACE..."
    $CODEGRAPH init "$WORKSPACE"
    echo "[CodeGraph] Indexing $WORKSPACE..."
    $CODEGRAPH index "$WORKSPACE" --quiet
  fi

  echo "[CodeGraph] Starting MCP HTTP server on :$PORT..."
  exec $CODEGRAPH serve --http --port "$PORT" --path "$WORKSPACE"
fi
