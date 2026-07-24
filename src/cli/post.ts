import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { appendAgentMessage } from '../coordination/bus.js';
import type { AgentMessage } from '../types.js';

const execFileAsync = promisify(execFile);
const EVENTS = new Set<AgentMessage['event']>(['status', 'claim', 'release', 'progress', 'blocked', 'done', 'message', 'session_start', 'session_end']);

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export function parsePostArgs(args: string[], repo: string): AgentMessage {
  const event = valueAfter(args, '--event') as AgentMessage['event'] | undefined;
  if (!event || !EVENTS.has(event)) throw new Error('post requires a valid --event');
  const message: AgentMessage = {
    ts: new Date().toISOString(),
    agent: valueAfter(args, '--agent') ?? process.env.AGENTDECK_AGENT ?? `manual:${os.userInfo().username}`,
    repo,
    event,
  };
  const task = valueAfter(args, '--task');
  const text = valueAfter(args, '-m') ?? valueAfter(args, '--message');
  const files = valueAfter(args, '--files');
  const blockers = valueAfter(args, '--blockers');
  const status = valueAfter(args, '--status') as AgentMessage['status'] | undefined;
  const progressValue = valueAfter(args, '--progress');
  if (task) message.task = task;
  if (text) message.message = text;
  if (files) message.files = files.split(',').map((file) => file.trim()).filter(Boolean);
  if (blockers) message.blockers = blockers.split(',').map((item) => item.trim()).filter(Boolean);
  if (status) message.status = status;
  if (progressValue !== undefined) {
    const progress = Number(progressValue);
    if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
      throw new Error('--progress must be a number from 0 to 100');
    }
    message.progress = progress;
  }
  return message;
}

export async function runPost(args: string[], cwd = process.cwd()): Promise<void> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const repo = stdout.trim();
  await appendAgentMessage(repo, parsePostArgs(args, repo));
}
