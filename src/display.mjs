// src/display.mjs — live terminal dashboard (redraws in-place every tick)

import { scoreToEmoji, msToHuman, timeAgo } from './utils.mjs';

// ANSI helpers
const ESC       = '\x1b[';
const RESET     = '\x1b[0m';
const BOLD      = '\x1b[1m';
const DIM       = '\x1b[2m';
const RED       = '\x1b[31m';
const YELLOW    = '\x1b[33m';
const GREEN     = '\x1b[32m';
const CYAN      = '\x1b[36m';
const MAGENTA   = '\x1b[35m';
const WHITE     = '\x1b[97m';
const BG_RED    = '\x1b[41m';
const BG_YELLOW = '\x1b[43m';
const BG_GREEN  = '\x1b[42m';
const BG_BLUE   = '\x1b[44m';
const BG_GRAY   = '\x1b[100m';

/** Status color map */
const STATUS_STYLE = {
  'ON TRACK': { bg: BG_GREEN,  fg: WHITE, emoji: '✅' },
  'HEADS UP':  { bg: BG_YELLOW, fg: WHITE, emoji: '🟡' },
  'DRIFTING':  { bg: BG_RED,    fg: WHITE, emoji: '🟠' },
  'STUCK':     { bg: BG_RED,    fg: WHITE, emoji: '🔴' },
};

/**
 * Render the complete terminal dashboard.
 * Clears previous render using cursor-up + line erase.
 * @param {object} state — full monitor state
 * @param {number} prevLines — number of lines drawn last time (for erase)
 * @returns {number} lines drawn this render
 */
export function render(state, prevLines) {
  const cols = process.stdout.columns || 72;
  const width = Math.min(cols - 2, 72);

  const lines = buildLines(state, width);

  // Erase previous render
  if (prevLines > 0) {
    process.stdout.write(ESC + prevLines + 'A'); // cursor up
    for (let i = 0; i < prevLines; i++) {
      process.stdout.write(ESC + '2K\n');        // clear line + move down
    }
    process.stdout.write(ESC + prevLines + 'A'); // cursor back up
  }

  process.stdout.write(lines.join('\n') + '\n');
  return lines.length;
}

function buildLines(state, width) {
  const {
    goal       = '(auto-detecting from first message…)',
    assessment = null,
    events     = [],
    startTime  = Date.now(),
    sessionId  = '',
    projectSlug= '',
  } = state;

  const toolCalls = events.filter(e => e.type === 'tool_call');
  const stepCount = toolCalls.length;
  const errorCount = toolCalls.filter(e => e.failed).length;
  const elapsed = Date.now() - startTime;

  // Last action
  const last = toolCalls[toolCalls.length - 1];
  const lastLabel = last
    ? `${last.tool?.name ?? '?'} → ${getShortDetail(last)} (${timeAgo(last.timestamp)})`
    : 'waiting for first tool call…';

  // Score / status
  const score  = assessment?.score  ?? null;
  const status = assessment?.status ?? (stepCount === 0 ? 'STARTING' : 'ON TRACK');
  const reason = assessment?.reason ?? '';
  const suggestion = assessment?.suggestion ?? null;
  const assessedAt = assessment?.assessedAt ?? null;
  const style  = STATUS_STYLE[status] ?? STATUS_STYLE['ON TRACK'];

  // Project label
  const project = projectSlug.split('-').pop() || projectSlug || 'session';

  const lines = [];
  const hr = '─'.repeat(width);

  // ── Header ──────────────────────────────────────────────────────────────
  lines.push(BOLD + CYAN + '┌' + '─'.repeat(width) + '┐' + RESET);
  const title = ` session-monitor  ·  ${project}  ·  ${fmtTime(new Date())} `;
  lines.push(BOLD + CYAN + '│' + center(title, width) + '│' + RESET);
  lines.push(BOLD + CYAN + '└' + '─'.repeat(width) + '┘' + RESET);

  // ── Goal ────────────────────────────────────────────────────────────────
  lines.push('');
  lines.push(DIM + 'Goal: ' + RESET + BOLD + truncate(goal, width - 6) + RESET);

  // ── Status badge ────────────────────────────────────────────────────────
  lines.push('');
  const scoreStr = score !== null ? ` ${score}/100` : '';
  const badge = `  ${style.emoji} ${status}${scoreStr}  `;
  lines.push(style.bg + style.fg + BOLD + badge + RESET);

  if (reason) {
    lines.push('  ' + DIM + truncate(reason, width - 2) + RESET);
  }
  if (suggestion) {
    lines.push('  ' + YELLOW + '→ ' + truncate(suggestion, width - 4) + RESET);
  }

  // ── Progress bar ────────────────────────────────────────────────────────
  lines.push('');
  const barWidth = width - 14;
  const filled = score !== null ? Math.round((score / 100) * barWidth) : 0;
  const barFill = barColor(score) + '█'.repeat(filled) + RESET + DIM + '░'.repeat(barWidth - filled) + RESET;
  const scoreLabel = score !== null ? `  Score ${score.toString().padStart(3)}/100` : '  Score ---/100';
  lines.push(DIM + 'Momentum: ' + RESET + barFill + DIM + scoreLabel + RESET);

  // ── Last action ──────────────────────────────────────────────────────────
  lines.push('');
  lines.push(DIM + 'Last:  ' + RESET + CYAN + truncate(lastLabel, width - 7) + RESET);

  // ── Stats ────────────────────────────────────────────────────────────────
  const statsLine = [
    `Step ${stepCount}`,
    msToHuman(elapsed),
    `${errorCount} error${errorCount !== 1 ? 's' : ''}`,
    assessedAt ? `assessed ${timeAgo(assessedAt)}` : 'not yet assessed',
  ].join('  |  ');
  lines.push(DIM + truncate(statsLine, width) + RESET);

  // ── Footer ────────────────────────────────────────────────────────────────
  lines.push('');
  lines.push(DIM + '─'.repeat(width) + RESET);
  lines.push(DIM + " Press 'g' to update goal  |  Ctrl+C to stop" + RESET);

  return lines;
}

// ── helpers ───────────────────────────────────────────────────────────────

function getShortDetail(event) {
  const name = event.tool?.name ?? '';
  const input = event.tool?.input ?? {};
  switch (name) {
    case 'Bash':    return (input.command ?? '').slice(0, 40);
    case 'Edit':
    case 'Write':
    case 'Read':    return shortPath(input.file_path ?? input.notebook_path ?? '');
    case 'Glob':    return input.pattern ?? '';
    case 'Grep':    return `"${(input.pattern ?? '').slice(0, 30)}"`;
    case 'WebFetch':return (input.url ?? '').slice(0, 40);
    default:        return '';
  }
}

function shortPath(p) {
  const parts = p.split('/');
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : p;
}

function center(str, width) {
  const visible = stripAnsi(str).length;
  const pad = Math.max(0, width - visible);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return ' '.repeat(left) + str + ' '.repeat(right);
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function fmtTime(d) {
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

function barColor(score) {
  if (score === null) return DIM;
  if (score >= 80) return GREEN;
  if (score >= 60) return YELLOW;
  if (score >= 40) return MAGENTA;
  return RED;
}

/** Clear the entire terminal and reset cursor */
export function clearScreen() {
  process.stdout.write('\x1bc');
}

/** Print a one-shot status (no live redraw) */
export function renderOnce(state) {
  render(state, 0);
}
