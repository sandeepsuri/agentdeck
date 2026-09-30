// Issue #91: the owner views one Mac window, chosen on the Mac, from a paired
// owner phone. The Mac asks for Screen Recording permission explicitly, the
// capture helper shows its own indicator for as long as it runs, and only the
// chosen window is ever captured. Nothing is persisted: the choice, the
// viewer, and the latest frame live in memory, so a service restart ends the
// view and forgets the choice.
//
// A view ends at once when the phone stops, the Mac stops it or changes the
// window, the phone is revoked, Screen Recording is withdrawn, the window
// goes away, or the phone stops asking for frames.
import crypto from 'node:crypto';

export type ScreenPermission = 'granted' | 'denied' | 'unsupported';

/** A window the Mac offers for viewing: its CoreGraphics window id, owning app, and title. */
export interface ShareableWindow {
  id: number;
  app: string;
  title: string;
}

export interface CapturedFrame {
  jpeg: Buffer;
  width: number;
  height: number;
}

/** Why a capture ended on its own. */
export type CaptureEnd = 'window-closed' | 'permission-denied' | 'stopped-at-mac' | 'failed';

export interface CaptureEvents {
  onFrame(frame: CapturedFrame): void;
  onEnd(reason: CaptureEnd): void;
}

export interface CaptureHandle {
  /** Ends the capture and removes its indicator; safe to call more than once. */
  stop(): void;
}

/** The Mac side of capture: the native helper in production, a fake in tests. */
export interface CaptureDriver {
  permission(): Promise<ScreenPermission>;
  /** Shows the system's Screen Recording request, where macOS still offers it. */
  requestPermission(): Promise<ScreenPermission>;
  listWindows(): Promise<ShareableWindow[]>;
  capture(window: ShareableWindow, events: CaptureEvents): CaptureHandle;
}

export type EndReason =
  | 'stopped-by-phone' | 'stopped-at-mac' | 'selection-changed' | 'revoked' | 'permission-withdrawn'
  | 'window-closed' | 'phone-left' | 'replaced' | 'failed' | 'service-stopped';

const END_MESSAGE: Record<EndReason, string> = {
  'stopped-by-phone': 'You stopped viewing.',
  'stopped-at-mac': 'Viewing was stopped on the Mac.',
  'selection-changed': 'A different window was chosen on the Mac.',
  revoked: 'This phone was revoked on the Mac.',
  'permission-withdrawn': 'Screen Recording permission for AgentDeck was turned off on the Mac.',
  'window-closed': 'The window was closed or can no longer be captured.',
  'phone-left': 'Viewing stopped because the phone stopped asking for frames.',
  replaced: 'Another phone started viewing.',
  failed: 'Capture stopped unexpectedly on the Mac.',
  'service-stopped': 'AgentDeck stopped on the Mac.',
};

export const UNSUPPORTED_HELP = 'Viewing a Mac window needs AgentDeck’s capture helper on macOS 13 or newer. Reinstall AgentDeck to restore it.';

export const PERMISSION_HELP = 'AgentDeck needs Screen Recording permission to show a window on your phone. '
  + 'On the Mac, open System Settings › Privacy & Security › Screen Recording, turn on AgentDeck '
  + '(or the terminal app running AgentDeck from source), then quit and reopen AgentDeck.';

/**
 * A base64 frame must fit in one sealed relay frame (the relay's limit is
 * 1 MB, and base64 is applied twice on the way), so larger frames are dropped.
 */
export const MAX_FRAME_BYTES = 320 * 1024;

export type WindowViewErrorCode = 'no-window' | 'permission-denied' | 'unsupported' | 'capture-failed' | 'not-found' | 'not-viewing';

export class WindowViewError extends Error {
  constructor(readonly code: WindowViewErrorCode, message: string) {
    super(message);
    this.name = 'WindowViewError';
  }
}

export interface Viewer {
  id: string;
  label: string;
}

export interface Frame extends CapturedFrame {
  seq: number;
  capturedAt: string;
}

interface Live {
  viewId: string;
  viewer: Viewer;
  window: ShareableWindow;
  startedAt: string;
  handle: CaptureHandle;
  frame?: Frame;
  waiters: Set<() => void>;
  lease: NodeJS.Timeout;
  permissionWatch: NodeJS.Timeout;
}

export interface Ended {
  reason: EndReason;
  message: string;
  at: string;
  viewerId: string;
  viewer: string;
}

const windowLabel = (window: ShareableWindow) => ({ app: window.app, title: window.title });

export interface WindowViewOptions {
  driver: CaptureDriver;
  /** How long a view survives without a frame request from its phone. */
  leaseMs?: number;
  /** How often Screen Recording permission is re-checked while capturing. */
  permissionCheckMs?: number;
  now?: () => Date;
}

export class WindowViewService {
  private selected: ShareableWindow | undefined;
  private live: Live | undefined;
  private lastEnded: Ended | undefined;
  private readonly leaseMs: number;
  private readonly permissionCheckMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: WindowViewOptions) {
    this.leaseMs = options.leaseMs ?? 10_000;
    this.permissionCheckMs = options.permissionCheckMs ?? 2_000;
    this.now = options.now ?? (() => new Date());
  }

  /** What the Mac shows: the chosen window, who is viewing it now, and how the last view ended. */
  status() {
    return {
      window: this.selected ? windowLabel(this.selected) : null,
      live: this.live ? { viewer: this.live.viewer.label, window: windowLabel(this.live.window), startedAt: this.live.startedAt } : null,
      lastEnded: this.lastEnded ? { reason: this.lastEnded.reason, message: this.lastEnded.message, at: this.lastEnded.at, viewer: this.lastEnded.viewer } : null,
    };
  }

  /** What one phone sees: the chosen window, its own view if any, and how its last view ended. */
  phoneStatus(viewer: Viewer) {
    const mine = this.live?.viewer.id === viewer.id ? this.live : undefined;
    const ended = this.lastEnded?.viewerId === viewer.id ? this.lastEnded : undefined;
    return {
      window: this.selected ? windowLabel(this.selected) : null,
      viewing: mine ? { viewId: mine.viewId, startedAt: mine.startedAt } : null,
      ended: ended ? { reason: ended.reason, message: ended.message, at: ended.at } : null,
    };
  }

  permission(): Promise<ScreenPermission> { return this.options.driver.permission(); }

  requestPermission(): Promise<ScreenPermission> { return this.options.driver.requestPermission(); }

  async windows(): Promise<ShareableWindow[]> {
    await this.requireGranted();
    return this.options.driver.listWindows();
  }

  /** Chooses the one window a phone may view. Only a window the Mac lists right now can be chosen. */
  async select(windowId: number): Promise<ShareableWindow> {
    const window = (await this.windows()).find((candidate) => candidate.id === windowId);
    if (!window) throw new WindowViewError('not-found', 'That window is no longer open. Choose it again.');
    if (this.live && this.live.window.id !== window.id) this.end('selection-changed');
    this.selected = window;
    return window;
  }

  /** Stops sharing: ends any view and forgets the chosen window. */
  clear(): void {
    this.end('stopped-at-mac');
    this.selected = undefined;
  }

  async start(viewer: Viewer): Promise<{ viewId: string; startedAt: string }> {
    const window = this.selected;
    if (!window) throw new WindowViewError('no-window', 'No window is shared. On the Mac, choose one in Settings › Owner phones › Mac window.');
    await this.requireGranted();
    if (this.selected !== window) throw new WindowViewError('no-window', 'The shared window changed on the Mac. Try again.');
    if (this.live?.viewer.id === viewer.id) {
      this.renew(this.live);
      return { viewId: this.live.viewId, startedAt: this.live.startedAt };
    }
    if (this.live) this.end('replaced');

    const viewId = crypto.randomUUID();
    let ended = false;
    const events: CaptureEvents = {
      onFrame: (frame) => {
        const live = this.live;
        if (live?.viewId !== viewId || frame.jpeg.length > MAX_FRAME_BYTES) return;
        live.frame = { ...frame, seq: (live.frame?.seq ?? 0) + 1, capturedAt: this.now().toISOString() };
        this.wake(live);
      },
      onEnd: (reason) => {
        ended = true;
        if (this.live?.viewId !== viewId) return;
        this.end(reason === 'permission-denied' ? 'permission-withdrawn' : reason);
      },
    };
    const handle = this.options.driver.capture(window, events);
    const live: Live = {
      viewId, viewer, window, handle, startedAt: this.now().toISOString(), waiters: new Set(),
      lease: setTimeout(() => undefined, 0),
      permissionWatch: setInterval(() => void this.checkPermission(viewId), this.permissionCheckMs),
    };
    live.permissionWatch.unref();
    this.live = live;
    this.renew(live);
    // A capture that failed to start reports its end synchronously.
    if (ended) {
      this.end('failed');
      throw new WindowViewError('capture-failed', 'The Mac could not start capturing that window. Try again, or choose the window again on the Mac.');
    }
    return { viewId, startedAt: live.startedAt };
  }

  /**
   * The newest frame after `after`, waiting up to `waitMs` for one. Resolves
   * to null when none arrives in time; rejects when this phone is not viewing
   * (anymore), so the phone can show why.
   */
  async frame(viewer: Viewer, viewId: string, after: number, waitMs: number): Promise<Frame | null> {
    const live = this.viewing(viewer, viewId);
    this.renew(live);
    if (live.frame && live.frame.seq > after) return live.frame;
    if (waitMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, waitMs);
        function done() { clearTimeout(timer); live.waiters.delete(done); resolve(); }
        live.waiters.add(done);
      });
    }
    const current = this.viewing(viewer, viewId);
    return current.frame && current.frame.seq > after ? current.frame : null;
  }

  /** The viewing phone ends its own view; another phone cannot end it. */
  stopForPhone(viewer: Viewer, viewId: string): boolean {
    if (this.live?.viewer.id !== viewer.id || this.live.viewId !== viewId) return false;
    this.end('stopped-by-phone');
    return true;
  }

  stopAtMac(): void { this.end('stopped-at-mac'); }

  /** Revoking a phone ends its view at once. */
  endForDevice(deviceId: string): void {
    if (this.live?.viewer.id === deviceId) this.end('revoked');
  }

  shutdown(): void {
    this.end('service-stopped');
    this.selected = undefined;
  }

  private async requireGranted(): Promise<void> {
    const permission = await this.options.driver.permission();
    if (permission === 'unsupported') throw new WindowViewError('unsupported', UNSUPPORTED_HELP);
    if (permission !== 'granted') throw new WindowViewError('permission-denied', PERMISSION_HELP);
  }

  private viewing(viewer: Viewer, viewId: string): Live {
    const live = this.live;
    if (live?.viewer.id !== viewer.id || live.viewId !== viewId) {
      const ended = this.lastEnded?.viewerId === viewer.id ? this.lastEnded.message : 'This phone is not viewing a Mac window.';
      throw new WindowViewError('not-viewing', ended);
    }
    return live;
  }

  private renew(live: Live): void {
    clearTimeout(live.lease);
    live.lease = setTimeout(() => { if (this.live === live) this.end('phone-left'); }, this.leaseMs);
    live.lease.unref();
  }

  private async checkPermission(viewId: string): Promise<void> {
    let permission: ScreenPermission;
    try { permission = await this.options.driver.permission(); } catch { permission = 'denied'; }
    if (permission !== 'granted' && this.live?.viewId === viewId) this.end('permission-withdrawn');
  }

  private wake(live: Live): void {
    for (const waiter of [...live.waiters]) waiter();
  }

  private end(reason: EndReason): void {
    const live = this.live;
    if (!live) return;
    this.live = undefined;
    clearTimeout(live.lease);
    clearInterval(live.permissionWatch);
    live.handle.stop();
    live.frame = undefined;
    this.lastEnded = { reason, message: END_MESSAGE[reason], at: this.now().toISOString(), viewerId: live.viewer.id, viewer: live.viewer.label };
    this.wake(live);
  }
}
