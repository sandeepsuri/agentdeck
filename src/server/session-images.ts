// Images the agent looked at, served one at a time for the Conversation view
// on the Mac and the paired owner phone. Responses are JSON so they travel
// through the relay like any other phone request; the relay carries at most
// one 1 MiB frame per answer, so an image larger than MAX_IMAGE_BYTES is
// re-encoded as a smaller JPEG on the Mac with macOS's own `sips`.
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { TranscriptImage } from '../sessions/conversation.js';

const execFileAsync = promisify(execFile);

/** Leaves room in one relay frame for base64, the JSON wrapper and sealing. */
export const MAX_IMAGE_BYTES = 480 * 1024;

/** Each attempt: the longest side in pixels and the JPEG quality. */
const STEPS: readonly [number, number][] = [[2400, 75], [1800, 65], [1280, 55], [900, 45]];

export type Shrink = (image: TranscriptImage, maxSide: number, quality: number) => Promise<Buffer>;

async function sipsShrink(image: TranscriptImage, maxSide: number, quality: number): Promise<Buffer> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-image-'));
  try {
    const input = path.join(dir, `in.${image.mediaType.split('/')[1] ?? 'png'}`);
    const output = path.join(dir, 'out.jpg');
    await fsp.writeFile(input, image.data);
    await execFileAsync('/usr/bin/sips', ['-Z', String(maxSide), '-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), input, '--out', output],
      { timeout: 20_000 });
    return await fsp.readFile(output);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/** The image as sent: unchanged when small enough, else the first smaller JPEG that fits; undefined when none does. */
export async function fitImage(image: TranscriptImage, shrink: Shrink = sipsShrink): Promise<TranscriptImage | undefined> {
  if (image.data.length <= MAX_IMAGE_BYTES) return image;
  for (const [maxSide, quality] of STEPS) {
    let data: Buffer;
    try {
      data = await shrink(image, maxSide, quality);
    } catch {
      return undefined;
    }
    if (data.length <= MAX_IMAGE_BYTES) return { mediaType: 'image/jpeg', data };
  }
  return undefined;
}
