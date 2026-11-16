// Roland exclusive messages (DT1 data set / RQ1 data request) with 4-byte 7-bit addresses.

import { addrBytes } from '../model/model';

export const ROLAND = 0x41;
export const DT1 = 0x12;
export const RQ1 = 0x11;

export function checksum(bytes: number[]): number {
  const s = bytes.reduce((a, b) => a + b, 0);
  return (128 - (s % 128)) % 128;
}

export function dt1(deviceId: number, model: number[], address: number, data: ArrayLike<number>): number[] {
  const body = [...addrBytes(address, 4), ...Array.from(data, (b) => b & 0x7f)];
  return [0xf0, ROLAND, deviceId, ...model, DT1, ...body, checksum(body), 0xf7];
}

export function rq1(deviceId: number, model: number[], address: number, size: number): number[] {
  const body = [...addrBytes(address, 4), ...addrBytes(size, 4)];
  return [0xf0, ROLAND, deviceId, ...model, RQ1, ...body, checksum(body), 0xf7];
}

export interface ParsedDT1 {
  deviceId: number;
  address: number;
  data: number[];
}

export function parseDT1(msg: ArrayLike<number>, model: number[]): ParsedDT1 | undefined {
  const n = model.length;
  if (msg.length < 8 + n + 2 || msg[0] !== 0xf0 || msg[1] !== ROLAND) return undefined;
  for (let i = 0; i < n; i++) if (msg[3 + i] !== model[i]) return undefined;
  if (msg[3 + n] !== DT1) return undefined;
  const start = 4 + n;
  const end = msg.length - 2; // checksum, F7
  const body = Array.from(msg).slice(start, end);
  if (checksum(body) !== msg[end]) return undefined;
  let address = 0;
  for (let i = 0; i < 4; i++) address = address * 128 + body[i];
  return { deviceId: msg[2], address, data: body.slice(4) };
}

/** Split a block write into DT1-sized chunks (7-bit address arithmetic). */
export function chunk(address: number, data: ArrayLike<number>, max = 128): { address: number; data: number[] }[] {
  const out: { address: number; data: number[] }[] = [];
  for (let i = 0; i < data.length; i += max) {
    out.push({ address: address + i, data: Array.from(data).slice(i, i + max) });
  }
  return out;
}
