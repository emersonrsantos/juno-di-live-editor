// Parameter model built from <structType>/<struct>/<value> definitions.
// Every struct that directly owns values is backed by a byte block addressed in the
// synth's 7-bit address space; values are typed views onto those bytes. Several values
// may alias the same bytes (MFX parameters are typed per effect type), exactly like the
// device's own memory map.

import { XNode, child, childText, childrenOf, subst, Vars, varsOf } from '../script/xnode';

export type ValueKind = 'int1x7' | 'int2x4' | 'int4x4' | 'int5x7' | 'string';

/** Parse "11 20 00 00" (7-bit bytes, big endian) into a linear integer. */
export function parseAddr(s: string): number {
  let v = 0;
  for (const b of s.trim().split(/\s+/)) if (b) v = v * 128 + parseInt(b, 16);
  return v;
}

export function addrBytes(lin: number, n = 4): number[] {
  const out = new Array<number>(n);
  for (let i = n - 1; i >= 0; i--) {
    out[i] = lin % 128;
    lin = Math.floor(lin / 128);
  }
  return out;
}

export function addrHex(lin: number, n = 4): string {
  return addrBytes(lin, n)
    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ');
}

export class Block {
  readonly data: Uint8Array;
  constructor(
    readonly root: string,
    readonly path: string,
    readonly address: number,
    size: number,
  ) {
    this.data = new Uint8Array(size);
  }
  get size() {
    return this.data.length;
  }
}

export interface ValueDef {
  kind: ValueKind;
  name: string;
  offset: number; // relative to owning block
  size: number;
  min: number;
  max: number;
  def: string;
}

export class ValueNode {
  readonly isValue = true;
  constructor(
    readonly path: string,
    readonly def: ValueDef,
    readonly block: Block,
  ) {}
  get min() {
    return this.def.min;
  }
  get max() {
    return this.def.max;
  }
  get address() {
    return this.block.address + this.def.offset;
  }
}

export class StructNode {
  readonly isValue = false;
  readonly children = new Map<string, StructNode | ValueNode>();
  block?: Block;
  constructor(
    readonly path: string,
    readonly type: string,
    readonly address: number,
  ) {}
}

export type Node = StructNode | ValueNode;

type Source = 'ui' | 'midi' | 'file' | 'init' | 'internal';
export type ChangeListener = (block: Block, offset: number, length: number, source: Source) => void;

interface StructTypeDef {
  type: string;
  node: XNode;
}

export class Model {
  readonly roots = new Map<string, StructNode>();
  /** Leaf blocks per root, in declaration order (this is also the .jxe file order). */
  readonly blocks = new Map<string, Block[]>();
  private sortedBlocks = new Map<string, Block[]>();
  private types = new Map<string, StructTypeDef>();
  private listeners: ChangeListener[] = [];
  version = 0;

  constructor(script: XNode) {
    for (const st of childrenOf(script, 'structType')) {
      const type = childText(st, 'type')!;
      this.types.set(type, { type, node: st });
    }
    for (const s of childrenOf(script, 'struct')) {
      const name = childText(s, 'name')!;
      const blocks: Block[] = [];
      this.blocks.set(name, blocks);
      const node = this.instantiate(name, s, 0, name, blocks, {});
      this.roots.set(name, node);
      this.sortedBlocks.set(
        name,
        [...blocks].sort((a, b) => a.address - b.address),
      );
    }
    this.resetAll();
  }

  private instantiate(
    root: string,
    inst: XNode,
    parentAddr: number,
    path: string,
    blocks: Block[],
    parentVars: Vars,
    addressOverride?: number,
  ): StructNode {
    const typeName = childText(inst, 'type')!;
    const td = this.types.get(typeName);
    if (!td) throw new Error(`Unknown structType ${typeName}`);
    const vars = varsOf(inst, parentVars);
    const instAddr = addressOverride ?? parseAddr(vars.address ?? '00');
    const address = parentAddr + instAddr;
    const node = new StructNode(path, typeName, address);

    const values = childrenOf(td.node, 'value');
    if (values.length) {
      const defs = values.map((v) => compileValue(v, vars));
      const declared = parseAddr(subst(childText(td.node, 'size') ?? '00', vars).replace('$size', '00'));
      let end = defs.reduce((m, d) => Math.max(m, d.offset + d.size), 0);
      // Values without an <address> are editor-only state: give each private storage
      // past the end of the block so they never alias addressed parameters.
      end = Math.max(end, declared);
      for (const d of defs)
        if (d.offset < 0) {
          d.offset = end;
          end += d.size;
        }
      const block = new Block(root, path, address, Math.max(declared, end));
      blocks.push(block);
      node.block = block;
      for (const d of defs) node.children.set(d.name, new ValueNode(`${path}.${d.name}`, d, block));
    }

    for (const sub of childrenOf(td.node, 'struct')) {
      const subType = childText(sub, 'type')!;
      const subTd = this.types.get(subType)!;
      let name = childText(sub, 'name');
      if (name) name = subst(name, vars);
      else name = subst(childText(subTd.node, 'name') ?? subType, {});
      const addrs = childrenOf(sub, 'address').map((a) => parseAddr(subst(a.text, vars)));
      if (addrs.length <= 1) {
        const p = `${path}.${name}`;
        node.children.set(name, this.instantiate(root, sub, address, p, blocks, { ...vars, name }, addrs[0] ?? 0));
      } else {
        addrs.forEach((a, i) => {
          const n = `${name}[${i}]`;
          const p = `${path}.${n}`;
          node.children.set(n, this.instantiate(root, sub, address, p, blocks, { ...vars, name: n }, a));
        });
      }
    }
    return node;
  }

  resetAll() {
    for (const [, blocks] of this.blocks)
      for (const b of blocks) this.resetBlock(b);
    this.version++;
  }

  resetBlock(b: Block) {
    b.data.fill(0);
    // defaults: find the struct node owning this block
    const node = this.nodeAt(b.path);
    if (node && !node.isValue) {
      for (const c of node.children.values()) if (c.isValue) this.rawWrite(c, c.def.def);
    }
  }

  /**
   * Effect structs hold parameter sets for every effect type ("superFilter-rateHz", ...).
   * When the type changes, the device re-initialises that type's parameters; mirror that.
   * Prefix order in the struct follows type order, with type 0 (THROUGH/OFF) having none.
   */
  resetTypeParams(struct: StructNode, type: number, src: Source = 'internal') {
    const prefixes: string[] = [];
    for (const k of struct.children.keys()) {
      const i = k.indexOf('-');
      if (i > 0 && !prefixes.includes(k.slice(0, i))) prefixes.push(k.slice(0, i));
    }
    const prefix = prefixes[type - 1];
    if (!prefix) return;
    for (const [k, c] of struct.children)
      if (c.isValue && k.startsWith(prefix + '-')) this.rawWrite(c, c.def.def);
    if (struct.block) this.emit(struct.block, 0, struct.block.size, src);
  }

  nodeAt(path: string): Node | undefined {
    const parts = splitPath(path);
    let n: Node | undefined = this.roots.get(parts[0]);
    for (let i = 1; n && i < parts.length; i++) n = n.isValue ? undefined : n.children.get(parts[i]);
    return n;
  }

  onChange(l: ChangeListener) {
    this.listeners.push(l);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l);
    };
  }

  private emit(b: Block, off: number, len: number, src: Source) {
    this.version++;
    for (const l of this.listeners) l(b, off, len, src);
  }

  // ---------- typed access ----------

  get(v: ValueNode): number {
    const d = v.def;
    const a = v.block.data;
    const o = d.offset;
    switch (d.kind) {
      case 'int1x7':
        return a[o] & 0x7f;
      case 'int2x4':
        return ((a[o] & 15) << 4) | (a[o + 1] & 15);
      case 'int4x4':
        return ((a[o] & 15) << 12) | ((a[o + 1] & 15) << 8) | ((a[o + 2] & 15) << 4) | (a[o + 3] & 15);
      case 'int5x7': {
        let x = 0;
        for (let i = 0; i < 5; i++) x = x * 128 + (a[o + i] & 0x7f);
        return x;
      }
      case 'string':
        return 0;
    }
  }

  getString(v: ValueNode): string {
    if (v.def.kind !== 'string') return String(this.get(v));
    let s = '';
    for (let i = 0; i < v.def.size; i++) {
      const c = v.block.data[v.def.offset + i];
      s += String.fromCharCode(c >= 32 && c < 127 ? c : 32);
    }
    return s;
  }

  set(v: ValueNode, value: number, src: Source = 'ui'): boolean {
    if (v.def.kind === 'string') return false;
    const x = Math.max(v.def.min, Math.min(v.def.max, Math.round(value)));
    if (x === this.get(v)) return false;
    this.encode(v, x);
    this.emit(v.block, v.def.offset, v.def.size, src);
    return true;
  }

  setString(v: ValueNode, s: string, src: Source = 'ui') {
    const d = v.def;
    for (let i = 0; i < d.size; i++) {
      const c = i < s.length ? s.charCodeAt(i) : 32;
      v.block.data[d.offset + i] = c >= 32 && c < 127 ? c : 32;
    }
    this.emit(v.block, d.offset, d.size, src);
  }

  private rawWrite(v: ValueNode, def: string) {
    if (v.def.kind === 'string') {
      for (let i = 0; i < v.def.size; i++) v.block.data[v.def.offset + i] = i < def.length ? def.charCodeAt(i) : 32;
    } else {
      const n = parseInt(def, 10);
      this.encode(v, isNaN(n) ? v.def.min : n);
    }
  }

  private encode(v: ValueNode, x: number) {
    const a = v.block.data;
    const o = v.def.offset;
    switch (v.def.kind) {
      case 'int1x7':
        a[o] = x & 0x7f;
        break;
      case 'int2x4':
        a[o] = (x >> 4) & 15;
        a[o + 1] = x & 15;
        break;
      case 'int4x4':
        a[o] = (x >> 12) & 15;
        a[o + 1] = (x >> 8) & 15;
        a[o + 2] = (x >> 4) & 15;
        a[o + 3] = x & 15;
        break;
      case 'int5x7':
        for (let i = 4; i >= 0; i--) {
          a[o + i] = x % 128;
          x = Math.floor(x / 128);
        }
        break;
    }
  }

  // ---------- raw address access (MIDI) ----------

  /** Write raw bytes at an absolute address of a root (e.g. from a DT1 message). */
  writeBytes(root: string, address: number, bytes: ArrayLike<number>, src: Source = 'midi'): number {
    const blocks = this.sortedBlocks.get(root) ?? [];
    let written = 0;
    let lo = 0;
    let hi = blocks.length - 1;
    // first block whose end > address
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (blocks[mid].address + blocks[mid].size <= address) lo = mid + 1;
      else hi = mid;
    }
    // Address arithmetic is in 7-bit space; a DT1 payload is contiguous in that space.
    for (let i = lo; i < blocks.length; i++) {
      const b = blocks[i];
      const start = Math.max(address, b.address);
      const end = Math.min(address + bytes.length, b.address + b.size);
      if (b.address >= address + bytes.length) break;
      if (end <= start) continue;
      for (let k = start; k < end; k++) b.data[k - b.address] = bytes[k - address] & 0x7f;
      written += end - start;
      this.emit(b, start - b.address, end - start, src);
    }
    return written;
  }

  /** Replace a whole block's contents without per-byte notifications. */
  loadBlock(b: Block, bytes: ArrayLike<number>, src: Source = 'file') {
    b.data.set(Array.prototype.slice.call(bytes, 0, b.size));
    this.emit(b, 0, b.size, src);
  }
}

function compileValue(v: XNode, vars: Vars): ValueDef {
  const t = (s: string | undefined) => (s === undefined ? undefined : subst(s, vars));
  const range = t(childText(v, 'range'));
  let min = 0;
  let max = 127;
  const kind = childText(v, 'type') as ValueKind;
  if (range) {
    const [a, b] = range.split(',').map((x) => parseInt(x, 10));
    min = a;
    max = b;
  } else if (kind === 'int4x4') max = 65535;
  else if (kind === 'int2x4') max = 255;
  return {
    kind,
    name: t(childText(v, 'name'))!,
    offset: childText(v, 'address') === undefined ? -1 : parseAddr(t(childText(v, 'address'))!),
    size: parseAddr(t(childText(v, 'size')) ?? '01'),
    min,
    max,
    def: t(childText(v, 'default')) ?? String(min),
  };
}

/** Split "fm.pat[3].tone[0].x" into ["fm","pat[3]","tone[0]","x"] respecting brackets. */
export function splitPath(p: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of p) {
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    if (ch === '.' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export { child };
