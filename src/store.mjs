// src/store.mjs — find active Claude Code session transcripts + goal/PID storage

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
export const MONITOR_DIR  = path.join(os.homedir(), '.session-monitor');

export function cwdToSlug(cwd) {
  return cwd.replace(/\//g, '-');
}

/**
 * Returns the most recently modified session for the given cwd.
 * @returns {{ sessionId, transcriptPath, projectSlug } | null}
 */
export function latestSession(cwd) {
  const slug = cwdToSlug(cwd);
  const dir  = path.join(CLAUDE_PROJECTS_DIR, slug);
  if (!fs.existsSync(dir)) return null;

  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      const transcriptPath = path.join(dir, f);
      return {
        sessionId:      f.replace('.jsonl', ''),
        transcriptPath,
        projectSlug:    slug,
        mtime:          fs.statSync(transcriptPath).mtime.getTime(),
      };
    })
    .sort((a, b) => b.mtime - a.mtime);

  const found = files[0] ?? null;
  return found ? { sessionId: found.sessionId, transcriptPath: found.transcriptPath, projectSlug: found.projectSlug } : null;
}

/**
 * Find a session by ID prefix across all projects, optionally scoped to cwd.
 * @returns {{ sessionId, transcriptPath, projectSlug } | null}
 */
export function findSession(idPrefix, cwd) {
  const searchDirs = [];

  if (cwd) {
    const slug = cwdToSlug(cwd);
    const d = path.join(CLAUDE_PROJECTS_DIR, slug);
    if (fs.existsSync(d)) searchDirs.push({ dir: d, slug });
  }

  if (searchDirs.length === 0 && fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    for (const slug of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
      const d = path.join(CLAUDE_PROJECTS_DIR, slug);
      if (fs.statSync(d).isDirectory()) searchDirs.push({ dir: d, slug });
    }
  }

  for (const { dir, slug } of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const sessionId = f.replace('.jsonl', '');
      if (sessionId.startsWith(idPrefix)) {
        return { sessionId, transcriptPath: path.join(dir, f), projectSlug: slug };
      }
    }
  }
  return null;
}

// ── Goal storage ──────────────────────────────────────────────────────────

export function goalPath(sessionId) {
  return path.join(MONITOR_DIR, sessionId, 'goal.txt');
}

export function readGoal(sessionId) {
  const p = goalPath(sessionId);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : null;
}

export function writeGoal(sessionId, goal) {
  const dir = path.join(MONITOR_DIR, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(goalPath(sessionId), goal, 'utf8');
}

// ── PID file (per-session) ────────────────────────────────────────────────

function pidFile(sessionId) {
  return path.join(MONITOR_DIR, sessionId, 'monitor.pid');
}

export function writePid(sessionId, pid) {
  const dir = path.join(MONITOR_DIR, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pidFile(sessionId), String(pid), 'utf8');
}

export function readPid(sessionId) {
  const p = pidFile(sessionId);
  if (!fs.existsSync(p)) return null;
  return parseInt(fs.readFileSync(p, 'utf8').trim(), 10);
}

export function clearPid(sessionId) {
  const p = pidFile(sessionId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
