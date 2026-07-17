import type { Session } from '../../types.js';
import type { TerminalAdapter, TerminalTab } from './index.js';
import { appRunning, numericId, osaRunner, quoted, type OsaRunner } from './osascript.js';

const ITERM_LIST = `
set out to ""
tell application "iTerm2"
  repeat with w in windows
    set wid to id of w
    set tabIndex to 0
    repeat with t in tabs of w
      set tabIndex to tabIndex + 1
      repeat with s in sessions of t
        set out to out & wid & "|" & tabIndex & "|" & (tty of s) & "|" & (id of s) & "|" & (name of s) & linefeed
      end repeat
    end repeat
  end repeat
end tell
return out`;

const itermFocus = (wid: string, tabIdx: string, sessId: string) => `
tell application "iTerm2"
  set w to first window whose id is ${wid}
  tell w
    select tab ${tabIdx}
    tell tab ${tabIdx} to select (first session whose id is "${sessId}")
  end tell
  select w
  activate
end tell`;

const itermSend = (wid: string, tabIdx: string, sessId: string, quotedText: string, newline: boolean) => `
tell application "iTerm2"
  tell tab ${tabIdx} of (first window whose id is ${wid})
    tell (first session whose id is "${sessId}") to write text "${quotedText}" newline ${newline ? 'YES' : 'NO'}
  end tell
end tell`;

export class ITerm2Adapter implements TerminalAdapter {
  readonly app = 'iTerm2' as const;
  readonly verified = false;

  constructor(
    private run: OsaRunner = osaRunner('iTerm2'),
    private submitDelayMs = 300,
  ) {}

  async listTtys(): Promise<TerminalTab[]> {
    if (!await appRunning(this.run, 'iTerm2')) return [];
    const output = await this.run(ITERM_LIST);
    return output.split('\n').flatMap((line) => {
      const [windowId, tabId, tty, sessionId, title] = line.split('|');
      if (!windowId || !tabId || !tty || !sessionId) return [];
      const tab: TerminalTab = {
        windowId,
        tabId,
        tty: tty.replace('/dev/', ''),
        sessionId,
      };
      if (title) tab.title = title;
      return [tab];
    });
  }

  async focus(ref: NonNullable<Session['terminalRef']>): Promise<void> {
    if (!ref.sessionId) throw new Error('Missing iTerm2 session id.');
    await this.run(itermFocus(
      numericId(ref.windowId, 'iTerm2 window id'),
      numericId(ref.tabId, 'iTerm2 tab id'),
      quoted(ref.sessionId),
    ));
  }

  async sendText(ref: NonNullable<Session['terminalRef']>, text: string): Promise<void> {
    if (!ref.sessionId) throw new Error('Missing iTerm2 session id.');
    const wid = numericId(ref.windowId, 'iTerm2 window id');
    const tab = numericId(ref.tabId, 'iTerm2 tab id');
    const sess = quoted(ref.sessionId);
    await this.run(itermSend(wid, tab, sess, quoted(text), false));
    // both agent TUIs debounce paste-then-submit; a follow-up bare newline
    // guarantees the prompt is actually sent
    await new Promise((resolve) => setTimeout(resolve, this.submitDelayMs));
    await this.run(itermSend(wid, tab, sess, '', true));
  }
}
