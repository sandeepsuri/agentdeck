// On-disk storage for a session's wrap-up summary: sessions/<id>/summary.md,
// parallel to scrollback.txt (transcript.ts). Kept as its own small module
// rather than folded into SessionTranscript, which owns terminal *output*
// bytes only — a summary is a distinct artifact produced on demand by a
// Summarizer, not replayed PTY output. See "Storage" in
// docs/specs/session-persistence-and-remote-access.md.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sessionDir } from './transcript.js';

export function summaryFilePath(sessionsDir: string, sessionId: string): string {
  return path.join(sessionDir(sessionsDir, sessionId), 'summary.md');
}

/** Previously generated summary for a session; undefined if none exists yet. */
export async function readSummary(sessionsDir: string, sessionId: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(summaryFilePath(sessionsDir, sessionId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Persist a (re)generated summary, overwriting any previous one. Callers
 * (SessionManager.summarize()) must only call this once the new summary
 * text is already in hand — never before, so a failed regeneration leaves
 * the previous summary.md completely untouched.
 */
export async function writeSummary(sessionsDir: string, sessionId: string, text: string): Promise<void> {
  const dir = sessionDir(sessionsDir, sessionId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(summaryFilePath(sessionsDir, sessionId), text, 'utf8');
}
