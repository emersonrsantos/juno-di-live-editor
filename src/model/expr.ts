// RPN expression language used throughout Script.xml, e.g.
//   vs.control.mode,1,==,vs.control.entityType,1,==,&&
//   fm.pat[vs.control.partId,0,15,@clip].common.patchName
// Tokens are comma separated; references may contain bracketed sub-expressions.

import { Model, Node, ValueNode, splitPath } from './model';

export type RefFn = (m: Model) => Node | undefined;
export type ExprFn = (m: Model) => number;

const OPS: Record<string, { n: number; f: (...a: number[]) => number }> = {
  '==': { n: 2, f: (a, b) => +(a === b) },
  '!=': { n: 2, f: (a, b) => +(a !== b) },
  '>=': { n: 2, f: (a, b) => +(a >= b) },
  '<=': { n: 2, f: (a, b) => +(a <= b) },
  '>': { n: 2, f: (a, b) => +(a > b) },
  '<': { n: 2, f: (a, b) => +(a < b) },
  '&&': { n: 2, f: (a, b) => +(!!a && !!b) },
  '||': { n: 2, f: (a, b) => +(!!a || !!b) },
  '+': { n: 2, f: (a, b) => a + b },
  '-': { n: 2, f: (a, b) => a - b },
  '*': { n: 2, f: (a, b) => a * b },
  '/': { n: 2, f: (a, b) => (b ? Math.trunc(a / b) : 0) },
  '%': { n: 2, f: (a, b) => (b ? a % b : 0) },
  '!': { n: 1, f: (a) => +!a },
  '&': { n: 2, f: (a, b) => a & b },
  '|': { n: 2, f: (a, b) => a | b },
  '@clip': { n: 3, f: (x, lo, hi) => Math.max(lo, Math.min(hi, x)) },
  '@min': { n: 2, f: (a, b) => Math.min(a, b) },
  '@max': { n: 2, f: (a, b) => Math.max(a, b) },
};

export function splitTokens(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out.filter((t) => t.length);
}

const NUM_RE = /^[+-]?\d+$/;
const HEX_RE = /^0x[0-9a-f]+$/i;

const exprCache = new Map<string, ExprFn>();
const refCache = new Map<string, RefFn>();

export function isRef(tok: string) {
  return /^[A-Za-z_]/.test(tok) && tok.includes('.');
}

export function compileExpr(src: string): ExprFn {
  const hit = exprCache.get(src);
  if (hit) return hit;
  const toks = splitTokens(src);
  const prog: ((stack: number[], m: Model) => void)[] = [];
  for (const t of toks) {
    if (NUM_RE.test(t)) {
      const n = parseInt(t, 10);
      prog.push((s) => s.push(n));
    } else if (HEX_RE.test(t)) {
      const n = parseInt(t, 16);
      prog.push((s) => s.push(n));
    } else if (t in OPS) {
      const op = OPS[t];
      prog.push((s) => {
        const args = s.splice(Math.max(0, s.length - op.n), op.n);
        while (args.length < op.n) args.unshift(0);
        s.push(op.f(...args));
      });
    } else if (t.startsWith('$')) {
      // unresolved template variable -> 0
      prog.push((s) => s.push(0));
    } else {
      const r = compileRef(t);
      prog.push((s, m) => {
        const n = r(m);
        s.push(n && n.isValue ? m.get(n) : 0);
      });
    }
  }
  const fn: ExprFn = (m) => {
    const stack: number[] = [];
    for (const p of prog) p(stack, m);
    return stack.length ? stack[stack.length - 1] : 0;
  };
  exprCache.set(src, fn);
  return fn;
}

export function compileRef(src: string): RefFn {
  const key = src.replace(/\s+/g, '');
  const hit = refCache.get(key);
  if (hit) return hit;
  const segs = splitPath(key).map((seg) => {
    const i = seg.indexOf('[');
    if (i < 0 || !seg.endsWith(']')) return { key: seg };
    const name = seg.slice(0, i);
    const inner = seg.slice(i + 1, -1);
    if (NUM_RE.test(inner)) return { key: `${name}[${parseInt(inner, 10)}]` };
    return { name, idx: compileExpr(inner) };
  });
  const fn: RefFn = (m) => {
    let n: Node | undefined = m.roots.get((segs[0] as { key: string }).key);
    for (let i = 1; n && i < segs.length; i++) {
      if (n.isValue) return undefined;
      const s = segs[i] as { key?: string; name?: string; idx?: ExprFn };
      const k = s.key ?? `${s.name}[${s.idx!(m)}]`;
      n = n.children.get(k);
    }
    return n;
  };
  refCache.set(key, fn);
  return fn;
}

export function compileValueRef(src: string): (m: Model) => ValueNode | undefined {
  const r = compileRef(src);
  return (m) => {
    const n = r(m);
    return n && n.isValue ? n : undefined;
  };
}
