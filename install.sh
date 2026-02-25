#!/usr/bin/env bash
# install.sh — Wire session-monitor hooks into any repo in one command.
# Usage: ./install.sh [--global]
#
# --global: install into ~/.claude/ (applies to all projects)
# default:  install into ./.claude/ (current project only)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GLOBAL=false

for arg in "$@"; do
  [[ "$arg" == "--global" ]] && GLOBAL=true
done

if [[ "$GLOBAL" == "true" ]]; then
  TARGET_DIR="$HOME/.claude"
  echo "Installing session-monitor hooks globally → $TARGET_DIR"
else
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  TARGET_DIR="$REPO_ROOT/.claude"
  echo "Installing session-monitor hooks into $REPO_ROOT"
fi

HOOKS_DIR="$TARGET_DIR/hooks"
mkdir -p "$HOOKS_DIR"

# Copy hook
cp "$SCRIPT_DIR/hooks/on-prompt.sh" "$HOOKS_DIR/on-prompt.sh"
chmod +x "$HOOKS_DIR/on-prompt.sh"
echo "  ✔ Copied hooks/on-prompt.sh"

# Merge settings
SETTINGS_FILE="$TARGET_DIR/settings.json"
NEW_HOOK='{
  "UserPromptSubmit": [{
    "hooks": [{
      "type": "command",
      "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/on-prompt.sh",
      "timeout": 5,
      "async": true
    }]
  }]
}'

if [[ -f "$SETTINGS_FILE" ]]; then
  if command -v jq &>/dev/null; then
    MERGED=$(jq --argjson h "$NEW_HOOK" '.hooks = ((.hooks // {}) + {"UserPromptSubmit": $h.UserPromptSubmit})' "$SETTINGS_FILE")
    echo "$MERGED" > "$SETTINGS_FILE"
    echo "  ✔ Updated $SETTINGS_FILE"
  else
    echo "  ⚠  jq not found — manually add the UserPromptSubmit hook to $SETTINGS_FILE"
    echo "     See $SCRIPT_DIR/.claude/settings.json for the hook config."
  fi
else
  echo "{\"hooks\":$NEW_HOOK}" | jq . > "$SETTINGS_FILE" 2>/dev/null || \
    echo "{\"hooks\":$NEW_HOOK}" > "$SETTINGS_FILE"
  echo "  ✔ Created $SETTINGS_FILE"
fi

echo ""
echo "Done! Session goals will be auto-captured from your first message."
echo ""
echo "Usage (run in a separate terminal):"
echo "  session-monitor start          # watch active session"
echo "  session-monitor status         # one-shot check"
echo "  session-monitor goal \"text\"    # override goal mid-session"
echo ""
echo "Install globally with npm:"
echo "  npm install -g $(basename "$SCRIPT_DIR")"
