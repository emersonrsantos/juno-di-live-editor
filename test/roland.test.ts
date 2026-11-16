import { describe, it, expect } from 'vitest';
import { checksum, chunk, dt1, parseDT1, rq1 } from '../src/midi/roland';
import { parseAddr } from '../src/model/model';

const MODEL = [0x00, 0x00, 0x3a];

describe('roland sysex', () => {
  it('computes the Roland checksum (GS reset example)', () => {
    expect(checksum([0x40, 0x00, 0x7f, 0x00])).toBe(0x41);
  });

  it('builds DT1 and RQ1 messages', () => {
    expect(dt1(0x10, MODEL, parseAddr('11 00 00 0E'), [100])).toEqual([
      0xf0, 0x41, 0x10, 0, 0, 0x3a, 0x12, 0x11, 0, 0, 0x0e, 0x64, 0x7d, 0xf7,
    ]);
    const r = rq1(0x10, MODEL, parseAddr('1F 00 00 00'), parseAddr('00 00 00 50'));
    expect(r.slice(6, 15)).toEqual([0x11, 0x1f, 0, 0, 0, 0, 0, 0, 0x50]);
    expect(r[15]).toBe(checksum([0x1f, 0, 0, 0, 0, 0, 0, 0x50]));
  });

  it('parses DT1 and rejects bad checksums / other models', () => {
    const m = dt1(0x10, MODEL, parseAddr('10 00 20 07'), [55, 56]);
    expect(parseDT1(m, MODEL)).toEqual({ deviceId: 0x10, address: parseAddr('10 00 20 07'), data: [55, 56] });
    const bad = [...m];
    bad[bad.length - 2] ^= 1;
    expect(parseDT1(bad, MODEL)).toBeUndefined();
    expect(parseDT1(m, [0, 0, 0x15])).toBeUndefined();
  });

  it('chunks across 7-bit address boundaries', () => {
    const parts = chunk(parseAddr('11 00 00 70'), new Array(300).fill(1));
    expect(parts.map((p) => p.data.length)).toEqual([128, 128, 44]);
    expect(parts[1].address).toBe(parseAddr('11 00 01 70'));
  });
});
