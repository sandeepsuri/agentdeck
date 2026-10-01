import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FrameDecoder, MAX_HELPER_FRAME_BYTES, nativeCaptureDriver, parseWindowList } from './window-capture.js';

function encode(width: number, height: number, jpeg: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(jpeg.length, 0);
  header.writeUInt16BE(width, 4);
  header.writeUInt16BE(height, 6);
  return Buffer.concat([header, jpeg]);
}

describe('FrameDecoder (issue #91)', () => {
  it('reassembles frames the helper writes, however stdout splits them', () => {
    const frames: { width: number; height: number; jpeg: Buffer }[] = [];
    const decoder = new FrameDecoder((frame) => frames.push(frame));
    const stream = Buffer.concat([encode(640, 480, Buffer.from('first')), encode(2, 1, Buffer.from('second frame'))]);
    for (let i = 0; i < stream.length; i += 3) decoder.push(stream.subarray(i, i + 3));
    expect(frames.map((frame) => [frame.width, frame.height, frame.jpeg.toString()])).toEqual([
      [640, 480, 'first'], [2, 1, 'second frame'],
    ]);
  });

  it('refuses a frame length no helper would send', () => {
    const decoder = new FrameDecoder(() => undefined);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(MAX_HELPER_FRAME_BYTES + 1, 0);
    expect(() => decoder.push(header)).toThrow(/too large/);
  });
});

describe('parseWindowList', () => {
  it('keeps only well-formed windows and trims long titles', () => {
    const listed = parseWindowList(JSON.stringify([
      { id: 7, app: 'Notes', title: 'x'.repeat(300) },
      { id: 'eight', app: 'Mail', title: 'Inbox' },
      { id: 9, app: '', title: 'No app' },
    ]));
    expect(listed).toEqual([{ id: 7, app: 'Notes', title: 'x'.repeat(200) }]);
  });
});

describe.runIf(process.platform === 'darwin')('nativeCaptureDriver with a stand-in helper', () => {
  // Behaves like AgentDeckWindowView: answers permission and list, and for
  // capture writes one frame, then exits by the code in CAPTURE_EXIT or waits
  // for stdin to close.
  const helper = (dir: string) => {
    const file = path.join(dir, 'helper.mjs');
    fs.writeFileSync(file, `#!${process.execPath}
import fs from 'node:fs';
const [command, id] = process.argv.slice(2);
if (command === 'permission') { process.stdout.write(process.env.PERMISSION ?? 'granted'); process.exit(0); }
if (command === 'list') {
  if (process.env.PERMISSION === 'denied') process.exit(3);
  process.stdout.write(JSON.stringify([{ id: 5, app: 'Notes', title: 'Todo' }])); process.exit(0);
}
if (command === 'capture') {
  const jpeg = Buffer.from('frame-for-' + id);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(jpeg.length, 0); header.writeUInt16BE(4, 4); header.writeUInt16BE(3, 6);
  process.stdout.write(Buffer.concat([header, jpeg]));
  if (process.env.CAPTURE_EXIT) setTimeout(() => process.exit(Number(process.env.CAPTURE_EXIT)), 20);
  process.stdin.on('end', () => { fs.writeFileSync(process.env.STOPPED_FILE, 'stopped'); process.exit(0); });
  process.stdin.resume();
}
`);
    fs.chmodSync(file, 0o755);
    return file;
  };

  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-window-capture-')); });
  afterEach(() => {
    for (const key of ['PERMISSION', 'CAPTURE_EXIT', 'STOPPED_FILE']) delete process.env[key];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads permission and the window list from a fresh helper each time', async () => {
    const driver = nativeCaptureDriver(helper(dir));
    expect(await driver.permission()).toBe('granted');
    expect(await driver.listWindows()).toEqual([{ id: 5, app: 'Notes', title: 'Todo' }]);
    process.env.PERMISSION = 'denied';
    expect(await driver.permission()).toBe('denied');
    await expect(driver.listWindows()).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('streams the one window it was asked for, and stopping ends the helper', async () => {
    process.env.STOPPED_FILE = path.join(dir, 'stopped');
    const driver = nativeCaptureDriver(helper(dir));
    const frames: string[] = [];
    const ends: string[] = [];
    const handle = driver.capture({ id: 42, app: 'Notes', title: 'Todo' }, {
      onFrame: (frame) => frames.push(frame.jpeg.toString()),
      onEnd: (reason) => ends.push(reason),
    });
    await until(() => frames.length === 1);
    expect(frames).toEqual(['frame-for-42']);
    handle.stop();
    await until(() => fs.existsSync(process.env.STOPPED_FILE!));
    expect(ends).toEqual([]);
  });

  it('reports withdrawn permission and a closed window from the helper exit code', async () => {
    const driver = nativeCaptureDriver(helper(dir));
    for (const [code, reason] of [['3', 'permission-denied'], ['4', 'window-closed'], ['5', 'stopped-at-mac'], ['9', 'failed']] as const) {
      process.env.CAPTURE_EXIT = code;
      const ends: string[] = [];
      driver.capture({ id: 1, app: 'Notes', title: 'Todo' }, { onFrame: () => undefined, onEnd: (end) => ends.push(end) });
      await until(() => ends.length === 1);
      expect(ends).toEqual([reason]);
    }
  });
});

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
