// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from './ApprovalCard.js';

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
let host: HTMLDivElement;
let root: Root;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); });

async function render(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(element));
}

describe('ApprovalCard', () => {
  it('shows intent, command, scope, requested access and risk before the decision', async () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    await render(
      <ApprovalCard
        intent="Verify dashboard changes before review."
        onApprove={onApprove}
        onDeny={onDeny}
        reason="Claude is requesting approval to use Bash: npx playwright test dashboard.spec.ts"
        repositoryName="example-web"
        workingDirectory="/worktrees/dashboard"
      />,
    );
    const text = host.textContent ?? '';
    expect(text).toContain('Claude wants permission');
    expect(text).toContain('Run tests');
    expect(host.querySelector('.approval-command')?.textContent).toBe('npx playwright test dashboard.spec.ts');
    expect(text).toContain('Verify dashboard changes before review.');
    expect(text).toContain('Repository: example-web');
    expect(text).toContain('/worktrees/dashboard');
    expect(text).toContain('Network not requested');
    expect(text).toContain('Files requested');
    expect(text).toContain('Risk · Low');

    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'Approve once')!.click(); });
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'Deny')!.click(); });
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  it('keeps an unparsed reason verbatim and rates it conservatively', async () => {
    await render(<ApprovalCard fallbackAgent="Codex" onApprove={vi.fn()} onDeny={vi.fn()} reason="Allow schema migration?" repositoryName="api" />);
    expect(host.textContent).toContain('Codex wants permission');
    expect(host.querySelector('.approval-reason')?.textContent).toBe('Allow schema migration?');
    expect(host.textContent).toContain('Risk · Medium');
  });
});
