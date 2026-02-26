#!/usr/bin/env node
// src/cli.mjs — session-monitor CLI entry point
// Usage: session-monitor [start|stop|status|goal] [options]

import { parseArgs } from 'node:util';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  latestSession,
  findSession,
  goalPath,
  readGoal,
  writeGoal,
  writePid,
  readPid,
  clearPid,
} from './store.mjs';
import { startMonitor } from './monitor.mjs';
import { renderOnce } from './display.mjs';
import { readAll } from './tail.mjs';
import { detectSignals, signalSummary, heuristicScore } from './signals.mjs';

// ── Arg parsing ───────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const command = rawArgs[0] ?? 'start';

const { values, positionals } = parseArgs({
  args: rawArgs.slice(1),
  options: {
    goal:    { type: 'string',  short: 'g' },
    session: { type: 'string',  short: 's' },
    cwd:     { type: 'string',  short: 'c', default: process.cwd() },
    json:    { type: 'boolean', short: 'j', default: false },
    help:    { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
  strict: false,
});

// ── Route ─────────────────────────────────────────────────────────────────

switch (command) {
  case 'start':  await cmdStart();  break;
  case 'stop':   await cmdStop();   break;
  case 'status': await cmdStatus(); break;
  case 'goal':   await cmdGoal();   break;
  case '--help':
  case '-h':     printUsage(); process.exit(0); break;
  default:
    printUsage();
    process.exit(1);
}

// ── Commands ──────────────────────────────────────────────────────────────

async function cmdStart() {
  if (values.help) { printUsage(); process.exit(0); }

  const cwd = path.resolve(values.cwd);

  // Find session
  let sessionInfo;
  if (values.session) {
    sessionInfo = await findSession(values.session, cwd);
    if (!sessionInfo) {
      console.error(`session-monitor: session "${values.session}" not found`);
      process.exit(1);
    }
  } else {
    sessionInfo = await latestSession(cwd);
    if (!sessionInfo) {
      console.error('session-monitor: no active session found for', cwd);
      console.error('  Start a Claude Code session first, then run session-monitor start');
      process.exit(1);
    }
  }

  const { sessionId, transcriptPath, projectSlug } = sessionInfo;

  // Check if already running
  const existingPid = await readPid(sessionId);
  if (existingPid) {
    const alive = isPidAlive(existingPid);
    if (alive) {
      console.error(`session-monitor: already watching session ${sessionId} (PID ${existingPid})`);
      console.error('  Run "session-monitor stop" to stop it first.');
      process.exit(1);
    }
    await clearPid(sessionId);
  }

  // Save PID
  await writePid(sessionId, process.pid);

  console.log(`\x1b[2msession-monitor: watching ${projectSlug}/${sessionId.slice(0, 8)}…\x1b[0m`);

  // Start monitoring
  const stopFn = await startMonitor(
    transcriptPath,
    sessionId,
    projectSlug,
    values.goal ?? null,
  );

  // Clean up on exit
  const cleanup = async () => {
    await clearPid(sessionId);
    stopFn();
  };
  process.on('SIGINT',  cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit',    () => { try { clearPid(sessionId); } catch {} });
}

async function cmdStop() {
  const cwd = path.resolve(values.cwd);
  const sessionInfo = await latestSession(cwd);
  if (!sessionInfo) {
    console.error('session-monitor: no session found');
    process.exit(1);
  }

  const { sessionId } = sessionInfo;
  const pid = await readPid(sessionId);
  if (!pid) {
    console.log('session-monitor: not running for this session');
    process.exit(0);
  }

  try {
    process.kill(pid, 'SIGTERM');
    await clearPid(sessionId);
    console.log(`session-monitor: stopped (PID ${pid})`);
  } catch {
    await clearPid(sessionId);
    console.log('session-monitor: process was already gone, cleaned up PID file');
  }
}

async function cmdStatus() {
  const cwd = path.resolve(values.cwd);

  const sessionInfo = values.session
    ? await findSession(values.session, cwd)
    : await latestSession(cwd);

  if (!sessionInfo) {
    console.error('session-monitor: no session found for', cwd);
    process.exit(1);
  }

  const { sessionId, transcriptPath, projectSlug } = sessionInfo;

  // Read transcript
  const { readAll: ra } = await import('./tail.mjs');
  const events = await ra(transcriptPath);

  const goal = values.goal ?? (await readGoal(sessionId)) ?? detectGoalFromEvents(events) ?? '(no goal set)';

  // Quick parse for signals
  const toolCallEvents = extractToolCalls(events);
  const signals = detectSignals(toolCallEvents, goal);
  const sigText  = signalSummary(signals);
  const score    = heuristicScore(signals);
  const status   = scoreToStatus(score);

  if (values.json) {
    console.log(JSON.stringify({ sessionId, projectSlug, goal, score, status, signals }, null, 2));
    process.exit(0);
  }

  // One-shot terminal render
  renderOnce({
    goal,
    assessment: { score, status, reason: sigText, suggestion: null, assessedAt: new Date().toISOString() },
    events: toolCallEvents,
    startTime: Date.now() - 60_000, // approximate
    sessionId,
    projectSlug,
  });
}

async function cmdGoal() {
  const cwd = path.resolve(values.cwd);
  const newGoal = positionals[0] ?? values.goal;

  if (!newGoal) {
    const sessionInfo = await latestSession(cwd);
    if (!sessionInfo) { console.error('No session found'); process.exit(1); }
    const current = await readGoal(sessionInfo.sessionId);
    console.log(current ? `Current goal: ${current}` : '(no goal set)');
    process.exit(0);
  }

  const sessionInfo = await latestSession(cwd);
  if (!sessionInfo) { console.error('No session found'); process.exit(1); }

  await writeGoal(sessionInfo.sessionId, newGoal);
  console.log(`✔ Goal updated: ${newGoal}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`
\x1b[1msession-monitor\x1b[0m — live AI session feedback buddy

\x1b[1mUsage:\x1b[0m
  session-monitor start            Watch latest session, auto-detect goal
  session-monitor start -g "text"  Override goal
  session-monitor start -s <id>    Watch a specific session by ID
  session-monitor stop             Kill running monitor
  session-monitor status           One-shot check, no live mode
  session-monitor status --json    JSON output
  session-monitor goal             Show current goal
  session-monitor goal "new text"  Update goal mid-session

\x1b[1mOptions:\x1b[0m
  -g, --goal <text>     Goal text
  -s, --session <id>    Session ID prefix
  -c, --cwd <dir>       Project directory (default: current)
  -j, --json            JSON output (status command)
  -h, --help            Show this help
  `.trim());
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function scoreToStatus(score) {
  if (score >= 80) return 'ON TRACK';
  if (score >= 60) return 'HEADS UP';
  if (score >= 40) return 'DRIFTING';
  return 'STUCK';
}

function detectGoalFromEvents(rawEvents) {
  for (const obj of rawEvents) {
    if (obj.type !== 'user') continue;
    const content = obj.message?.content;
    const text = (typeof content === 'string' ? content :
      (Array.isArray(content) ? content.find(b => b.type === 'text')?.text : null))?.trim();
    if (!text) continue;
    if (/^(TypeError|Error|ReferenceError|SyntaxError|RangeError)[\s:]/.test(text)) continue;
    if (/file:\/\/.*:\d+\n/.test(text)) continue;
    if (/\n\s+at\s+\S/.test(text)) continue;
    if (/^\s*[`~]{3,}/.test(text)) continue;
    if (text.length < 20 && text.trim().split(/\s+/).length <= 2) continue;
    return text.slice(0, 500);
  }
  return null;
}

function extractToolCalls(rawEvents) {
  const calls = [];
  for (const obj of rawEvents) {
    if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
      for (const block of obj.message.content) {
        if (block.type === 'tool_use') {
          calls.push({
            type:      'tool_call',
            id:        block.id,
            tool:      { name: block.name, input: block.input ?? {} },
            failed:    false,
            timestamp: obj.timestamp ?? new Date().toISOString(),
          });
        }
      }
    }
  }
  return calls;
}
