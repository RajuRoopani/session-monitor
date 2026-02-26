// src/monitor.mjs — orchestrates tail + signals + assess + display

import { readAll, tailJsonl } from './tail.mjs';
import { detectSignals, signalSummary } from './signals.mjs';
import { assess } from './assess.mjs';
import { render, clearScreen } from './display.mjs';
import { readGoal } from './store.mjs';

const ASSESS_EVERY_N_CALLS = 10; // run API check every N new tool calls
const DISPLAY_INTERVAL_MS  = 2000;

/**
 * Start the live monitor for a given session.
 * @param {string} transcriptPath  — absolute path to JSONL
 * @param {string} sessionId
 * @param {string} projectSlug
 * @param {string|null} goalOverride — from --goal flag, else auto-read
 * @returns {Function} stop() — call to end monitoring
 */
export async function startMonitor(transcriptPath, sessionId, projectSlug, goalOverride) {
  const startTime = Date.now();

  // ── State ────────────────────────────────────────────────────────────────
  let events     = [];       // all parsed JSONL entries
  let goal       = goalOverride ?? (await readGoal(sessionId)) ?? null;
  let assessment = null;     // latest {score, status, reason, suggestion, assessedAt}
  let toolCallsSinceAssess = 0;
  let prevLines  = 0;        // for in-place redraw
  let stopped    = false;

  // ── Load existing transcript ──────────────────────────────────────────────
  const existing = await readAll(transcriptPath);
  for (const entry of existing) {
    const parsed = parseLine(entry);
    if (parsed) events.push(parsed);
  }

  // Trigger initial assess if there's something to look at
  if (events.length > 0) {
    await runAssess();
  }

  // ── Tail new entries ──────────────────────────────────────────────────────
  const stopTail = tailJsonl(transcriptPath, async (raw) => {
    const entry = parseLine(raw);
    if (!entry) return;
    events.push(entry);

    // Auto-capture goal from first user message if not set
    if (!goal && entry.type === 'user_message') {
      goal = extractUserText(entry);
      if (goal) await writeGoalSilently(sessionId, goal);
    }

    if (entry.type === 'tool_call') {
      toolCallsSinceAssess++;
      if (toolCallsSinceAssess >= ASSESS_EVERY_N_CALLS) {
        toolCallsSinceAssess = 0;
        await runAssess();
      }
    }
  });

  // ── Display loop ──────────────────────────────────────────────────────────
  clearScreen();

  const displayTimer = setInterval(() => {
    if (stopped) return;
    prevLines = render(buildState(), prevLines);
  }, DISPLAY_INTERVAL_MS);

  // Initial render
  prevLines = render(buildState(), 0);

  // ── Keyboard: 'g' to update goal ─────────────────────────────────────────
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', async (key) => {
      if (key === 'g' || key === 'G') {
        await promptGoalUpdate();
      }
      if (key === '\u0003') { // Ctrl+C
        stop();
        process.exit(0);
      }
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function buildState() {
    return {
      goal,
      assessment,
      events,
      startTime,
      sessionId,
      projectSlug,
    };
  }

  async function runAssess() {
    if (!goal) return;
    const signals   = detectSignals(events, goal);
    const sigText   = signalSummary(signals);
    const result    = await assess(goal, events, signals, sigText);
    assessment = { ...result, assessedAt: new Date().toISOString() };
    // Force immediate redraw after assessment
    prevLines = render(buildState(), prevLines);
  }

  async function promptGoalUpdate() {
    // Temporarily pause raw mode for input
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write('\n\x1b[2K\x1b[1mNew goal: \x1b[0m');

    const newGoal = await readLine();
    if (newGoal.trim()) {
      goal = newGoal.trim();
      await writeGoalSilently(sessionId, goal);
      toolCallsSinceAssess = ASSESS_EVERY_N_CALLS; // force next assess
    }
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    clearScreen();
    prevLines = 0;
  }

  function stop() {
    stopped = true;
    stopTail();
    clearInterval(displayTimer);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
    process.stdout.write('\n\x1b[0mSession monitor stopped.\n');
  }

  return stop;
}

// ── JSONL line parser ─────────────────────────────────────────────────────

function parseLine(raw) {
  if (!raw) return null;
  let obj;
  if (typeof raw === 'string') {
    if (!raw.trim()) return null;
    try { obj = JSON.parse(raw); } catch { return null; }
  } else {
    obj = raw;
  }

  const ts = obj.timestamp ?? new Date().toISOString();

  // User message (captures goal + branch points)
  if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
    const textBlock = obj.message.content.find(b => b.type === 'text');
    if (textBlock) {
      return { type: 'user_message', text: textBlock.text, timestamp: ts };
    }
    // Tool results embedded in user messages
    const resultBlocks = obj.message.content.filter(b => b.type === 'tool_result');
    if (resultBlocks.length > 0) {
      // We'll handle tool result pairing in tail — for now skip these
      return null;
    }
  }

  // Assistant tool_use
  if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
    for (const block of obj.message.content) {
      if (block.type === 'tool_use') {
        return {
          type:      'tool_call',
          id:        block.id,
          tool:      { name: block.name, input: block.input ?? {} },
          failed:    false, // will be updated when we see the result
          timestamp: ts,
        };
      }
    }
  }

  // Tool results — mark the matching tool_call as failed/passed
  // (We store them too so we can find them later)
  if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
    for (const block of obj.message.content) {
      if (block.type === 'tool_result') {
        return {
          type:       'tool_result',
          toolUseId:  block.tool_use_id,
          content:    block.content,
          isError:    block.is_error ?? false,
          timestamp:  ts,
        };
      }
    }
  }

  return null;
}

/** After accumulating entries, back-fill 'failed' on tool_calls from results */
export function reconcileFailures(events) {
  const results = new Map();
  for (const e of events) {
    if (e.type === 'tool_result') results.set(e.toolUseId, e);
  }
  for (const e of events) {
    if (e.type === 'tool_call' && results.has(e.id)) {
      e.failed = results.get(e.id).isError ?? false;
    }
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────

function extractUserText(entry) {
  if (entry.type !== 'user_message') return null;
  const text = entry.text?.trim();
  if (!text) return null;

  // Skip messages that look like stack traces or error dumps
  if (/^(TypeError|Error|ReferenceError|SyntaxError|RangeError)[\s:]/.test(text)) return null;
  if (/^\s+at\s+\S+\s+\(/.test(text)) return null;           // starts with stack frame
  if (/file:\/\/.*:\d+\n/.test(text)) return null;            // file URL with line number
  if (/\n\s+at\s+\S/.test(text)) return null;                 // has stack frames inside
  if (/^\s*[\`~]{3,}/.test(text)) return null;                // fenced code block paste

  // Skip very short commands ("push it", "commit this", "ok", etc.) — ≤2 words under 20 chars
  if (text.length < 20 && text.trim().split(/\s+/).length <= 2) return null;

  return text.slice(0, 500);
}

async function writeGoalSilently(sessionId, goal) {
  try {
    const { writeGoal } = await import('./store.mjs');
    await writeGoal(sessionId, goal);
  } catch { /* best-effort */ }
}

function readLine() {
  return new Promise((resolve) => {
    let buf = '';
    const onData = (key) => {
      if (key === '\r' || key === '\n') {
        process.stdin.removeListener('data', onData);
        resolve(buf);
      } else if (key === '\u007f') { // backspace
        buf = buf.slice(0, -1);
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        process.stdout.write('\x1b[1mNew goal: \x1b[0m' + buf);
      } else {
        buf += key;
        process.stdout.write(key);
      }
    };
    process.stdin.on('data', onData);
  });
}
