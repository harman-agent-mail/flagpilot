// Accountability log — hash-chained, tamper-evident action log.
// Same wire format as cardtool's accountability engine
// (cardtool-accountability/1), so the same verifier works on both logs:
//   hash = sha256(canonical_json({seq, ts, action, detail, prev}))
//   prev = previous entry's hash; genesis prev = 64 zeros.
// Canonical JSON: keys sorted, no whitespace (JSON.stringify of an object
// built in sorted-key order). Every proposal and every approval/rejection
// FlagPilot makes is appended here, so a team can later prove who
// approved what, and when.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const GENESIS_PREV = "0".repeat(64);

export interface LogEntry {
  seq: number;
  ts: string;
  action: string;
  detail: string;
  prev: string;
  hash: string;
}

export function canonical(entry: Omit<LogEntry, "hash">): string {
  // Keys in sorted order: action, detail, prev, seq, ts.
  return JSON.stringify({
    action: entry.action,
    detail: entry.detail,
    prev: entry.prev,
    seq: entry.seq,
    ts: entry.ts,
  });
}

export function entryHash(entry: Omit<LogEntry, "hash">): string {
  return createHash("sha256").update(canonical(entry)).digest("hex");
}

export function readLog(path: string): LogEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as LogEntry);
}

export function appendEntry(
  path: string,
  action: string,
  detail: string,
): LogEntry {
  const entries = readLog(path);
  const entry: Omit<LogEntry, "hash"> = {
    seq: entries.length + 1,
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    action,
    detail,
    prev: entries.length === 0 ? GENESIS_PREV : entries[entries.length - 1].hash,
  };
  const full: LogEntry = { ...entry, hash: entryHash(entry) };
  writeFileSync(path, JSON.stringify(full) + "\n", { flag: "a" });
  return full;
}

export function verifyLog(path: string): { ok: boolean; entries: number; error?: string } {
  const entries = readLog(path);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    for (const f of ["seq", "ts", "action", "detail", "prev", "hash"] as const) {
      if (e[f] === undefined) {
        return { ok: false, entries: entries.length, error: `entry ${i + 1}: missing field ${f}` };
      }
    }
    const expectedPrev = i === 0 ? GENESIS_PREV : entries[i - 1].hash;
    if (e.prev !== expectedPrev) {
      return { ok: false, entries: entries.length, error: `entry ${i + 1}: prev link mismatch` };
    }
    if (entryHash(e) !== e.hash) {
      return { ok: false, entries: entries.length, error: `entry ${i + 1}: hash mismatch — content altered after writing` };
    }
  }
  return { ok: true, entries: entries.length };
}
