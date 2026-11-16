// .jxe "KoaDataFile" format used by JUXE.exe:
//   0x00  "KoaDataFile00001"               (16 bytes)
//   0x10  root struct name, space padded   (64 bytes)  -> "fm"
//   0x50  model name, space padded         (16 bytes)  -> "JUNO-Di"
//   0x60  zero padding up to 0x100
//   0x100 raw bytes of every leaf block of the root struct, in script declaration order.

import { Model } from './model';

const MAGIC = 'KoaDataFile00001';
const HEADER = 0x100;

function ascii(bytes: Uint8Array, start: number, len: number) {
  return String.fromCharCode(...bytes.subarray(start, start + len)).trimEnd();
}

export function readJxe(model: Model, buf: ArrayBuffer, root = 'fm') {
  const bytes = new Uint8Array(buf);
  if (ascii(bytes, 0, 16) !== MAGIC) throw new Error('Not a JUXE data file (bad header)');
  const fileRoot = ascii(bytes, 0x10, 64);
  if (fileRoot !== root) throw new Error(`Unexpected root struct "${fileRoot}"`);
  const blocks = model.blocks.get(root)!;
  const expected = HEADER + blocks.reduce((n, b) => n + b.size, 0);
  if (bytes.length < expected) throw new Error(`File too short: ${bytes.length} < ${expected} bytes`);
  let off = HEADER;
  for (const b of blocks) {
    model.loadBlock(b, bytes.subarray(off, off + b.size), 'file');
    off += b.size;
  }
  return { model: ascii(bytes, 0x50, 16) };
}

export function writeJxe(model: Model, root = 'fm', modelName = 'JUNO-Di'): Uint8Array {
  const blocks = model.blocks.get(root)!;
  const out = new Uint8Array(HEADER + blocks.reduce((n, b) => n + b.size, 0));
  const put = (s: string, at: number, len: number) => {
    const p = s.padEnd(len, ' ');
    for (let i = 0; i < len; i++) out[at + i] = p.charCodeAt(i);
  };
  put(MAGIC, 0, 16);
  put(root, 0x10, 64);
  put(modelName, 0x50, 16);
  let off = HEADER;
  for (const b of blocks) {
    out.set(b.data, off);
    off += b.size;
  }
  return out;
}
