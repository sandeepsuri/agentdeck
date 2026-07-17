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

export class ITerm2Adapter implements TerminalAdapter {
  readonly app = 'iTerm2' as const;
  readonly verified = false;

  constructor(private run: OsaRunner = osaRunner('iTerm2')) {}

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
}
