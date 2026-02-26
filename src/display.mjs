// src/display.mjs — live terminal dashboard with visual timeline + block charts

import { msToHuman, timeAgo } from './utils.mjs';

// ── ANSI ─────────────────────────────────────────────────────────────────────
const R  = '\x1b[0m';   // reset
const B  = '\x1b[1m';   // bold
const D  = '\x1b[2m';   // dim
const RED   = '\x1b[31m';
const YLW   = '\x1b[33m';
const GRN   = '\x1b[32m';
const CYN   = '\x1b[36m';
const MGT   = '\x1b[35m';
const WHT   = '\x1b[97m';
const BLU   = '\x1b[34m';
const PRP   = '\x1b[95m';
const BGRED = '\x1b[41m';
const BGYLW = '\x1b[43m';
const BGGRN = '\x1b[42m';

// ── Tool config ───────────────────────────────────────────────────────────────
const TOOL = {
  Read:     { l: 'R', c: D+WHT,    label: 'Read'  },
  Glob:     { l: 'G', c: D+WHT,    label: 'Glob'  },
  Grep:     { l: '/', c: CYN,      label: 'Grep'  },
  Edit:     { l: 'E', c: BLU,      label: 'Edit'  },
  Write:    { l: 'W', c: GRN,      label: 'Write' },
  Bash:     { l: 'B', c: YLW,      label: 'Bash'  },
  WebFetch: { l: 'F', c: MGT,      label: 'Fetch' },
  Task:     { l: 'T', c: PRP,      label: 'Task'  },
};

const STATUS_STYLE = {
  'ON TRACK': { bg: BGGRN, fg: WHT, emoji: '✅' },
  'HEADS UP':  { bg: BGYLW, fg: WHT, emoji: '🟡' },
  'DRIFTING':  { bg: BGRED, fg: WHT, emoji: '🟠' },
  'STUCK':     { bg: BGRED, fg: WHT, emoji: '🔴' },
};

// ── Public API ────────────────────────────────────────────────────────────────

export function render(state, prevLines) {
  const cols  = process.stdout.columns || 80;
  const width = Math.min(cols, 76); // total box width incl. borders

  const lines = buildLines(state, width);

  if (prevLines > 0) {
    process.stdout.write(`\x1b[${prevLines}A`);
    for (let i = 0; i < prevLines; i++) process.stdout.write('\x1b[2K\n');
    process.stdout.write(`\x1b[${prevLines}A`);
  }

  process.stdout.write(lines.join('\n') + '\n');
  return lines.length;
}

export function clearScreen() { process.stdout.write('\x1bc'); }
export function renderOnce(state) { render(state, 0); }

// ── Builder ───────────────────────────────────────────────────────────────────

function buildLines(state, width) {
  const {
    goal        = '(auto-detecting…)',
    assessment  = null,
    events      = [],
    startTime   = Date.now(),
    projectSlug = '',
  } = state;

  const toolCalls  = events.filter(e => e.type === 'tool_call');
  const stepCount  = toolCalls.length;
  const errorCount = toolCalls.filter(e => e.failed).length;
  const elapsed    = Date.now() - startTime;
  const score      = assessment?.score  ?? null;
  const status     = assessment?.status ?? (stepCount === 0 ? 'STARTING' : 'ON TRACK');
  const reason     = assessment?.reason ?? '';
  const suggestion = assessment?.suggestion ?? null;
  const assessedAt = assessment?.assessedAt ?? null;
  const style      = STATUS_STYLE[status] ?? STATUS_STYLE['ON TRACK'];
  const project    = projectSlug.split('-').slice(-2).join('-') || 'session';

  const inner = width - 2; // inner width (between │ borders)
  const out   = [];

  // ── Header ─────────────────────────────────────────────────────────────────
  const title = ` session-monitor  ·  ${project}  ·  ${fmtTime(new Date())} `;
  out.push(B + CYN + '╔' + '═'.repeat(width - 2) + '╗' + R);
  out.push(B + CYN + '║' + centerStr(title, width - 2) + '║' + R);
  out.push(B + CYN + '╚' + '═'.repeat(width - 2) + '╝' + R);

  // ── Goal ───────────────────────────────────────────────────────────────────
  out.push('');
  out.push(' ' + D + 'Goal ' + R + B + trunc(goal, width - 7) + R);

  // ── Status box ─────────────────────────────────────────────────────────────
  out.push('');
  out.push(boxTop('Status', width, CYN));

  const scoreStr = score !== null ? `  ${score}/100` : '';
  const badge    = ` ${style.emoji} ${B}${status}${scoreStr}${R} `;
  out.push(boxLine(' ' + style.bg + style.fg + badge + R, inner));
  if (reason)     out.push(boxLine(' ' + D + trunc(reason, inner - 2) + R, inner));
  if (suggestion) out.push(boxLine(' ' + YLW + '→ ' + trunc(suggestion, inner - 3) + R, inner));

  // Momentum bar
  const barW  = inner - 18;
  const fill  = score !== null ? Math.round((score / 100) * barW) : 0;
  const bar   = scoreColor(score) + '█'.repeat(fill) + R + D + '░'.repeat(barW - fill) + R;
  const slbl  = score !== null ? `${score.toString().padStart(3)}/100` : '---/100';
  out.push(boxLine(` ${D}Momentum${R} ${bar} ${D}${slbl}${R}`, inner));
  out.push(boxBottom(width, CYN));

  // ── Timeline ───────────────────────────────────────────────────────────────
  out.push('');
  const STEP_W    = 3;  // chars per step: "X  " or "██ "
  const maxSteps  = Math.floor((inner - 2) / STEP_W);
  const recent    = toolCalls.slice(-maxSteps);
  const stepLabel = `Timeline · last ${recent.length} of ${stepCount} steps`;

  out.push(boxTop(stepLabel, width, YLW));

  if (recent.length === 0) {
    out.push(boxLine(D + '  waiting for tool calls…' + R, inner));
  } else {
    // Row 1: colored letters
    let letterRow = ' ';
    for (const ev of recent) {
      const t      = TOOL[ev.tool?.name] ?? { l: '?', c: D };
      const col    = ev.failed ? RED : t.c;
      const letter = t.l;
      letterRow += col + B + letter + R + '  ';
    }
    out.push(boxLine(letterRow, inner));

    // Row 2: colored block bars
    let blockRow = ' ';
    for (const ev of recent) {
      const t   = TOOL[ev.tool?.name] ?? { l: '?', c: D };
      const col = ev.failed ? RED : t.c;
      const blk = ev.failed ? RED + B + '✗✗' + R : col + '██' + R;
      blockRow += blk + ' ';
    }
    out.push(boxLine(blockRow, inner));

    // Row 3: step number markers every 5
    let numRow = ' ';
    for (let i = 0; i < recent.length; i++) {
      const globalStep = stepCount - recent.length + i + 1;
      if (i === 0 || globalStep % 5 === 0) {
        const lbl = String(globalStep);
        numRow += D + lbl + R + ' '.repeat(STEP_W - lbl.length);
      } else {
        numRow += ' '.repeat(STEP_W);
      }
    }
    out.push(boxLine(numRow, inner));
  }

  // Legend inside timeline box
  const legendParts = Object.entries(TOOL)
    .filter(([, v]) => v.label !== 'Glob')  // merge Glob/Read display
    .map(([, v]) => `${v.c}${v.l}${R}=${D}${v.label}${R}`)
    .join('  ');
  out.push(boxLine(' ' + legendParts, inner));
  out.push(boxBottom(width, YLW));

  // ── File activity ──────────────────────────────────────────────────────────
  const fileCounts = countFiles(toolCalls);
  if (fileCounts.length > 0) {
    out.push('');
    out.push(boxTop('File Activity', width, GRN));

    const maxCount = fileCounts[0][1];
    const barMax   = inner - 26;
    for (const [file, count] of fileCounts.slice(0, 5)) {
      const barLen = Math.round((count / maxCount) * barMax);
      const fname  = trunc(shortPath(file), 20).padEnd(20);
      const bar    = GRN + '█'.repeat(barLen) + R + D + '░'.repeat(barMax - barLen) + R;
      const cnt    = D + `${count}`.padStart(2) + R;
      out.push(boxLine(` ${B}${fname}${R} ${bar} ${cnt}`, inner));
    }
    out.push(boxBottom(width, GRN));
  }

  // ── Tool mix ───────────────────────────────────────────────────────────────
  if (stepCount > 0) {
    out.push('');
    out.push(boxTop('Tool Mix', width, MGT));

    const counts = countTools(toolCalls);
    const half   = Math.ceil(counts.length / 2);
    const colW   = Math.floor(inner / 2) - 1;
    const mbarW  = 8;

    for (let i = 0; i < half; i++) {
      let line = ' ';
      for (const idx of [i, i + half]) {
        if (idx >= counts.length) { line += ' '.repeat(colW); continue; }
        const [name, cnt] = counts[idx];
        const pct   = Math.round((cnt / stepCount) * 100);
        const t     = TOOL[name] ?? { c: D, label: trunc(name, 9) };
        const fill  = Math.round(pct / 100 * mbarW);
        const mbar  = t.c + '█'.repeat(fill) + R + D + '░'.repeat(mbarW - fill) + R;
        const lbl   = trunc(t.label ?? name, 9).padEnd(9);
        const part  = `${t.c}${lbl}${R} ${mbar} ${D}${String(pct).padStart(3)}%${R}`;
        const visLen = stripAnsi(part).length;
        line += part + ' '.repeat(Math.max(0, colW - visLen));
        if (idx === i && i + half < counts.length) line += D + '│' + R + ' ';
      }
      out.push(boxLine(line, inner));
    }
    out.push(boxBottom(width, MGT));
  }

  // ── Footer bar ─────────────────────────────────────────────────────────────
  const last      = toolCalls[toolCalls.length - 1];
  const lastLabel = last
    ? `${last.tool?.name ?? '?'} → ${getDetail(last)} (${timeAgo(last.timestamp)})`
    : 'waiting for first tool call…';

  out.push('');
  out.push(' ' + D + 'Last  ' + R + CYN + trunc(lastLabel, width - 8) + R);

  const stats = [
    B + `Step ${stepCount}` + R,
    msToHuman(elapsed),
    errorCount > 0 ? RED + `${errorCount} ✗` + R : GRN + '0 ✗' + R,
    assessedAt ? D + `assessed ${timeAgo(assessedAt)}` + R : D + 'heuristic only' + R,
  ].join(D + '  ·  ' + R);
  out.push(' ' + stats);

  out.push('');
  out.push(D + ' ' + '─'.repeat(width - 2) + R);
  out.push(D + "  'g' update goal  ·  Ctrl+C stop" + R);

  return out;
}

// ── Box helpers ───────────────────────────────────────────────────────────────

function boxTop(title, width, col = D) {
  const inner = width - 2;
  const t     = title ? `─ ${title} ` : '';
  const rem   = inner - t.length;
  return col + '┌' + t + '─'.repeat(Math.max(0, rem)) + '┐' + R;
}

function boxBottom(width, col = D) {
  return col + '└' + '─'.repeat(width - 2) + '┘' + R;
}

/** Wrap content in │ borders, padding to exactly innerWidth visible chars */
function boxLine(content, innerWidth) {
  const vis = stripAnsi(content).length;
  const pad = Math.max(0, innerWidth - vis);
  return '│' + content + ' '.repeat(pad) + '│';
}

// ── Data helpers ──────────────────────────────────────────────────────────────

/** Count edits+writes per file, sorted desc */
function countFiles(toolCalls) {
  const map = new Map();
  for (const ev of toolCalls) {
    const name = ev.tool?.name;
    if (name !== 'Edit' && name !== 'Write') continue;
    const fp = ev.tool?.input?.file_path ?? ev.tool?.input?.notebook_path ?? '';
    if (!fp) continue;
    map.set(fp, (map.get(fp) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

/** Count occurrences per tool type, sorted desc */
function countTools(toolCalls) {
  const map = new Map();
  for (const ev of toolCalls) {
    const n = ev.tool?.name ?? '?';
    map.set(n, (map.get(n) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function getDetail(ev) {
  const name  = ev.tool?.name ?? '';
  const input = ev.tool?.input ?? {};
  switch (name) {
    case 'Bash':    return trunc(input.command ?? '', 38);
    case 'Edit':
    case 'Write':
    case 'Read':    return shortPath(input.file_path ?? input.notebook_path ?? '');
    case 'Glob':    return input.pattern ?? '';
    case 'Grep':    return `"${trunc(input.pattern ?? '', 28)}"`;
    case 'WebFetch':return trunc(input.url ?? '', 38);
    default:        return '';
  }
}

function shortPath(p) {
  if (!p) return '';
  const parts = p.split('/');
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
}

function centerStr(str, width) {
  const vis = stripAnsi(str).length;
  const pad = Math.max(0, width - vis);
  return ' '.repeat(Math.floor(pad / 2)) + str + ' '.repeat(pad - Math.floor(pad / 2));
}

function trunc(str, max) {
  if (str == null || max <= 0) return '';
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

function stripAnsi(str) {
  return (str ?? '').replace(/\x1b\[[0-9;]*m/g, '');
}

function fmtTime(d) {
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

function scoreColor(score) {
  if (score === null) return D;
  if (score >= 80) return GRN;
  if (score >= 60) return YLW;
  if (score >= 40) return MGT;
  return RED;
}
