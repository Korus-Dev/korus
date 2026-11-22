import { describe, expect, it } from 'vitest';
import { LineFramer } from '../line-framer';

const encode = (text: string) => new TextEncoder().encode(text);

function split(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) chunks.push(bytes.subarray(offset, offset + size));
  return chunks;
}

function frames(framer: LineFramer, chunks: Array<Uint8Array | string>): string[] {
  return chunks.flatMap(chunk => framer.push(chunk));
}

describe('LineFramer', () => {
  it('reassembles one frame delivered in many small chunks', () => {
    const text = JSON.stringify({ payload: 'x'.repeat(200_000) });
    const framer = new LineFramer();

    const received = frames(framer, split(encode(`${text}\n`), 1_021));

    expect(received).toStrictEqual([text]);
    expect(framer.pendingBytes).toBe(0);
  });

  it('keeps multi-byte characters intact when a chunk boundary falls inside them', () => {
    const text = 'é—😀 naïve façade '.repeat(500);
    const bytes = encode(`${text}\n`);

    // Every chunk size shifts where the two-, three- and four-byte sequences are cut.
    for (const size of [1, 2, 3, 5, 7, 4_099]) {
      expect(frames(new LineFramer(), split(bytes, size))).toStrictEqual([text]);
    }
  });

  it('returns every frame of a chunk in order and keeps the unfinished tail for the next chunk', () => {
    const framer = new LineFramer();

    expect(framer.push(encode('first\nsecond\nthi'))).toStrictEqual(['first', 'second']);
    expect(framer.pendingBytes).toBe(3);
    expect(framer.push(encode('rd\n\nfourth\n'))).toStrictEqual(['third', '', 'fourth']);
    expect(framer.pendingBytes).toBe(0);
  });

  it('accepts already decoded text chunks alongside bytes', () => {
    const framer = new LineFramer();

    expect(frames(framer, ['{"a":', encode('"é"}\n{"b"'), ':2}\n'])).toStrictEqual(['{"a":"é"}', '{"b":2}']);
  });

  it('keeps a character whose two code units arrive in separate text chunks', () => {
    const framer = new LineFramer();

    expect(frames(framer, ['{"s":"\uD83D', '\uDE00"}\n'])).toStrictEqual(['{"s":"😀"}']);
  });

  it('does not join half a character held from before a reset to the next stream', () => {
    const framer = new LineFramer();
    framer.push('stale\uD83D');

    framer.reset();

    expect(framer.push('\uDE00\n')).toStrictEqual(['\uFFFD']);
  });

  it('drops the unfinished frame on reset so a new stream starts clean', () => {
    const framer = new LineFramer();
    framer.push(encode('{"stale":'));

    framer.reset();

    expect(framer.pendingBytes).toBe(0);
    expect(framer.push(encode('{"fresh":true}\n'))).toStrictEqual(['{"fresh":true}']);
  });

  it('does not strip a byte order mark or carriage return, leaving trimming to the caller', () => {
    const framer = new LineFramer();

    expect(framer.push(encode('﻿one\r\n'))).toStrictEqual(['﻿one\r']);
  });
});
