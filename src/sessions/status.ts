import type { AgentType, SessionStatus, StatusSource } from '../types.js';

export interface StatusSignal { status: SessionStatus; at: number }
export interface StatusInputs {
  alive: boolean;
  now: number;
  hook?: StatusSignal;
  output?: StatusSignal;
  cpu?: { percent: number; sustained: boolean };
  hookStaleMs?: number;
}

export function reduceStatus(inputs: StatusInputs): { status: SessionStatus; statusSource: StatusSource } {
  if (!inputs.alive) return { status: 'exited', statusSource: 'process_gone' };
  const hookStaleMs = inputs.hookStaleMs ?? 10 * 60_000;
  if (inputs.hook && inputs.now - inputs.hook.at <= hookStaleMs) {
    return { status: inputs.hook.status, statusSource: 'hook' };
  }
  if (inputs.output) return { status: inputs.output.status, statusSource: 'output_heuristic' };
  if (inputs.cpu) {
    return { status: inputs.cpu.percent > 3 && inputs.cpu.sustained ? 'working' : 'idle', statusSource: 'cpu_heuristic' };
  }
  return { status: 'unknown', statusSource: 'cpu_heuristic' };
}

export function inferOutputStatus(agent: AgentType, data: string): SessionStatus | undefined {
  if (/trust this folder|Trusting the directory/i.test(data)) return 'waiting_input';
  if (agent === 'claude') {
    if (/Crunched for \d|❯ /.test(data)) return 'idle';
    if (/[✶✻✽✳·✢]|\u001b\]0;[⠂⠄⠆⠇⠋⠙⠹⠸⠼⠴⠦⠧]/.test(data)) return 'working';
  } else {
    if (/› /.test(data)) return 'idle';
    if (/\u001b\]0;[⠂⠄⠆⠇⠋⠙⠹⠸⠼⠴⠦⠧]/.test(data)) return 'working';
  }
  return undefined;
}
