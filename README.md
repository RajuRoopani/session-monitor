# session-monitor

> Real-time terminal buddy that watches your active Claude Code session and tells you if you're drifting from the goal.

```
╔════════════════════════════════════════════════════════════╗
║        session-monitor  ·  auth-service  ·  14:32          ║
╚════════════════════════════════════════════════════════════╝

Goal: Fix the refresh token bug in AuthService

  ✅ ON TRACK  84/100
  Agent is consistently editing auth-related files with passing tests.

Momentum: ██████████░░░░░░░░░░  Score  84/100  (assessed 14:32:15)

Last:  Edit → …/auth/AuthService.ts (3s ago)
Step 12  |  8m 32s  |  0 errors  |  assessed 14:31:52

────────────────────────────────────────────────────────────
 Press 'g' to update goal  |  Ctrl+C to stop
```

## Why

Claude Code sessions can quietly drift. You ask it to fix a bug and 20 minutes later it's refactoring half the codebase. `session-monitor` watches the live transcript in a split-pane terminal and gives you a continuous **on-track / drifting / stuck** signal before a 2-hour session goes sideways.

## Install

```bash
npm install -g session-monitor
```

Then wire up the goal-capture hook in your project (or globally):

```bash
# current project only
npx session-monitor-install

# all projects
npx session-monitor-install --global
```

Or clone and install manually:

```bash
git clone https://github.com/RajuRoopani/session-monitor
cd session-monitor
npm install
./install.sh           # current project
./install.sh --global  # all projects
npm link               # makes `session-monitor` available globally
```

## Usage

Open a split terminal alongside your Claude Code session:

```bash
session-monitor start               # watch latest session, auto-detect goal
session-monitor start -g "Fix auth" # override goal explicitly
session-monitor start -s <id>       # watch a specific session by ID prefix

session-monitor status              # one-shot check, exits after printing
session-monitor status --json       # machine-readable output

session-monitor goal                # show current goal
session-monitor goal "new goal"     # update goal mid-session (or press 'g' in live mode)

session-monitor stop                # stop background watcher
```

## How it works

```
Claude Code session (JSONL transcript)
         │
         ▼  (500ms polling — NOT fs.watch, unreliable on macOS)
    tail.mjs  ──────────────────────────────────────────────
         │                                                  │
         ▼                                                  ▼
   signals.mjs (7 heuristics, free)              store.mjs (goal.txt)
         │                                                  │
         ▼                                                  │
   assess.mjs (claude-haiku, every 10 calls) ◄─────────────┘
         │
         ▼
   display.mjs (live terminal redraw every 2s)
```

### Heuristic signals (always-on, no API cost)

| Signal | Condition |
|---|---|
| Loop | Same Bash command repeated 3+ times |
| Stuck on file | Same file edited 5+ times in a row |
| Error streak | 3+ consecutive failed tool calls |
| Analysis paralysis | 8+ reads with no edits |
| Scope creep | Files edited outside goal's keyword scope |
| Good momentum | Edit → passing Bash test cycles |
| No progress | No file edits in last 20 steps |

### AI assessment (claude-haiku, every 10 tool calls)

Sends the last 20 actions + signal summary to `claude-haiku-4-5` and gets back a structured JSON score. Falls back to heuristics if no API key or network error.

Set your API key:

```bash
export ANTHROPIC_API_KEY=sk-...
```

### Alert levels

| Score | Status | Meaning |
|---|---|---|
| 80–100 | 🟢 ON TRACK | Agent is working toward the goal |
| 60–79  | 🟡 HEADS UP | Minor drift, watch closely |
| 40–59  | 🟠 DRIFTING | Significant deviation, redirect now |
| 0–39   | 🔴 STUCK    | Agent is looping or failing repeatedly |

## Goal auto-capture

When the `on-prompt.sh` hook is installed, your **first message** in each Claude Code session is automatically saved as the goal. You can override it at any time:

- In live mode: press **`g`** and type a new goal
- From CLI: `session-monitor goal "new goal text"`
- From CLI flag: `session-monitor start --goal "text"`

Goals are stored in `~/.session-monitor/{session_id}/goal.txt`.

## Requirements

- Node.js ≥ 18
- Claude Code CLI
- `ANTHROPIC_API_KEY` (optional — falls back to heuristics without it)

## Related tools

- [session-replay](https://github.com/RajuRoopani/session-replay) — interactive HTML timeline of past sessions with fork-from-step
- [agent-handoff](https://github.com/RajuRoopani/agent-handoff) — zero-context-loss between sessions

## License

MIT
