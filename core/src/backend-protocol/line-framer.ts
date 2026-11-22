const newline = 0x0a;

/**
 * Splits a byte stream into newline-terminated text frames.
 *
 * Every byte is scanned once and every frame is decoded once, so the cost of a frame grows with its size and not with
 * the number of chunks it arrived in. Decoding whole frames also keeps multi-byte characters intact when a chunk
 * boundary falls inside them. Frames are returned without their newline; trimming is left to the caller.
 *
 * Byte chunks are referenced until their frame completes, so a caller must not reuse a chunk it has handed over.
 */
export class LineFramer {
  private readonly decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  private readonly encoder = new TextEncoder();
  private pieces: Uint8Array[] = [];
  private pending = 0;
  /** First half of a character that a text chunk ended on; it is encoded together with the half that follows. */
  private heldSurrogate = '';

  /** Bytes received for the frame that has not been terminated yet. */
  get pendingBytes(): number {
    return this.pending;
  }

  /** Returns the frames completed by this chunk, in order. */
  push(chunk: Uint8Array | string): string[] {
    if (typeof chunk === 'string') return this.pushBytes(this.encode(chunk));
    // Bytes cannot complete a character started as text, so the held half is encoded on its own (as U+FFFD).
    const held = this.heldSurrogate ? this.pushBytes(this.encode('', true)) : [];
    return held.length ? [...held, ...this.pushBytes(chunk)] : this.pushBytes(chunk);
  }

  /** Drops the unfinished frame, for a stream that ended or was replaced. */
  reset(): void {
    this.pieces = [];
    this.pending = 0;
    this.heldSurrogate = '';
  }

  private encode(text: string, flush = false): Uint8Array {
    let whole = this.heldSurrogate + text;
    this.heldSurrogate = '';
    const last = whole.charCodeAt(whole.length - 1);
    if (!flush && last >= 0xd800 && last <= 0xdbff) {
      this.heldSurrogate = whole.slice(-1);
      whole = whole.slice(0, -1);
    }
    return this.encoder.encode(whole);
  }

  private pushBytes(bytes: Uint8Array): string[] {
    const frames: string[] = [];
    let start = 0;
    while (start < bytes.length) {
      const end = bytes.indexOf(newline, start);
      if (end < 0) {
        this.pieces.push(bytes.subarray(start));
        this.pending += bytes.length - start;
        break;
      }
      frames.push(this.complete(bytes.subarray(start, end)));
      start = end + 1;
    }
    return frames;
  }

  private complete(last: Uint8Array): string {
    if (this.pieces.length === 0) return this.decoder.decode(last);
    const frame = new Uint8Array(this.pending + last.length);
    let offset = 0;
    for (const piece of this.pieces) {
      frame.set(piece, offset);
      offset += piece.length;
    }
    frame.set(last, offset);
    this.pieces = [];
    this.pending = 0;
    return this.decoder.decode(frame);
  }
}
