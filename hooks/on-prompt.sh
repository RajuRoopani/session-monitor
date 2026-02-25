#!/usr/bin/env bash
# hooks/on-prompt.sh — UserPromptSubmit hook
# Fires on every user message. If no goal exists for this session, saves
# the first message as the goal to ~/.session-monitor/{session_id}/goal.txt

set -euo pipefail

HOOK_INPUT=$(cat)
SESSION_ID=$(echo "$HOOK_INPUT" | jq -r '.session_id // ""')
PROMPT=$(echo "$HOOK_INPUT"     | jq -r '.prompt    // ""')

if [[ -z "$SESSION_ID" || -z "$PROMPT" ]]; then
  exit 0
fi

GOAL_DIR="$HOME/.session-monitor/$SESSION_ID"
GOAL_FILE="$GOAL_DIR/goal.txt"

# Only save once — first message becomes the goal
if [[ ! -f "$GOAL_FILE" ]]; then
  mkdir -p "$GOAL_DIR"
  # Trim to 500 chars to keep it concise
  echo "${PROMPT:0:500}" > "$GOAL_FILE"
fi

# Always exit 0 — never block the user's message
exit 0
