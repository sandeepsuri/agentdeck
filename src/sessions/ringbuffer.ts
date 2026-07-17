/**
 * Bounded buffer of recent raw terminal output, replayed on (re)attach.
 * Chunks are kept whole and trimmed from the front — cutting a chunk in half
 * could split a VT escape sequence, which xterm.js tolerates, but whole-chunk
 * trimming makes it a non-issue for ~free.
 */
export class RingBuffer {
  private chunks: string[] = [];
  private size = 0;

  constructor(private capacity: number = 64 * 1024) {}

  push(data: string): void {
    this.chunks.push(data);
    this.size += data.length;
    while (this.size > this.capacity && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.size -= dropped === undefined ? 0 : dropped.length;
    }
    // single oversized chunk: keep its tail
    const first = this.chunks[0];
    if (this.size > this.capacity && this.chunks.length === 1 && first !== undefined) {
      this.chunks[0] = first.slice(first.length - this.capacity);
      this.size = this.capacity;
    }
  }

  snapshot(): string {
    return this.chunks.join('');
  }

  clear(): void {
    this.chunks = [];
    this.size = 0;
  }
}
