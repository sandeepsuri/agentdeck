// Checks the protocol assumptions in codex.ts against the schema the Codex
// CLI actually generates (test-fixtures/codex-protocol-snapshot.json, written
// by scripts/snapshot-codex-protocol.mjs).
//
// The hand-written app-server fixture cannot do this job: it was written from
// the same assumptions as the adapter, so it certifies agreement with itself.
// This is the only test in the suite whose evidence comes from outside
// AgentDeck.
import { describe, expect, it } from 'vitest';
import snapshotJson from '../../test-fixtures/codex-protocol-snapshot.json' with { type: 'json' };
import {
  CODEX_PROTOCOL_CONTRACT,
  KNOWN_PROTOCOL_GAPS,
  describeCodexProtocolViolation,
  findCodexProtocolViolations,
  readThreadId,
  type CodexProtocolSnapshot,
} from './codex-protocol.js';

const snapshot = snapshotJson as CodexProtocolSnapshot;

describe('codex app-server protocol conformance', () => {
  it('matches the installed CLI everywhere except the gaps that are explicitly still open', () => {
    const violations = findCodexProtocolViolations(snapshot);
    const detail = violations.map(describeCodexProtocolViolation).join('\n');

    // An equality check, not a subset check: a NEW mismatch fails here, and so
    // does closing a known gap without removing it from KNOWN_PROTOCOL_GAPS.
    expect(
      violations.map((violation) => violation.id).sort(),
      `codex protocol violations (codex-cli ${snapshot.codexVersion}):\n${detail}`,
    ).toEqual(KNOWN_PROTOCOL_GAPS.map((gap) => gap.id).sort());
  });

  it('explains every open gap, so closing one never starts from a bare identifier', () => {
    for (const gap of KNOWN_PROTOCOL_GAPS) {
      expect(CODEX_PROTOCOL_CONTRACT.map((entry) => entry.id)).toContain(gap.id);
      expect(gap.why.length).toBeGreaterThan(40);
    }
    expect(new Set(KNOWN_PROTOCOL_GAPS.map((gap) => gap.id)).size).toBe(KNOWN_PROTOCOL_GAPS.length);
  });

  it('reports an unknown method distinctly from a payload whose shape moved', () => {
    const violations = findCodexProtocolViolations(snapshot, [
      { id: 'gone', surface: 'notification', method: 'thread/sendMessage', expects: ['text'], usedBy: 'test' },
      { id: 'moved', surface: 'response', method: 'thread/start', expects: ['threadId'], usedBy: 'test' },
    ]);

    expect(violations[0]).toMatchObject({ id: 'gone', reason: 'unknown-method' });
    // The exact regression that shipped green: the id moved under `thread`,
    // and the failure should point at where it went.
    expect(violations[1]).toMatchObject({ id: 'moved', reason: 'missing-paths', missing: ['threadId'] });
    expect(violations[1]!.nearby).toContain('thread.id');
  });

  it('pins the contract to a recorded CLI version, so a refresh is a reviewable change', () => {
    expect(snapshot.codexVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(snapshot.clientRequests).toContain('turn/start');
    expect(snapshot.clientRequests).not.toContain('thread/sendMessage');
  });
});

describe('readThreadId', () => {
  it('reads the id from the nested thread the app-server actually returns', () => {
    expect(readThreadId({ thread: { id: 'thread-1', cwd: '/repo' }, model: 'gpt-5' })).toBe('thread-1');
  });

  it('returns undefined for the shapes that would otherwise read as a thread id', () => {
    // The top-level `threadId` the adapter used to read does not exist; a
    // silent fallback to it would hide exactly this class of drift.
    expect(readThreadId({ threadId: 'thread-1' })).toBeUndefined();
    expect(readThreadId({ thread: { id: '' } })).toBeUndefined();
    expect(readThreadId({ thread: null })).toBeUndefined();
    expect(readThreadId({ thread: { id: 42 } })).toBeUndefined();
    expect(readThreadId({})).toBeUndefined();
  });
});
