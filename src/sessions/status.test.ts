import { describe, expect, it } from 'vitest';
import { inferOutputStatus, reduceStatus, type StatusInputs } from './status.js';

const now = Date.parse('2026-07-17T12:00:00.000Z');
const cases: Array<[string, StatusInputs, unknown]> = [
  ['gone wins', { alive: false, now }, { status: 'exited', statusSource: 'process_gone' }],
  ['fresh hook wins output and cpu', { alive: true, now, hook: { status: 'waiting_input', at: now - 1000 }, output: { status: 'working', at: now }, cpu: { percent: 10, sustained: true } }, { status: 'waiting_input', statusSource: 'hook' }],
  ['stale hook falls to output', { alive: true, now, hook: { status: 'idle', at: now - 11 * 60_000 }, output: { status: 'working', at: now } }, { status: 'working', statusSource: 'output_heuristic' }],
  ['output wins cpu', { alive: true, now, output: { status: 'idle', at: now }, cpu: { percent: 20, sustained: true } }, { status: 'idle', statusSource: 'output_heuristic' }],
  ['hot sustained cpu works', { alive: true, now, cpu: { percent: 3.1, sustained: true } }, { status: 'working', statusSource: 'cpu_heuristic' }],
  ['single hot sample stays idle', { alive: true, now, cpu: { percent: 12, sustained: false } }, { status: 'idle', statusSource: 'cpu_heuristic' }],
  ['alive with no signal unknown', { alive: true, now }, { status: 'unknown', statusSource: 'cpu_heuristic' }],
];

describe('reduceStatus', () => {
  it.each(cases)('%s', (_name, inputs, expected) => expect(reduceStatus(inputs)).toEqual(expected));
});

describe('inferOutputStatus', () => {
  it('recognizes trust, spinner/title, and prompt completion signals', () => {
    expect(inferOutputStatus('claude', 'Do you trust this folder?')).toBe('waiting_input');
    expect(inferOutputStatus('claude', '✶ working')).toBe('working');
    expect(inferOutputStatus('claude', 'Crunched for 3s\n❯ ')).toBe('idle');
    expect(inferOutputStatus('codex', '\u001b]0;⠸ repo\u0007')).toBe('working');
    expect(inferOutputStatus('codex', '› ')).toBe('idle');
  });
});
