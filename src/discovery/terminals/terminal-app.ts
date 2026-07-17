import type { Session } from '../../types.js';
import type { TerminalAdapter, TerminalTab } from './index.js';
import { appRunning, numericId, osaRunner, type OsaRunner } from './osascript.js';

const TERMINAL_LIST = `
set out to ""
tell application "Terminal"
  repeat with w in windows
    set wid to id of w
    set tabIndex to 0
    repeat with t in tabs of w
      set tabIndex to tabIndex + 1
      set out to out & wid & "|" & tabIndex & "|" & (tty of t) & "|" & (custom title of t) & linefeed
    end repeat
  end repeat
end tell
return out`;

const terminalFocus = (wid: string, tabIdx: string) => `
tell application "Terminal"
  set w to first window whose id is ${wid}
  set selected tab of w to tab ${tabIdx} of w
  set index of w to 1
  activate
end tell`;

export class TerminalAppAdapter implements TerminalAdapter {
  readonly app = 'Terminal' as const;
  readonly verified = true;

  constructor(private run: OsaRunner = osaRunner('Terminal')) {}

  async listTtys(): Promise<TerminalTab[]> {
    if (!await appRunning(this.run, 'Terminal')) return [];
    const output = await this.run(TERMINAL_LIST);
    return output.split('\n').flatMap((line) => {
      const [windowId, tabId, tty, title] = line.split('|');
      if (!windowId || !tabId || !tty) return [];
      const tab: TerminalTab = { windowId, tabId, tty: tty.replace('/dev/', '') };
      if (title) tab.title = title;
      return [tab];
    });
  }

  async focus(ref: NonNullable<Session['terminalRef']>): Promise<void> {
    await this.run(terminalFocus(
      numericId(ref.windowId, 'Terminal window id'),
      numericId(ref.tabId, 'Terminal tab id'),
    ));
  }
}
