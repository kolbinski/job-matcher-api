#!/bin/bash
# JobMatcher API — Scaffold Loader
# Loaded automatically at session start via SessionStart hook.
# Prints all PersonaArchitect files in context-load order.

FILES=(
  "PERSONA.md"
  "memory.md"
  "current-task.md"
  "lessons.md"
)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

for f in "${FILES[@]}"; do
  FILE_PATH="$PROJECT_ROOT/$f"
  if [ -f "$FILE_PATH" ]; then
    echo "=== $f ==="
    cat "$FILE_PATH"
    echo ""
  else
    echo "=== $f === [NOT FOUND — run from project root]"
  fi
done
