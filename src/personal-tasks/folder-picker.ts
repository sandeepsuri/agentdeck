// The only way a folder grant starts: the owner picks a folder in the native
// macOS dialog on this Mac. The browser never supplies a path, so a request
// cannot name a folder the owner did not choose.
import { execFile } from 'node:child_process';

/** Resolves to the chosen folder's absolute path, or undefined when the owner cancels. */
export type FolderPicker = () => Promise<string | undefined>;

const PICKER_TIMEOUT_MS = 10 * 60 * 1000;

export class FolderPickerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FolderPickerUnavailableError';
  }
}

export function macFolderPicker(): FolderPicker {
  return () => new Promise((resolve, reject) => {
    if (process.platform !== 'darwin') {
      reject(new FolderPickerUnavailableError('Choosing a folder needs macOS.'));
      return;
    }
    execFile(
      '/usr/bin/osascript',
      ['-e', 'activate', '-e', 'POSIX path of (choose folder with prompt "Choose one folder AgentDeck may read")'],
      { timeout: PICKER_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (!error) {
          const chosen = stdout.trim();
          resolve(chosen.length > 1 && chosen.endsWith('/') ? chosen.slice(0, -1) : chosen);
          return;
        }
        // -128 is AppleScript's "User canceled."
        if (/-128\b/.test(String(stderr))) {
          resolve(undefined);
          return;
        }
        reject(new FolderPickerUnavailableError('The folder picker could not be opened.'));
      },
    );
  });
}
