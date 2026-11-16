import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { decodeScript, mergeScripts, parseScript } from '../src/script/load';
import { TextLibrary } from '../src/ui/text';

const parser = new DOMParser() as any;
const file = (p: string) => readFileSync(resolve(__dirname, p));

describe('bundled JUNO-Di wave name table', () => {
  const table = parseScript(file('../src/data/JunoDiWaveNameTable.xml').toString('utf8'), parser);
  const buf = file('../../Script/JUXE/Script.xml');
  const script = parseScript(decodeScript(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), parser);
  const text = new TextLibrary(mergeScripts(script, table));
  const waves = text.strings.get('internalWaveNameTable')!;

  it('has one entry per wave, entry 1 = wave 0001', () => {
    expect(waves).toHaveLength(850);
    expect(waves[0]).toBe('Ult.P*mp A L');
    expect(waves[455]).toBe('JV Strings L'); // wave 0456
    expect(waves[849]).toBe('TB Dst Saw C'); // wave 0850
    expect(waves.every((n) => n.length > 0 && n.length <= 12)).toBe(true);
  });

  it('decodes XML entities like Script.xml tables', () => {
    expect(waves).toContain('Swish&Turn');
  });

  it('sits alongside Script.xml tables without replacing them', () => {
    expect(text.strings.get('srx01WaveNameTable')?.[0]).toBe('Kick 1 Menu');
    expect(text.strings.get('lfoWaveFormTable')?.[0]).toBe('SIN');
  });
});
