import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { decodeScript, parseScript } from '../src/script/load';
import { Model, addrHex } from '../src/model/model';
import { readJxe, writeJxe } from '../src/model/jxe';
import { compileExpr, compileValueRef } from '../src/model/expr';
import type { XNode } from '../src/script/xnode';

const ASSETS = resolve(__dirname, '../../Script/JUXE');
let script: XNode;
let model: Model;

beforeAll(() => {
  const buf = readFileSync(resolve(ASSETS, 'Script.xml'));
  script = parseScript(decodeScript(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), new DOMParser() as any);
  model = new Model(script);
});

describe('model', () => {
  it('builds the address map', () => {
    const v = compileValueRef('fm.pat[3].tone[2].toneLevel')(model)!;
    expect(addrHex(v.address)).toBe('11 60 24 00');
    expect(addrHex(compileValueRef('fm.pat[16].common.patchName')(model)!.address)).toBe('1F 00 00 00');
    expect(addrHex(compileValueRef('fm.system.common.masterLevel')(model)!.address).startsWith('02 00 00')).toBe(true);
  });

  it('applies defaults', () => {
    expect(model.getString(compileValueRef('fm.pat[0].common.patchName')(model)!)).toBe('INIT PATCH  ');
    expect(model.get(compileValueRef('fm.pat[0].common.patchPan')(model)!)).toBe(64);
    expect(model.get(compileValueRef('vs.patchNameList.listCurRangeUp')(model)!)).toBe(41);
  });

  it('round-trips InitialData.jxe byte for byte', () => {
    const file = readFileSync(resolve(ASSETS, 'InitialData.jxe'));
    const ab = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
    readJxe(model, ab);
    expect(model.getString(compileValueRef('fm.pfm.common.performanceName')(model)!)).toBe('INIT PERFORM');
    const out = writeJxe(model);
    expect(out.length).toBe(file.length);
    expect(Buffer.from(out).equals(file)).toBe(true);
  });

  it('evaluates RPN expressions with nested refs', () => {
    model.set(compileValueRef('vs.control.partId')(model)!, 20, 'internal');
    const r = compileValueRef('fm.pat[vs.control.partId,0,15,@clip].common.patchLevel')(model)!;
    expect(r.path).toBe('fm.pat[15].common.patchLevel');
    expect(compileExpr('1,2,+,3,==')(model)).toBe(1);
    expect(compileExpr('vs.control.mode,0,==,1,0,||,&&')(model)).toBe(1);
  });

  it('encodes nibble values', () => {
    const v = compileValueRef('fm.pat[0].tone[0].toneDelayTime')(model)!;
    model.set(v, 0x93);
    expect(Array.from(v.block.data.subarray(v.def.offset, v.def.offset + 2))).toEqual([9, 3]);
    expect(model.get(v)).toBe(0x93);
  });
});
