#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const forwardIndex = args.indexOf('--forward-base64');
const encoded = forwardIndex >= 0 ? args[forwardIndex + 1] : undefined;
const payloadArg = forwardIndex >= 0 ? args[forwardIndex + 2] : args[0];
const input = payloadArg ?? fs.readFileSync(0, 'utf8');

try {
  const payload = JSON.parse(input);
  const cwd = payload.cwd;
  if (typeof cwd === 'string' && payload.hook_event_name === 'UserPromptSubmit') {
    // Deliver queued dashboard messages as context for this turn.
    const repo = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const inbox = path.join(repo, '.agents', 'inbox.jsonl');
    if (fs.existsSync(inbox)) {
      const texts = fs.readFileSync(inbox, 'utf8').split('\n').flatMap((line) => {
        if (!line.trim()) return [];
        try {
          const entry = JSON.parse(line);
          return typeof entry.text === 'string' ? [entry.text] : [];
        } catch { return []; }
      });
      if (texts.length > 0) {
        fs.writeFileSync(inbox, '');
        console.log(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: `Messages sent by the user from the AgentDeck dashboard:\n${texts.map((t) => `- ${t}`).join('\n')}`,
          },
        }));
      }
    }
  }
  if (typeof cwd === 'string') {
    let message;
    if (payload.type === 'agent-turn-complete') {
      message = { ts: new Date().toISOString(), agent: `codex:${payload['thread-id'] ?? 'unknown'}`, repo: cwd, event: 'status', status: 'idle', message: payload['last-assistant-message'] };
    } else {
      const agent = `claude:${payload.session_id ?? 'unknown'}`;
      const event = payload.hook_event_name;
      if (event === 'Notification') message = { ts: new Date().toISOString(), agent, repo: cwd, event: 'status', status: 'waiting_input', message: payload.message };
      else if (event === 'PreToolUse') message = { ts: new Date().toISOString(), agent, repo: cwd, event: 'status', status: 'working' };
      else if (event === 'PostToolUse' && ['Edit', 'Write'].includes(payload.tool_name)) message = { ts: new Date().toISOString(), agent, repo: cwd, event: 'claim', files: payload.tool_input?.file_path ? [path.relative(cwd, payload.tool_input.file_path)] : [] };
      else if (event === 'Stop') message = { ts: new Date().toISOString(), agent, repo: cwd, event: 'done', status: 'idle', message: payload.last_assistant_message, summary: payload.last_assistant_message };
      else if (event === 'SessionStart') message = { ts: new Date().toISOString(), agent, repo: cwd, event: 'session_start', status: 'idle' };
    }
    if (message) {
      const repo = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
      fs.mkdirSync(path.join(repo, '.agents'), { recursive: true });
      fs.appendFileSync(path.join(repo, '.agents', 'bus.jsonl'), `${JSON.stringify({ ...message, repo })}\n`, { flag: 'a' });
    }
  }
} catch (error) {
  console.error(`[agentdeck-hook] ${error instanceof Error ? error.message : String(error)}`);
}

if (encoded) {
  try {
    const previous = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    if (Array.isArray(previous) && previous.every((item) => typeof item === 'string')) {
      spawnSync(previous[0], [...previous.slice(1), input], { stdio: 'ignore' });
    }
  } catch {}
}
