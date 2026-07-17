import path from 'node:path';
import type { AgentMessage } from '../types.js';

type Payload = Record<string, unknown>;

const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

export function mapHookPayload(value: unknown): AgentMessage | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as Payload;
  const cwd = text(payload.cwd);
  if (!cwd) return null;
  const ts = new Date().toISOString();
  const codexType = text(payload.type);
  if (codexType === 'agent-turn-complete') {
    return {
      ts,
      agent: `codex:${text(payload['thread-id']) ?? 'unknown'}`,
      repo: cwd,
      event: 'status',
      status: 'idle',
      message: text(payload['last-assistant-message']),
    };
  }

  const event = text(payload.hook_event_name);
  const agent = `claude:${text(payload.session_id) ?? 'unknown'}`;
  if (event === 'SessionStart') return { ts, agent, repo: cwd, event: 'session_start', status: 'idle' };
  if (event === 'Notification') {
    return { ts, agent, repo: cwd, event: 'status', status: 'waiting_input', message: text(payload.message) };
  }
  if (event === 'PreToolUse') return { ts, agent, repo: cwd, event: 'status', status: 'working' };
  if (event === 'PostToolUse' && (payload.tool_name === 'Edit' || payload.tool_name === 'Write')) {
    const input = payload.tool_input as Payload | undefined;
    const file = text(input?.file_path);
    const message: AgentMessage = { ts, agent, repo: cwd, event: 'claim' };
    if (file) message.files = [path.relative(cwd, file)];
    return message;
  }
  if (event === 'Stop') {
    return {
      ts, agent, repo: cwd, event: 'done', status: 'idle',
      message: text(payload.last_assistant_message), summary: text(payload.last_assistant_message),
    };
  }
  return null;
}
