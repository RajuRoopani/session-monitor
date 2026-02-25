// src/tail.mjs — poll a JSONL file for new entries as it grows
// Uses fs.stat polling (NOT fs.watch — unreliable on macOS for appended files)

import fs from 'node:fs';
import readline from 'node:readline';

/**
 * Start tailing a JSONL file. Calls onEntry for each new JSON object.
 * Returns a stop function.
 *
 * @param {string}   filePath  — absolute path to .jsonl transcript
 * @param {Function} onEntry   — called with each new parsed JSON entry
 * @param {number}   interval  — poll interval in ms (default 500)
 */
export function tailJsonl(filePath, onEntry, interval = 500) {
  let lastByteOffset = 0;
  let polling = true;

  // Seek to end on first start so we only get NEW entries (don't replay history)
  // Caller can pass initialOffset=0 to replay from beginning
  try {
    lastByteOffset = fs.statSync(filePath).size;
  } catch { /* file may not exist yet */ }

  async function poll() {
    if (!polling) return;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > lastByteOffset) {
        const newEntries = await readFrom(filePath, lastByteOffset);
        lastByteOffset = stat.size;
        for (const entry of newEntries) onEntry(entry);
      }
    } catch { /* file temporarily unavailable */ }

    if (polling) setTimeout(poll, interval);
  }

  setTimeout(poll, interval);

  return () => { polling = false; };
}

/**
 * Read all JSONL entries from a given byte offset to EOF.
 */
export function readFrom(filePath, startByte) {
  return new Promise((resolve) => {
    const entries = [];
    try {
      const stream = fs.createReadStream(filePath, { start: startByte, encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', line => {
        const t = line.trim();
        if (!t) return;
        try { entries.push(JSON.parse(t)); } catch { /* skip malformed */ }
      });
      rl.on('close', () => resolve(entries));
      rl.on('error', () => resolve(entries));
    } catch {
      resolve(entries);
    }
  });
}

/**
 * Read ALL entries from a file from byte 0 (for initial state load).
 */
export function readAll(filePath) {
  return readFrom(filePath, 0);
}
