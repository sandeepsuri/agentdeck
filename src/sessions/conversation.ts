// Conversation view: a managed session's exchange with its agent, read from
// the CLI's own transcript rather than scraped from the terminal. Claude
// Code writes ~/.claude/projects/<encoded cwd>/<session uuid>.jsonl; Codex
// writes ~/.codex/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl
// with a session_meta first line naming its cwd. The session is matched by
// the id its hook reported (agentSessionId) or, before any hook has fired,
// by cwd and start time. Parsers are pure and skip malformed lines, like
// usage/parse.ts; harness wrappers (<environment_context>, <command-name>,
// system reminders, …) are not the user's words and are dropped.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AgentMessage, Session } from '../types.js';
import { defaultUsageRoots, type UsageRoots } from '../usage/indexer.js';
import { type PendingQuestion, pendingQuestion } from './questions.js';

export interface ConversationTurn {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  /** Tool turns: the tool's name, e.g. Bash or exec. */
  toolName?: string;
  ts: string;
}

export interface PlanStep {
  label: string;
  /** Claude's present-tense phrasing of the step ("Running tests"), shown while it is in progress. */
  activeForm?: string;
  status: 'completed' | 'in_progress' | 'pending';
}

export interface ConversationView {
  /** False until the agent has written a transcript for this session. */
  found: boolean;
  turns: ConversationTurn[];
  /** The agent's latest checklist (Claude's TodoWrite, Codex's update_plan); absent when it never wrote one. */
  plan?: PlanStep[];
  /** A multiple-choice question the agent has open in its terminal, waiting for an answer. */
  question?: PendingQuestion & {
    /** Set by the route: false when AgentDeck can't reach the menu (an external session with no hook holding it). */
    canAnswer?: boolean;
  };
}

/** Keep dashboard sends visible while the CLI transcript is delayed or absent. */
export function mergeSentConversationTurns(
  conversation: ConversationView, session: Session, messages: readonly AgentMessage[],
): ConversationView {
  const transcriptUsers = conversation.turns.filter((turn) => turn.role === 'user');
  const matched = new Set<string>();
  const sent = messages.flatMap((message, index): ConversationTurn[] => {
    if (message.agent !== `dashboard:${session.id}` || message.event !== 'message'
      || message.sessionId !== session.id || !message.message?.trim()
      || Date.parse(message.ts) < Date.parse(session.startedAt)) return [];
    const text = message.message.trim();
    const match = transcriptUsers.find((turn) => !matched.has(turn.id) && turn.text.trim() === text
      && Date.parse(turn.ts) >= Date.parse(message.ts) - 2_000);
    if (match) {
      matched.add(match.id);
      return [];
    }
    return [{ id: `dashboard-${message.ts}-${index}`, role: 'user', text, ts: message.ts }];
  });
  if (!sent.length) return conversation;
  return { ...conversation, turns: [...conversation.turns, ...sent]
    .sort((left, right) => left.ts.localeCompare(right.ts)).slice(-MAX_TURNS) };
}

type Json = Record<string, unknown>;
const MAX_TURNS = 500;
const MAX_TOOL_TEXT = 400;
/** Clock skew allowed between AgentDeck's startedAt and the CLI's first timestamp. */
const START_SLACK_MS = 15_000;

function parse(line: string): Json | undefined {
  if (!line.trim()) return undefined;
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
  } catch {
    return undefined;
  }
}
const obj = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);

/** Text injected by the harness rather than typed by the user. */
function isHarnessText(text: string): boolean {
  const trimmed = text.trimStart();
  return /^<[a-z_-]+>/i.test(trimmed) || trimmed.startsWith('Caveat: The messages below were generated');
}

/** A slash command the user ran is recorded as `<command-name>/x</command-name><command-args>…`; turn it back into what they typed. */
function slashCommandText(text: string): string | undefined {
  const name = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(text)?.[1];
  if (!name) return undefined;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
  return args ? `/${name} ${args}` : `/${name}`;
}

function clip(text: string, max = MAX_TOOL_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** One line that says what a tool call did: its command, path, or description. */
function toolSummary(input: unknown): string {
  const record = obj(input);
  if (!record) return typeof input === 'string' ? clip(input.trim()) : '';
  for (const key of ['command', 'cmd', 'file_path', 'path', 'pattern', 'description', 'url', 'query', 'prompt']) {
    const value = record[key];
    if (typeof value === 'string' && value) return clip(value);
    if (Array.isArray(value) && value.every((part) => typeof part === 'string')) return clip(value.join(' '));
  }
  return clip(JSON.stringify(record));
}

/** Merges consecutive assistant text so one reply is one bubble. */
function push(turns: ConversationTurn[], turn: ConversationTurn): void {
  const last = turns.at(-1);
  if (last && last.role === 'assistant' && turn.role === 'assistant') {
    last.text = `${last.text}\n\n${turn.text}`;
    return;
  }
  turns.push(turn);
}

export function parseClaudeConversation(lines: readonly string[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  lines.forEach((line, index) => {
    const record = parse(line);
    if (!record || record.isMeta === true || record.isSidechain === true) return;
    const message = obj(record.message);
    const ts = str(record.timestamp) ?? '';
    const id = str(record.uuid) ?? `line-${index}`;
    if (record.type === 'user' && message) {
      const content = message.content;
      const texts = typeof content === 'string' ? [content]
        : Array.isArray(content) ? content.map(obj).filter((part) => part?.type === 'text').map((part) => str(part!.text) ?? '') : [];
      const text = texts.map((part) => slashCommandText(part) ?? (isHarnessText(part) ? '' : part))
        .filter(Boolean).join('\n\n').trim();
      if (text) push(turns, { id, role: 'user', text, ts });
    } else if (record.type === 'assistant' && message && Array.isArray(message.content)) {
      message.content.map(obj).forEach((part, partIndex) => {
        if (part?.type === 'text' && str(part.text)?.trim()) {
          push(turns, { id: `${id}-${partIndex}`, role: 'assistant', text: String(part.text).trim(), ts });
        } else if (part?.type === 'tool_use') {
          push(turns, { id: `${id}-${partIndex}`, role: 'tool', toolName: str(part.name) ?? 'tool', text: toolSummary(part.input), ts });
        }
      });
    }
  });
  return turns.slice(-MAX_TURNS);
}

function codexText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.map(obj)
    .filter((part) => part?.type === 'input_text' || part?.type === 'output_text' || part?.type === 'text')
    .map((part) => str(part!.text) ?? '')
    .filter((part) => part && !isHarnessText(part))
    .join('\n\n')
    .trim();
}

export function parseCodexConversation(lines: readonly string[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  lines.forEach((line, index) => {
    const record = parse(line);
    const payload = obj(record?.payload);
    if (!record || record.type !== 'response_item' || !payload) return;
    const ts = str(record.timestamp) ?? '';
    const id = str(payload.id) ?? `line-${index}`;
    if (payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
      const text = codexText(payload.content);
      if (text) push(turns, { id, role: payload.role, text, ts });
    } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call' || payload.type === 'local_shell_call') {
      let input: unknown = payload.input ?? payload.action;
      if (typeof payload.arguments === 'string') {
        try { input = JSON.parse(payload.arguments); } catch { input = payload.arguments; }
      }
      push(turns, { id, role: 'tool', toolName: str(payload.name) ?? 'shell', text: toolSummary(input), ts });
    }
  });
  return turns.slice(-MAX_TURNS);
}

function planStatus(value: unknown): PlanStep['status'] {
  return value === 'completed' || value === 'in_progress' ? value : 'pending';
}

/** The last checklist the agent wrote: Claude's TodoWrite todos or Codex's update_plan steps. */
export function latestPlan(agent: Session['agent'], lines: readonly string[]): PlanStep[] | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const record = parse(lines[index]!);
    if (!record) continue;
    if (agent === 'claude') {
      const content = obj(record.message)?.content;
      if (record.type !== 'assistant' || record.isSidechain === true || !Array.isArray(content)) continue;
      for (const part of [...content].reverse().map(obj)) {
        const todos = part?.type === 'tool_use' && part.name === 'TodoWrite' ? obj(part.input)?.todos : undefined;
        if (!Array.isArray(todos)) continue;
        return todos.map(obj).flatMap((todo) => {
          const label = str(todo?.content);
          if (!label) return [];
          const activeForm = str(todo!.activeForm);
          return [{ label, ...(activeForm ? { activeForm } : {}), status: planStatus(todo!.status) }];
        });
      }
    } else {
      const payload = obj(record.payload);
      if (record.type !== 'response_item' || payload?.type !== 'function_call' || payload.name !== 'update_plan') continue;
      let input: unknown;
      try { input = typeof payload.arguments === 'string' ? JSON.parse(payload.arguments) : undefined; } catch { continue; }
      const steps = obj(input)?.plan;
      if (!Array.isArray(steps)) continue;
      return steps.map(obj).flatMap((step) => {
        const label = str(step?.step);
        return label ? [{ label, status: planStatus(step!.status) }] : [];
      });
    }
  }
  return undefined;
}

/** Claude Code names a project folder after its cwd with every non-alphanumeric character replaced by '-'. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

async function readHead(file: string, bytes = 64 * 1024): Promise<string[]> {
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8').split('\n');
  } finally {
    await handle.close();
  }
}

async function listFiles(directory: string, suffix: string): Promise<string[]> {
  try {
    return (await fsp.readdir(directory)).filter((name) => name.endsWith(suffix)).map((name) => path.join(directory, name));
  } catch {
    return [];
  }
}

/** The file whose first timestamp is nearest after the session started. */
function closestStart(candidates: { file: string; startedAt: number }[], sessionStart: number): string | undefined {
  return candidates
    .filter((candidate) => candidate.startedAt >= sessionStart - START_SLACK_MS)
    .sort((left, right) => left.startedAt - right.startedAt)[0]?.file;
}

/** Hook identities include the agent name; transcript filenames contain only the provider ID. */
function transcriptId(session: Session): string | undefined {
  const identity = session.agentSessionId;
  const prefix = `${session.agent}:`;
  const id = identity?.startsWith(prefix) ? identity.slice(prefix.length) : identity;
  return id && /^[a-zA-Z0-9_-]+$/.test(id) && id !== 'unknown' ? id : undefined;
}

function isExactTranscript(session: Session, file: string): boolean {
  const id = transcriptId(session);
  return !id || (session.agent === 'claude'
    ? path.basename(file) === `${id}.jsonl`
    : path.basename(file).endsWith(`-${id}.jsonl`));
}

async function locateClaude(session: Session, roots: readonly string[]): Promise<string | undefined> {
  const directories = roots.map((root) => path.join(root, claudeProjectDirName(session.cwd)));
  const id = transcriptId(session);
  if (id) {
    for (const directory of directories) {
      const file = path.join(directory, `${id}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
  }
  const sessionStart = Date.parse(session.startedAt);
  const candidates: { file: string; startedAt: number }[] = [];
  for (const directory of directories) {
    for (const file of await listFiles(directory, '.jsonl')) {
      try {
        if ((await fsp.stat(file)).mtimeMs < sessionStart - START_SLACK_MS) continue;
        const first = (await readHead(file)).map(parse).find((record) => str(record?.timestamp));
        if (first) candidates.push({ file, startedAt: Date.parse(String(first.timestamp)) });
      } catch { /* unreadable or vanished — not ours */ }
    }
  }
  return closestStart(candidates, sessionStart);
}

function localDateDirs(root: string, at: number): string[] {
  return [at - 86_400_000, at, at + 86_400_000].map((time) => {
    const date = new Date(time);
    return path.join(root, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
  });
}

async function locateCodex(session: Session, roots: readonly string[]): Promise<string | undefined> {
  const sessionStart = Date.parse(session.startedAt);
  const directories = roots.flatMap((root) => localDateDirs(root, sessionStart));
  const files = (await Promise.all(directories.map((directory) => listFiles(directory, '.jsonl')))).flat();
  const id = transcriptId(session);
  if (id) {
    const byId = files.find((file) => path.basename(file).endsWith(`-${id}.jsonl`));
    if (byId) return byId;
  }
  const candidates: { file: string; startedAt: number }[] = [];
  for (const file of files) {
    try {
      const meta = obj(parse((await readHead(file, 16 * 1024))[0] ?? '')?.payload);
      if (meta && meta.cwd === session.cwd && str(meta.timestamp)) {
        candidates.push({ file, startedAt: Date.parse(String(meta.timestamp)) });
      }
    } catch { /* unreadable or vanished — not ours */ }
  }
  return closestStart(candidates, sessionStart);
}

export function locateTranscript(session: Session, roots: UsageRoots = defaultUsageRoots()): Promise<string | undefined> {
  return session.agent === 'claude' ? locateClaude(session, roots.claude) : locateCodex(session, roots.codex);
}

/**
 * Reads conversations, remembering each session's transcript path and the
 * last parse so polling an idle session costs one stat().
 */
export class ConversationReader {
  private readonly paths = new Map<string, string>();
  private readonly parsed = new Map<string, { size: number; mtimeMs: number; view: ConversationView }>();

  constructor(private readonly roots: UsageRoots = defaultUsageRoots()) {}

  async read(session: Session): Promise<ConversationView> {
    const key = `${session.id}:${session.startedAt}`;
    let file = this.paths.get(key);
    if (file && !isExactTranscript(session, file)) file = undefined;
    if (!file) {
      file = await locateTranscript(session, this.roots);
      if (!file) return { found: false, turns: [] };
      this.paths.set(key, file);
    }
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(file);
    } catch {
      this.paths.delete(key);
      return { found: false, turns: [] };
    }
    const cached = this.parsed.get(file);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.view;
    const lines = (await fsp.readFile(file, 'utf8')).split('\n');
    const turns = session.agent === 'claude' ? parseClaudeConversation(lines) : parseCodexConversation(lines);
    const question = pendingQuestion(session.agent, lines);
    const plan = latestPlan(session.agent, lines);
    const view: ConversationView = { found: true, turns, ...(plan?.length ? { plan } : {}), ...(question ? { question } : {}) };
    this.parsed.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, view });
    return view;
  }
}
