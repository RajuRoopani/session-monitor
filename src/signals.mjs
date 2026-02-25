// src/signals.mjs — heuristic signal detectors (no API cost, always-on)

/**
 * Analyze a rolling window of recent events and return signal flags.
 * @param {object[]} events  — recent timeline events (last 20-30)
 * @param {string}   goal    — original user goal text
 */
export function detectSignals(events, goal) {
  const toolCalls = events.filter(e => e.type === 'tool_call');
  const recent    = toolCalls.slice(-15);

  return {
    loop:          detectLoop(recent),
    stuckOnFile:   detectStuckOnFile(recent),
    errorStreak:   detectErrorStreak(recent),
    paralysis:     detectParalysis(recent),
    scopeCreep:    detectScopeCreep(recent, goal),
    goodMomentum:  detectGoodMomentum(recent),
    noProgress:    detectNoProgress(events),
  };
}

/** Same Bash command run 3+ times in the last 10 */
function detectLoop(recent) {
  const cmds = recent
    .filter(e => e.tool?.name === 'Bash')
    .map(e => (e.tool.input.command || '').trim().substring(0, 80));

  const counts = {};
  for (const c of cmds) counts[c] = (counts[c] ?? 0) + 1;
  const worst = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (worst && worst[1] >= 3) return { detected: true, command: worst[0], count: worst[1] };
  return { detected: false };
}

/** Same file edited 5+ times with no Bash in between */
function detectStuckOnFile(recent) {
  const edits = recent.filter(e => ['Edit', 'Write'].includes(e.tool?.name));
  if (edits.length < 5) return { detected: false };

  const fileCounts = {};
  for (const e of edits) {
    const f = e.tool.input.file_path ?? '';
    fileCounts[f] = (fileCounts[f] ?? 0) + 1;
  }
  const worst = Object.entries(fileCounts).sort((a, b) => b[1] - a[1])[0];
  if (worst && worst[1] >= 5) return { detected: true, file: worst[0], count: worst[1] };
  return { detected: false };
}

/** 3+ consecutive failed tool calls */
function detectErrorStreak(recent) {
  let streak = 0;
  let maxStreak = 0;
  for (const e of recent) {
    if (e.failed) { streak++; maxStreak = Math.max(maxStreak, streak); }
    else streak = 0;
  }
  return { detected: maxStreak >= 3, streak: maxStreak };
}

/** 8+ Read/Glob/Grep with no Edit/Write (analysis paralysis) */
function detectParalysis(recent) {
  const readTools = new Set(['Read', 'Glob', 'Grep', 'WebFetch']);
  const writeTools = new Set(['Edit', 'Write']);

  let readCount = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const name = recent[i].tool?.name;
    if (writeTools.has(name)) break;
    if (readTools.has(name)) readCount++;
  }
  return { detected: readCount >= 8, count: readCount };
}

/** Files being edited outside what the goal implies */
function detectScopeCreep(recent, goal) {
  if (!goal) return { detected: false };

  // Extract keywords from goal to identify expected file paths
  const goalWords = goal.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const editedFiles = recent
    .filter(e => ['Edit', 'Write'].includes(e.tool?.name))
    .map(e => (e.tool.input.file_path ?? '').toLowerCase());

  const unrelated = editedFiles.filter(f =>
    !goalWords.some(w => f.includes(w)) &&
    !f.includes('test') && !f.includes('spec') && !f.includes('config')
  );

  return {
    detected: unrelated.length >= 3,
    files:    [...new Set(unrelated)].slice(0, 3),
  };
}

/** Edit/Write followed by passing Bash = good pattern */
function detectGoodMomentum(recent) {
  let goodPatterns = 0;
  for (let i = 0; i < recent.length - 1; i++) {
    const curr = recent[i];
    const next = recent[i + 1];
    if (
      ['Edit', 'Write'].includes(curr.tool?.name) &&
      next.tool?.name === 'Bash' &&
      !next.failed
    ) {
      goodPatterns++;
    }
  }
  return { detected: goodPatterns >= 2, count: goodPatterns };
}

/** No Edit/Write at all in last 20 events */
function detectNoProgress(events) {
  const recent = events.slice(-20);
  const hasWrite = recent.some(e => ['Edit', 'Write'].includes(e.tool?.name));
  return { detected: !hasWrite && recent.length >= 10 };
}

/** Convert signals to a human-readable summary for Claude API */
export function signalSummary(signals) {
  const parts = [];
  if (signals.loop.detected)       parts.push(`Loop: "${signals.loop.command}" run ${signals.loop.count}x`);
  if (signals.stuckOnFile.detected) parts.push(`Stuck: editing ${signals.stuckOnFile.file} ${signals.stuckOnFile.count}x`);
  if (signals.errorStreak.detected) parts.push(`Error streak: ${signals.errorStreak.streak} consecutive failures`);
  if (signals.paralysis.detected)   parts.push(`Analysis paralysis: ${signals.paralysis.count} reads with no edits`);
  if (signals.scopeCreep.detected)  parts.push(`Scope creep: editing ${signals.scopeCreep.files.join(', ')}`);
  if (signals.goodMomentum.detected) parts.push(`Good momentum: ${signals.goodMomentum.count} edit→test cycles`);
  if (signals.noProgress.detected)  parts.push('No file edits in last 20 steps');
  return parts.length ? parts.join('; ') : 'No anomalies detected';
}

/** Quick heuristic score (0-100) based purely on signals — no API needed */
export function heuristicScore(signals) {
  let score = 70; // base
  if (signals.loop.detected)        score -= 25;
  if (signals.stuckOnFile.detected) score -= 20;
  if (signals.errorStreak.detected) score -= 30;
  if (signals.paralysis.detected)   score -= 20;
  if (signals.scopeCreep.detected)  score -= 15;
  if (signals.noProgress.detected)  score -= 20;
  if (signals.goodMomentum.detected) score += 20;
  return Math.max(0, Math.min(100, score));
}
