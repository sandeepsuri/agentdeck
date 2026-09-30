import { afterEach, describe, expect, it } from 'vitest';
import { BROWSER, EDITOR, fakeCaptureDriver } from '../test-fixtures/fake-capture.js';
import { MAX_FRAME_BYTES, WindowViewService, type WindowViewError } from './service.js';

const PHONE = { id: 'phone-1', label: 'Sam’s iPhone' };
const OTHER_PHONE = { id: 'phone-2', label: 'Old iPhone' };
const fakeDriver = fakeCaptureDriver;

const jpeg = (fill: number, size = 64) => Buffer.alloc(size, fill);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await wait(5);
  }
}

let service: WindowViewService | undefined;
afterEach(() => { service?.shutdown(); service = undefined; });

function make(driver = fakeDriver(), options: { leaseMs?: number; permissionCheckMs?: number } = {}) {
  service = new WindowViewService({ driver, leaseMs: options.leaseMs ?? 5_000, permissionCheckMs: options.permissionCheckMs ?? 5_000 });
  return { service, driver };
}

describe('WindowViewService (issue #91)', () => {
  it('refuses to start until the owner has chosen a window on the Mac', async () => {
    const { service, driver } = make();
    await expect(service.start(PHONE)).rejects.toMatchObject({ code: 'no-window' });
    expect(driver.captures).toHaveLength(0);
  });

  it('explains denied Screen Recording permission instead of listing or capturing', async () => {
    const { service, driver } = make();
    await service.select(EDITOR.id);
    driver.permissionState = 'denied';
    await expect(service.windows()).rejects.toMatchObject({ code: 'permission-denied' });
    const refused = await service.start(PHONE).catch((error: WindowViewError) => error);
    expect(refused).toMatchObject({ code: 'permission-denied' });
    expect((refused as Error).message).toMatch(/Screen Recording/);
    expect(driver.captures).toHaveLength(0);
  });

  it('only selects a window the Mac currently offers', async () => {
    const { service } = make();
    await expect(service.select(999)).rejects.toMatchObject({ code: 'not-found' });
    expect(service.status().window).toBeNull();
  });

  it('captures only the selected window and gives its frames only to the phone viewing it', async () => {
    const { service, driver } = make();
    await service.select(EDITOR.id);
    const view = await service.start(PHONE);
    expect(driver.captures.map((capture) => capture.window.id)).toEqual([EDITOR.id]);

    driver.captures[0]!.events.onFrame({ jpeg: jpeg(1), width: 800, height: 600 });
    const frame = await service.frame(PHONE, view.viewId, 0, 0);
    expect(frame).toMatchObject({ seq: 1, width: 800, height: 600 });
    expect(frame?.jpeg.equals(jpeg(1))).toBe(true);

    await expect(service.frame(OTHER_PHONE, view.viewId, 0, 0)).rejects.toMatchObject({ code: 'not-viewing' });
    expect(service.status().live).toMatchObject({ viewer: PHONE.label, window: { app: 'TextEdit', title: 'Notes.txt' } });
  });

  it('waits briefly for the next frame, and answers with none when nothing new arrives', async () => {
    const { service, driver } = make();
    await service.select(EDITOR.id);
    const view = await service.start(PHONE);
    expect(await service.frame(PHONE, view.viewId, 0, 20)).toBeNull();
    const next = service.frame(PHONE, view.viewId, 0, 1_000);
    driver.captures[0]!.events.onFrame({ jpeg: jpeg(2), width: 10, height: 10 });
    expect(await next).toMatchObject({ seq: 1 });
  });

  it('drops a frame too large to send through the relay', async () => {
    const { service, driver } = make();
    await service.select(EDITOR.id);
    const view = await service.start(PHONE);
    driver.captures[0]!.events.onFrame({ jpeg: jpeg(3, MAX_FRAME_BYTES + 1), width: 10, height: 10 });
    expect(await service.frame(PHONE, view.viewId, 0, 0)).toBeNull();
  });

  it('ends the capture at once when the phone stops, and says why afterwards', async () => {
    const { service, driver } = make();
    await service.select(EDITOR.id);
    const view = await service.start(PHONE);
    const waiting = service.frame(PHONE, view.viewId, 0, 5_000);
    service.stopForPhone(PHONE, view.viewId);
    expect(driver.captures[0]!.stopped).toBe(true);
    await expect(waiting).rejects.toMatchObject({ code: 'not-viewing' });
    expect(service.status().live).toBeNull();
    expect(service.phoneStatus(PHONE)).toMatchObject({ viewing: null, ended: { reason: 'stopped-by-phone' } });
  });

  it('ends the capture when the viewing phone is revoked, and not for another phone', async () => {
    const { service, driver } = make();
    await service.select(EDITOR.id);
    await service.start(PHONE);
    service.endForDevice(OTHER_PHONE.id);
    expect(driver.captures[0]!.stopped).toBe(false);
    service.endForDevice(PHONE.id);
    expect(driver.captures[0]!.stopped).toBe(true);
    expect(service.status().lastEnded).toMatchObject({ reason: 'revoked' });
  });

  it('ends the capture promptly when Screen Recording permission is withdrawn', async () => {
    const { service, driver } = make(fakeDriver(), { permissionCheckMs: 10 });
    await service.select(EDITOR.id);
    await service.start(PHONE);
    driver.permissionState = 'denied';
    await until(() => driver.captures[0]!.stopped);
    expect(service.status().lastEnded).toMatchObject({ reason: 'permission-withdrawn' });
  });

  it('ends the view when the capture itself ends, such as the window closing', async () => {
    const { service, driver } = make();
    await service.select(EDITOR.id);
    await service.start(PHONE);
    driver.captures[0]!.events.onEnd('window-closed');
    expect(service.status()).toMatchObject({ live: null, lastEnded: { reason: 'window-closed' } });
    expect(service.phoneStatus(PHONE).ended?.message).toMatch(/closed/);
  });

  it('stops capturing when the phone stops asking for frames', async () => {
    const { service, driver } = make(fakeDriver(), { leaseMs: 30 });
    await service.select(EDITOR.id);
    await service.start(PHONE);
    await until(() => driver.captures[0]!.stopped);
    expect(service.status().lastEnded).toMatchObject({ reason: 'phone-left' });
  });

  it('lets the Mac stop the view, change the window, or stop sharing altogether', async () => {
    const { service, driver } = make();
    await service.select(EDITOR.id);
    await service.start(PHONE);
    service.stopAtMac();
    expect(driver.captures[0]!.stopped).toBe(true);

    await service.start(PHONE);
    await service.select(BROWSER.id);
    expect(driver.captures[1]!.stopped).toBe(true);
    expect(service.status().lastEnded).toMatchObject({ reason: 'selection-changed' });

    await service.start(PHONE);
    expect(driver.captures[2]!.window.id).toBe(BROWSER.id);
    service.clear();
    expect(driver.captures[2]!.stopped).toBe(true);
    expect(service.status().window).toBeNull();
    await expect(service.start(PHONE)).rejects.toMatchObject({ code: 'no-window' });
  });

  it('gives the view to one phone at a time', async () => {
    const { service, driver } = make();
    await service.select(EDITOR.id);
    const first = await service.start(PHONE);
    expect((await service.start(PHONE)).viewId).toBe(first.viewId);
    expect(driver.captures).toHaveLength(1);
    await service.start(OTHER_PHONE);
    expect(driver.captures[0]!.stopped).toBe(true);
    expect(service.phoneStatus(PHONE).ended).toMatchObject({ reason: 'replaced' });
  });

  it('ends any capture when the service shuts down', async () => {
    const { service, driver } = make();
    await service.select(EDITOR.id);
    await service.start(PHONE);
    service.shutdown();
    expect(driver.captures[0]!.stopped).toBe(true);
  });
});
