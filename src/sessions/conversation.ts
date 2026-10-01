// Conversation view: a managed session's exchange with its agent, read from
// the CLI's own transcript rather than scraped from the terminal. Claude
// Code writes ~/.claude/projects/<encoded cwd>/<session uuid>.jsonl; Codex
// writes ~/.codex/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl
// with a session_meta first line naming its cwd. The session is matched by
// the id its hook reported (agentSessionId) or, before any hook has fired,
// by cwd and start time. Parsers are pure and skip malformed lines, like
// usage/parse.ts; harness wrappers (<environment_context>, <command-name>,
// system reminders, …) are not the user's words and are dropped.
//
// An image the agent looked at (a tool result carrying one, such as Claude
// reading a screenshot or Codex's view_image) becomes an image turn. The turn
// names the image by where it sits in the transcript; its bytes are read
// back only when asked for (ConversationReader.image), so the conversation
// stays small. Images the user pasted into a prompt are not shown again.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AgentMessage, Session } from '../types.js';
import { defaultUsageRoots, type UsageRoots } from '../usage/indexer.js';
import { type PendingQuestion, pendingQuestion } from './questions.js';

export interface ConversationTurn {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'image';
  /** Image turns: the file the agent opened, when the transcript names it; otherwise empty. */
  text: string;
  /** Image turns: how to fetch it (GET /api/sessions/:id/images/:id). */
  image?: TurnImage;
  /** Tool turns: the tool's name, e.g. Bash or exec. */
  toolName?: string;
  ts: string;
  /** User turns sent from the paired owner phone. */
  via?: 'phone';
}

export interface TurnImage {
  id: string;
  mediaType: string;
}

/** An image's bytes, read back from the transcript. */
export interface TranscriptImage {
  mediaType: string;
  data: Buffer;
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
  /** Set by the route for the Mac: the paired owner phone has this session open. */
  phoneFollowing?: boolean;
}

/** Keep dashboard sends visible while the CLI transcript is delayed or absent. */
export function mergeSentConversationTurns(
  conversation: ConversationView, session: Session, messages: readonly AgentMessage[],
): ConversationView {
  const transcriptUsers = conversation.turns.filter((turn) => turn.role === 'user');
  const matched = new Set<string>();
  const fromPhone = new Set<string>();
  const sent = messages.flatMap((message, index): ConversationTurn[] => {
    if (message.agent !== `dashboard:${session.id}` || message.event !== 'message'
      || message.sessionId !== session.id || !message.message?.trim()
      || Date.parse(message.ts) < Date.parse(session.startedAt)) return [];
    const text = message.message.trim();
    const match = transcriptUsers.find((turn) => !matched.has(turn.id) && turn.text.trim() === text
      && Date.parse(turn.ts) >= Date.parse(message.ts) - 2_000);
    if (match) {
      matched.add(match.id);
      if (message.via === 'phone') fromPhone.add(match.id);
      return [];
    }
    return [{ id: `dashboard-${message.ts}-${index}`, role: 'user', text, ts: message.ts, ...(message.via === 'phone' ? { via: 'phone' as const } : {}) }];
  });
  if (!sent.length && !fromPhone.size) return conversation;
  const turns = conversation.turns.map((turn) => (fromPhone.has(turn.id) ? { ...turn, via: 'phone' as const } : turn));
  return { ...conversation, turns: [...turns, ...sent]
    .sort((left, right) => left.ts.localeCompare(right.ts)).slice(-MAX_TURNS) };
}

type Json = Record<string, unknown>;
const MAX_TURNS = 500;
const MAX_TOOL_TEXT = 400;
const MAX_CACHED_IMAGES = 24;
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

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const IMAGE_ID = /^img-(\d+)-(\d+)$/;

/** One image the agent looked at, as one transcript record carries it. */
interface FoundImage {
  mediaType: string;
  base64: string;
  /** The tool call that produced it, to name the file it opened. */
  callId?: string;
}

function dataUrlImage(url: unknown): Omit<FoundImage, 'callId'> | undefined {
  const match = typeof url === 'string' ? /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url) : null;
  return match && IMAGE_TYPES.has(match[1]!.toLowerCase()) ? { mediaType: match[1]!.toLowerCase(), base64: match[2]! } : undefined;
}

/** Claude: images inside tool results. An image part straight in a user message was pasted by the user. */
function claudeImages(record: Json): FoundImage[] {
  const content = obj(record.message)?.content;
  if (record.type !== 'user' || record.isMeta === true || record.isSidechain === true || !Array.isArray(content)) return [];
  return content.map(obj).flatMap((part) => {
    if (part?.type !== 'tool_result' || !Array.isArray(part.content)) return [];
    const callId = str(part.tool_use_id);
    return part.content.map(obj).flatMap((inner) => {
      const source = obj(inner?.source);
      const mediaType = str(source?.media_type)?.toLowerCase();
      const base64 = str(source?.data);
      if (inner?.type !== 'image' || source?.type !== 'base64' || !mediaType || !IMAGE_TYPES.has(mediaType) || !base64) return [];
      return [{ mediaType, base64, ...(callId ? { callId } : {}) }];
    });
  });
}

/** Codex: images in a tool call's output (view_image and the like). Images in a user message were pasted. */
function codexImages(record: Json): FoundImage[] {
  const payload = obj(record.payload);
  if (record.type !== 'response_item' || !payload
    || (payload.type !== 'function_call_output' && payload.type !== 'custom_tool_call_output') || !Array.isArray(payload.output)) return [];
  const callId = str(payload.call_id);
  return payload.output.map(obj).flatMap((part) => {
    const image = part?.type === 'input_image' ? dataUrlImage(part.image_url) : undefined;
    return image ? [{ ...image, ...(callId ? { callId } : {}) }] : [];
  });
}

function recordImages(agent: Session['agent'], record: Json): FoundImage[] {
  return agent === 'claude' ? claudeImages(record) : codexImages(record);
}

/** The file a tool call opened, if it names one. */
function openedFile(input: unknown): string | undefined {
  const record = obj(input);
  const file = str(record?.file_path) ?? str(record?.path);
  return file ? path.basename(file) : undefined;
}

function imageTurns(agent: Session['agent'], record: Json, line: number, files: ReadonlyMap<string, string>): ConversationTurn[] {
  const ts = str(record.timestamp) ?? '';
  return recordImages(agent, record).map((image, index) => ({
    id: `img-${line}-${index}`,
    role: 'image',
    text: (image.callId && files.get(image.callId)) ?? '',
    image: { id: `img-${line}-${index}`, mediaType: image.mediaType },
    ts,
  }));
}

/** An image turn's bytes, found again where its id says it is. */
export function findTranscriptImage(agent: Session['agent'], lines: readonly string[], imageId: string): TranscriptImage | undefined {
  const match = IMAGE_ID.exec(imageId);
  if (!match) return undefined;
  const line = lines[Number(match[1])];
  const record = line === undefined ? undefined : parse(line);
  const image = record ? recordImages(agent, record)[Number(match[2])] : undefined;
  return image ? { mediaType: image.mediaType, data: Buffer.from(image.base64, 'base64') } : undefined;
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
  const files = new Map<string, string>();
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
      for (const turn of imageTurns('claude', record, index, files)) push(turns, turn);
    } else if (record.type === 'assistant' && message && Array.isArray(message.content)) {
      message.content.map(obj).forEach((part, partIndex) => {
        if (part?.type === 'text' && str(part.text)?.trim()) {
          push(turns, { id: `${id}-${partIndex}`, role: 'assistant', text: String(part.text).trim(), ts });
        } else if (part?.type === 'tool_use') {
          const file = openedFile(part.input);
          if (file && str(part.id)) files.set(String(part.id), file);
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
  const files = new Map<string, string>();
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
      const file = openedFile(input);
      if (file && str(payload.call_id)) files.set(String(payload.call_id), file);
      push(turns, { id, role: 'tool', toolName: str(payload.name) ?? 'shell', text: toolSummary(input), ts });
    } else {
      for (const turn of imageTurns('codex', record, index, files)) push(turns, turn);
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
  private readonly images = new Map<string, TranscriptImage>();

  constructor(private readonly roots: UsageRoots = defaultUsageRoots()) {}

  private async transcript(session: Session): Promise<string | undefined> {
    const key = `${session.id}:${session.startedAt}`;
    let file = this.paths.get(key);
    if (file && !isExactTranscript(session, file)) file = undefined;
    if (!file) {
      file = await locateTranscript(session, this.roots);
      if (file) this.paths.set(key, file);
    }
    return file;
  }

  /** One image turn's bytes. Transcripts only grow, so a found image is kept for the next ask. */
  async image(session: Session, imageId: string): Promise<TranscriptImage | undefined> {
    if (!IMAGE_ID.test(imageId)) return undefined;
    const file = await this.transcript(session);
    if (!file) return undefined;
    const key = `${file}#${imageId}`;
    const cached = this.images.get(key);
    if (cached) return cached;
    let lines: string[];
    try {
      lines = (await fsp.readFile(file, 'utf8')).split('\n');
    } catch {
      return undefined;
    }
    const image = findTranscriptImage(session.agent, lines, imageId);
    if (!image) return undefined;
    this.images.set(key, image);
    if (this.images.size > MAX_CACHED_IMAGES) this.images.delete(this.images.keys().next().value!);
    return image;
  }

  async read(session: Session): Promise<ConversationView> {
    const key = `${session.id}:${session.startedAt}`;
    const file = await this.transcript(session);
    if (!file) return { found: false, turns: [] };
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
