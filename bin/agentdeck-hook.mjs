#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Claude Code's Stop payload carries a transcript_path, not the reply text
// itself; pull the latest assistant message out of the transcript tail.
function lastAssistantText(transcriptPath) {
  try {
    const stat = fs.statSync(transcriptPath);
    const length = Math.min(stat.size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, stat.size - length);
    } finally {
      fs.closeSync(fd);
    }
    const lines = buffer.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type !== 'assistant') continue;
        const content = entry.message?.content;
        const text = (Array.isArray(content) ? content : [])
          .filter((item) => item?.type === 'text' && typeof item.text === 'string')
          .map((item) => item.text)
          .join('\n')
          .trim();
        if (text) return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
      } catch { /* partial first line of the tail window */ }
    }
  } catch { /* transcript missing or unreadable */ }
  return undefined;
}

// The hook is a short-lived child of the CLI. Capture only numeric ancestry
// and the first usable TTY so AgentDeck can bind external hooks without
// guessing based on repository or start time.
function processContext() {
  const sourcePids = [];
  let tty;
  let pid = process.ppid;
  for (let depth = 0; pid > 1 && depth < 16; depth++) {
    try {
      const line = execFileSync('ps', ['-o', 'pid=,ppid=,tty=', '-p', String(pid)], { encoding: 'utf8' }).trim();
      const match = /^(\d+)\s+(\d+)\s+(\S+)$/.exec(line);
      if (!match) break;
      sourcePids.push(Number(match[1]));
      if (!tty && match[3] !== '??') tty = match[3];
      pid = Number(match[2]);
    } catch {
      break;
    }
  }
  return { sourcePids, ...(tty ? { tty } : {}) };
}

const args = process.argv.slice(2);
const forwardIndex = args.indexOf('--forward-base64');
const encoded = forwardIndex >= 0 ? args[forwardIndex + 1] : undefined;
const payloadArg = forwardIndex >= 0 ? args[forwardIndex + 2] : args[0];
const input = payloadArg ?? fs.readFileSync(0, 'utf8');

try {
  const payload = JSON.parse(input);
  const cwd = payload.cwd;
  const agentSessionId = payload.type === 'agent-turn-complete'
    ? `codex:${payload['thread-id'] ?? 'unknown'}`
    : `claude:${payload.session_id ?? 'unknown'}`;
  if (typeof cwd === 'string' && ['UserPromptSubmit', 'SessionStart'].includes(payload.hook_event_name)) {
    // Deliver queued dashboard messages as context for this turn.
    const repo = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const inbox = path.join(repo, '.agents', 'inbox.jsonl');
    if (fs.existsSync(inbox)) {
      const remaining = [];
      const texts = fs.readFileSync(inbox, 'utf8').split('\n').flatMap((line) => {
        if (!line.trim()) return [];
        try {
          const entry = JSON.parse(line);
          if (entry.to === agentSessionId && typeof entry.text === 'string') return [entry.text];
          remaining.push(line);
          return [];
        } catch {
          remaining.push(line);
          return [];
        }
      });
      if (texts.length > 0) {
        fs.writeFileSync(inbox, remaining.length > 0 ? `${remaining.join('\n')}\n` : '');
        console.log(JSON.stringify({
          systemMessage: `AgentDeck: delivered ${texts.length} dashboard message(s) to the agent: ${texts.map((t) => JSON.stringify(t)).join(', ')}`,
          hookSpecificOutput: {
            hookEventName: payload.hook_event_name,
            additionalContext: `Messages sent by the user from the AgentDeck dashboard:\n${texts.map((t) => `- ${t}`).join('\n')}`,
          },
        }));
      }
    }
  }
  if (typeof cwd === 'string') {
    const correlation = {
      ...processContext(),
      ...(typeof process.env.AGENTDECK_SESSION_ID === 'string'
        ? { sessionId: process.env.AGENTDECK_SESSION_ID }
        : {}),
    };
    let message;
    if (payload.type === 'agent-turn-complete') {
      message = { ts: new Date().toISOString(), agent: agentSessionId, repo: cwd, event: 'message', status: 'idle', message: payload['last-assistant-message'], turnId: payload['turn-id'], ...correlation };
    } else {
      const agent = agentSessionId;
      const event = payload.hook_event_name;
      if (event === 'Notification') message = { ts: new Date().toISOString(), agent, repo: cwd, event: 'status', status: 'waiting_input', message: payload.message, ...correlation };
      else if (event === 'PreToolUse') message = { ts: new Date().toISOString(), agent, repo: cwd, event: 'status', status: 'working', ...correlation };
      else if (event === 'PostToolUse' && ['Edit', 'Write'].includes(payload.tool_name)) message = { ts: new Date().toISOString(), agent, repo: cwd, event: 'claim', files: payload.tool_input?.file_path ? [path.relative(cwd, payload.tool_input.file_path)] : [], ...correlation };
      else if (event === 'Stop') {
        const reply = payload.last_assistant_message
          ?? (typeof payload.transcript_path === 'string' ? lastAssistantText(payload.transcript_path) : undefined);
        message = { ts: new Date().toISOString(), agent, repo: cwd, event: 'done', status: 'idle', message: reply, summary: reply, turnId: payload.prompt_id, ...correlation };
      }
      else if (event === 'SessionStart') message = { ts: new Date().toISOString(), agent, repo: cwd, event: 'session_start', status: 'idle', ...correlation };
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
