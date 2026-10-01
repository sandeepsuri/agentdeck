// Issue #91: a capture driver that records what it was asked to capture and
// lets a test push frames or end the capture, standing in for the native
// window-capture helper.
import { WindowViewError, type CaptureDriver, type CaptureEvents, type ScreenPermission, type ShareableWindow } from '../window-view/service.js';

export const EDITOR: ShareableWindow = { id: 101, app: 'TextEdit', title: 'Notes.txt' };
export const BROWSER: ShareableWindow = { id: 202, app: 'Safari', title: 'Bank' };

export interface FakeCapture { window: ShareableWindow; events: CaptureEvents; stopped: boolean }

export type FakeCaptureDriver = CaptureDriver & { permissionState: ScreenPermission; captures: FakeCapture[]; requests: number };

export function fakeCaptureDriver(windows: ShareableWindow[] = [EDITOR, BROWSER]): FakeCaptureDriver {
  const driver: FakeCaptureDriver = {
    permissionState: 'granted',
    captures: [],
    requests: 0,
    permission: async () => driver.permissionState,
    requestPermission: async () => { driver.requests += 1; return driver.permissionState; },
    listWindows: async () => {
      if (driver.permissionState !== 'granted') throw new WindowViewError('permission-denied', 'Screen Recording permission is off for AgentDeck.');
      return windows;
    },
    capture: (window, events) => {
      const capture: FakeCapture = { window, events, stopped: false };
      driver.captures.push(capture);
      return { stop: () => { capture.stopped = true; } };
    },
  };
  return driver;
}
