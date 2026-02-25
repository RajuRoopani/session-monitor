// src/assess.mjs — Claude haiku alignment check (runs every 10 tool calls)

import Anthropic from '@anthropic-ai/sdk';
import { heuristicScore } from './signals.mjs';

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a session monitor for Claude Code. Your job is to assess whether \
the AI agent is on track toward the user's stated goal based on a summary of recent actions.

Respond with ONLY valid JSON — no markdown, no explanation, no code fences:
{
  "score": <integer 0-100>,
  "status": <"ON TRACK" | "HEADS UP" | "DRIFTING" | "STUCK">,
  "reason": <one sentence explanation>,
  "suggestion": <actionable suggestion for the user, or null if on track>
}

Score guide:
- 80-100: ON TRACK — agent is clearly working toward the goal
- 60-79:  HEADS UP — minor drift or inefficiency, but recoverable
- 40-59:  DRIFTING — significant deviation, user should redirect
- 0-39:   STUCK    — agent is looping, failing repeatedly, or lost

Be concise. The reason and suggestion each must be under 120 characters.`;

/**
 * Ask claude-haiku to assess alignment with the goal.
 * @param {string}   goal        — user's stated goal
 * @param {object[]} events      — recent tool_call events
 * @param {object}   signals     — output of detectSignals()
 * @param {string}   signalText  — output of signalSummary()
 * @returns {Promise<{score, status, reason, suggestion}>}
 */
export async function assess(goal, events, signals, signalText) {
  // Build action summary from last 20 tool calls
  const recent = events.filter(e => e.type === 'tool_call').slice(-20);
  const actionLines = recent.map(e => {
    const name = e.tool?.name ?? '?';
    const detail = getDetail(name, e.tool?.input ?? {});
    const status = e.failed ? ' ❌' : '';
    return `  ${name}(${detail})${status}`;
  }).join('\n');

  const userMessage = `Goal: ${goal}

Recent actions (last ${recent.length}):
${actionLines || '  (none yet)'}

Signal analysis: ${signalText}

Is the agent on track? Respond with JSON only.`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const raw = response.content[0]?.text?.trim() ?? '';
    const parsed = JSON.parse(raw);

    return {
      score:      clamp(Number(parsed.score) || 70),
      status:     normalizeStatus(parsed.status),
      reason:     String(parsed.reason ?? '').slice(0, 140),
      suggestion: parsed.suggestion ? String(parsed.suggestion).slice(0, 140) : null,
      source:     'api',
    };
  } catch {
    // Fallback to heuristic score — no API cost
    const score = heuristicScore(signals);
    return {
      score,
      status:     scoreToStatus(score),
      reason:     `API unavailable — using signal heuristics (${signalText})`,
      suggestion: score < 60 ? 'Check the signals and consider redirecting the agent.' : null,
      source:     'heuristic',
    };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function getDetail(toolName, input) {
  switch (toolName) {
    case 'Bash':    return (input.command ?? '').slice(0, 50);
    case 'Edit':
    case 'Write':
    case 'Read':    return shortPath(input.file_path ?? input.notebook_path ?? '');
    case 'Glob':    return input.pattern ?? '';
    case 'Grep':    return `"${(input.pattern ?? '').slice(0, 30)}"`;
    case 'WebFetch':return (input.url ?? '').slice(0, 50);
    case 'Task':    return (input.description ?? '').slice(0, 50);
    default:        return '';
  }
}

function shortPath(p) {
  const parts = p.split('/');
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : p;
}

function clamp(n) { return Math.max(0, Math.min(100, Math.round(n))); }

function normalizeStatus(s) {
  const upper = String(s ?? '').toUpperCase();
  if (upper.includes('ON TRACK'))  return 'ON TRACK';
  if (upper.includes('HEADS UP'))  return 'HEADS UP';
  if (upper.includes('DRIFTING'))  return 'DRIFTING';
  if (upper.includes('STUCK'))     return 'STUCK';
  return 'HEADS UP';
}

function scoreToStatus(score) {
  if (score >= 80) return 'ON TRACK';
  if (score >= 60) return 'HEADS UP';
  if (score >= 40) return 'DRIFTING';
  return 'STUCK';
}
