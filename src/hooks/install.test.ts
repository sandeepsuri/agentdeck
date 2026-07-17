import { describe, expect, it } from 'vitest';
import {
  mergeClaudeSettings,
  removeClaudeSettings,
  installCodexNotify,
  shellQuote,
  uninstallCodexNotify,
} from './install.js';

describe('hook config merging', () => {
  it('preserves existing Claude hooks and removes only AgentDeck entries', () => {
    const raw = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing-hook' }] }] }, untouched: { yes: true } }, null, 2);
    const installed = mergeClaudeSettings(raw, 'node /agentdeck/bin/agentdeck-hook');
    const parsed = JSON.parse(installed) as { hooks: Record<string, unknown[]>; untouched: { yes: boolean } };
    expect(JSON.stringify(parsed)).toContain('existing-hook');
    expect(parsed.hooks.Notification).toHaveLength(1);
    expect(parsed.hooks.PostToolUse).toHaveLength(1);
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
    expect(parsed.untouched).toEqual({ yes: true });
    expect(removeClaudeSettings(installed)).not.toContain('agentdeck-hook');
    expect(removeClaudeSettings(installed)).toContain('existing-hook');
  });

  it('chains and restores an existing Codex notify command', () => {
    const raw = 'model = "gpt"\nnotify = ["node", "/existing.js", "turn-ended"]\nother = true\n';
    const installed = installCodexNotify(raw, '/agentdeck/bin/agentdeck-hook');
    expect(installed).toContain('agentdeck-hook');
    expect(installed).toContain('agentdeck-previous-notify:');
    expect(uninstallCodexNotify(installed)).toBe(raw);
  });

  it('shell-quotes hook paths without allowing command substitution', () => {
    expect(shellQuote("/tmp/a'$(touch bad)/hook.mjs"))
      .toBe("'/tmp/a'\\''$(touch bad)/hook.mjs'");
  });
});
