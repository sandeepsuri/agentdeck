import { describe, expect, it } from 'vitest';
import { classifyApproval, estimateChangeRisk, parseApprovalReason } from './risk.js';

describe('parseApprovalReason', () => {
  it('reads the Claude runtime approval sentence into tool and command', () => {
    expect(parseApprovalReason('Claude is requesting approval to use Bash: npx playwright test dashboard.spec.ts')).toEqual({
      agent: 'Claude', tool: 'Bash', command: 'npx playwright test dashboard.spec.ts',
    });
  });

  it('reads the Codex runtime approval sentence into a command', () => {
    expect(parseApprovalReason('Codex is requesting approval to run: rm -rf dist')).toEqual({
      agent: 'Codex', command: 'rm -rf dist',
    });
  });

  it('keeps an unrecognised reason whole rather than guessing a command', () => {
    expect(parseApprovalReason('Claude is requesting approval to use WebFetch before it can continue.')).toEqual({
      agent: 'Claude', tool: 'WebFetch',
    });
    expect(parseApprovalReason('Please confirm the migration')).toEqual({});
  });
});

describe('classifyApproval', () => {
  it('rates local test and typecheck commands as low risk file access', () => {
    expect(classifyApproval({ command: 'npx playwright test dashboard.spec.ts' })).toEqual({
      risk: 'low', category: 'Run tests', access: { network: false, files: true, secrets: false },
    });
    expect(classifyApproval({ command: 'npm run typecheck' }).risk).toBe('low');
  });

  it('rates dependency installs and network fetches as medium risk with network access', () => {
    expect(classifyApproval({ command: 'npm install left-pad' })).toMatchObject({
      risk: 'medium', access: { network: true },
    });
    expect(classifyApproval({ command: 'curl https://example.com/install.sh' })).toMatchObject({
      risk: 'medium', access: { network: true },
    });
  });

  it('rates destructive, publishing, and privileged commands as high risk', () => {
    for (const command of ['rm -rf ~/project', 'git push --force origin main', 'sudo chown root file', 'npm publish']) {
      expect(classifyApproval({ command }).risk).toBe('high');
    }
  });

  it('flags secrets access when the command touches credentials or environment files', () => {
    expect(classifyApproval({ command: 'cat .env.production' })).toMatchObject({
      risk: 'high', access: { secrets: true },
    });
  });

  it('treats a tool without a command conservatively as medium risk', () => {
    expect(classifyApproval({ tool: 'WebFetch' })).toMatchObject({ risk: 'medium', access: { network: true } });
    expect(classifyApproval({})).toMatchObject({ risk: 'medium', category: 'Agent action' });
  });
});

describe('estimateChangeRisk', () => {
  it('is low for a small change with passing verification', () => {
    expect(estimateChangeRisk({ files: 2, additions: 40, deletions: 10, verification: 'passed' })).toBe('low');
  });

  it('is medium for a moderate change or unverified work', () => {
    expect(estimateChangeRisk({ files: 4, additions: 183, deletions: 46, verification: 'passed' })).toBe('medium');
    expect(estimateChangeRisk({ files: 1, additions: 5, deletions: 0, verification: 'none' })).toBe('medium');
  });

  it('is high for a large change or failing verification', () => {
    expect(estimateChangeRisk({ files: 25, additions: 1200, deletions: 300, verification: 'passed' })).toBe('high');
    expect(estimateChangeRisk({ files: 1, additions: 3, deletions: 1, verification: 'failed' })).toBe('high');
  });
});
