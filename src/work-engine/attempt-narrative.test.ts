import { describe, expect, it } from 'vitest';
import type { AttemptEvent } from './types.js';
import {
  describeActivity, describeCommand, describeOutcome, summarizeAttempt,
} from './attempt-narrative.js';

// Verbatim from the Run that prompted this work — a repo-summary Attempt whose
// feed was twenty rows of these, each shown twice, with no answer anywhere.
const REAL_COMMANDS: ReadonlyArray<[string, string]> = [
  [`/bin/zsh -lc "pwd && rg --files -g '!*node_modules*' -g '!*.lock' | sed -n '1,240p'"`, 'Searched the repository for source files'],
  [`/bin/zsh -c 'git status --short git log -5 --oneline --decorate'`, 'Checked recent git history'],
  [`/bin/bash -c "pwd find . -maxdepth 2 -type f | sort | sed -n '1,240p'"`, 'Listed files in the repository'],
  [`/bin/bash -c "sed -n '1,240p' README.md sed -n '1,220p' package.json sed -n '1,280p' src/App.tsx"`, 'Read README.md, package.json, src/App.tsx'],
  ['npm test', 'Ran the tests'],
  ['npm run build', 'Built the project'],
  ['/bin/zsh -lc "npx tsc --noEmit"', 'Checked the project for errors'],
  ['wc -l src/index.ts', 'Counted lines in the repository'],
];

describe('describeCommand', () => {
  for (const [command, expected] of REAL_COMMANDS) {
    it(`reads ${JSON.stringify(command.slice(0, 46))}… as "${expected}"`, () => {
      expect(describeCommand(command)).toBe(expected);
    });
  }

  it('falls back to a plain, true statement rather than guessing at an unfamiliar command', () => {
    // A vague-but-correct label costs one click on the detail toggle; a
    // confident wrong one costs trust in every other label.
    expect(describeCommand('/bin/zsh -lc "hexdump -C /dev/urandom | head"')).toBe('Ran a command');
    expect(describeCommand('')).toBe('Ran a command');
  });

  it('never leaks shell plumbing into the sentence a reader sees', () => {
    for (const [command] of REAL_COMMANDS) {
      const described = describeCommand(command);
      for (const noise of ['/bin/zsh', '/bin/bash', '-lc', '&&', '|', 'sed -n']) {
        expect(described).not.toContain(noise);
      }
    }
  });
});

describe('describeActivity', () => {
  it('describes non-command items by what they did', () => {
    expect(describeActivity('fileChange', 'src/App.tsx src/main.tsx')).toBe('Edited src/App.tsx, src/main.tsx');
    expect(describeActivity('webSearch', 'vitest config')).toBe('Searched the web for “vitest config”');
    expect(describeActivity('mcpToolCall', 'figma/get_screenshot')).toBe('Used the figma/get_screenshot tool');
  });

  it('says something plainly true for a tool type it has no wording for', () => {
    expect(describeActivity('somethingNew')).toBe('Ran a step');
  });
});

function event(partial: Partial<AttemptEvent> & { kind: AttemptEvent['kind']; sequence: number }): AttemptEvent {
  return { at: '2026-09-01T00:00:00.000Z', ...partial } as AttemptEvent;
}

describe('summarizeAttempt', () => {
  const events: AttemptEvent[] = [
    event({ kind: 'lifecycle', sequence: 0, phase: 'attempt-started' } as never),
    event({ kind: 'lifecycle', sequence: 1, phase: 'turn-started' } as never),
    event({ kind: 'tool-activity', sequence: 2, tool: 'commandExecution', status: 'started', summary: 'rg --files' } as never),
    event({ kind: 'tool-activity', sequence: 3, tool: 'commandExecution', status: 'completed', summary: 'rg --files' } as never),
    event({ kind: 'message', sequence: 4, role: 'assistant', text: 'AgentDeck is a local-first control panel.' } as never),
    event({ kind: 'usage', sequence: 5, inputTokens: 4200, outputTokens: 310 } as never),
    event({ kind: 'lifecycle', sequence: 6, phase: 'turn-completed' } as never),
    event({ kind: 'completion', sequence: 7, outcome: 'success' } as never),
  ];

  it('lifts the assistant text out as the answer — the thing the Run was asked for', () => {
    expect(summarizeAttempt(events).answer).toBe('AgentDeck is a local-first control panel.');
  });

  it('shows each step once, not once for starting and again for finishing', () => {
    const { steps } = summarizeAttempt(events);

    expect(steps.map((step) => [step.label, step.status])).toEqual([
      ['Searched the repository for source files', 'completed'],
      ['Wrote its answer', 'completed'],
    ]);
  });

  it('keeps the raw command as detail, so the toggle has something exact to show', () => {
    expect(summarizeAttempt(events).steps[0]!.detail).toBe('rg --files');
  });

  it('keeps a step that started and never finished visible as in-progress', () => {
    const running = summarizeAttempt(events.slice(0, 3));
    expect(running.steps).toEqual([expect.objectContaining({ status: 'started' })]);
    expect(running.outcome).toBeUndefined();
  });

  it('reports the latest cumulative usage', () => {
    expect(summarizeAttempt(events).usage).toEqual({ inputTokens: 4200, outputTokens: 310 });
  });

  it('takes the last assistant message as the answer, treating earlier ones as narration', () => {
    const withNarration = [
      event({ kind: 'message', sequence: 0, role: 'assistant', text: 'Let me look around.' } as never),
      event({ kind: 'message', sequence: 1, role: 'assistant', text: 'Here is the summary.' } as never),
    ];
    expect(summarizeAttempt(withNarration).answer).toBe('Here is the summary.');
  });

  it('surfaces a pending approval as its own readable step', () => {
    const asking = [event({
      kind: 'attention-requested', sequence: 0, attentionId: 'a1', attentionKind: 'approval',
      reason: 'Codex is requesting approval to run: rm -rf node_modules',
    } as never)];
    expect(summarizeAttempt(asking).steps[0]).toMatchObject({
      label: 'Codex is requesting approval to run: rm -rf node_modules', status: 'started',
    });
  });
});

describe('describeOutcome', () => {
  it('never says a failed Run succeeded', () => {
    expect(describeOutcome({ kind: 'failure', detail: 'The sandboxed command exited non-zero.' }))
      .toBe("Didn't finish — The sandboxed command exited non-zero.");
    expect(describeOutcome({ kind: 'success' })).toBe('Completed successfully');
    expect(describeOutcome({ kind: 'no-changes' })).toBe('Completed without changing any files');
    expect(describeOutcome(undefined)).toBeUndefined();
  });
});
