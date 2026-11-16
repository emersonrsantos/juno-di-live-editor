import { GM2_PATCH_NAMES, GM2_RHYTHM_NAMES, MFX_TYPES } from './gm2';

export interface ListEntry {
  label: string;
  msb: number;
  lsb: number;
  pc: number;
}

/** Which cm.command name query serves a bank (RQ1 0F 00 0x 02, size = [MSB LSB first count]). */
export type NameSource = 'performance' | 'patch' | 'rhythm';

export interface Bank {
  label: string;
  msb: number;
  lsb: number;
  count: number;
  /** display number of entry i, as the JUNO-Di shows it */
  number: (i: number) => string;
  source?: NameSource;
  names?: string[];
}

const n4 = (x: number) => String(x).padStart(4, '0');

/** JUNO-Di display number of a user slot: program 0 -> "0501", 63 -> "0564", 127 -> "0628". */
export function userSlot(pc: number) {
  return n4(501 + pc);
}

// Bank layout measured on a JUNO-Di: user patches MSB 87 LSB 0 (0501-0628, writable),
// presets MSB 87 LSB 64-72 (1082 patches),
// rhythm sets MSB 86 LSB 64 (20), performances MSB 85 LSB 64 (64) and the only
// writable memory, user performances MSB 85 LSB 0 (0501-0564).
const PRESET_PATCH_TOTAL = 1082;
const PATCH_BANKS: Bank[] = [
  { label: 'USER 0501-0628', msb: 87, lsb: 0, count: 128, number: userSlot, source: 'patch' },
  ...Array.from({ length: 9 }, (_, b) => {
    const first = b * 128 + 1;
    const count = Math.min(128, PRESET_PATCH_TOTAL - b * 128);
    return {
      label: `PRESET ${n4(first)}-${n4(first + count - 1)}`,
      msb: 87,
      lsb: 64 + b,
      count,
      number: (i: number) => n4(first + i),
      source: 'patch' as const,
    };
  }),
  { label: 'RHYTHM SET', msb: 86, lsb: 64, count: 20, number: (i) => `R${String(i + 1).padStart(3, '0')}`, source: 'rhythm' },
  { label: 'GM2', msb: 121, lsb: 0, count: GM2_PATCH_NAMES.length, number: (i) => `GM${String(i + 1).padStart(3, '0')}`, names: GM2_PATCH_NAMES },
  { label: 'GM2 RHYTHM', msb: 120, lsb: 0, count: GM2_RHYTHM_NAMES.length, number: (i) => `GMR${i + 1}`, names: GM2_RHYTHM_NAMES },
];

const PERFORMANCE_BANKS: Bank[] = [
  { label: 'USER 0501-0564', msb: 85, lsb: 0, count: 64, number: userSlot, source: 'performance' },
  { label: 'PRESET 0001-0064', msb: 85, lsb: 64, count: 64, number: (i) => n4(i + 1), source: 'performance' },
];

export class NameTables {
  readonly mfx = MFX_TYPES;
  readonly patchBanks = PATCH_BANKS.map((b) => b.label);
  readonly performanceBanks = PERFORMANCE_BANKS.map((b) => b.label);
  /** Names received from the device keyed by "msb:lsb:pc". */
  private deviceNames = new Map<string, string>();
  private requested = new Set<string>();
  /** Called the first time a device-backed bank is shown; the app fetches it over MIDI. */
  onNeed: (bank: Bank) => Promise<boolean> = async () => false;
  onUpdate: () => void = () => {};

  setName(msb: number, lsb: number, pc: number, name: string) {
    this.deviceNames.set(`${msb}:${lsb}:${pc}`, name);
  }

  /** Forget fetched names so they are requested again (e.g. after connecting a synth). */
  invalidate(msb?: number, lsb?: number) {
    for (const k of [...this.requested]) if (msb === undefined || k === `${msb}:${lsb}`) this.requested.delete(k);
  }

  private ensure(b: Bank) {
    if (!b.source) return;
    const key = `${b.msb}:${b.lsb}`;
    if (this.requested.has(key)) return;
    this.requested.add(key);
    this.onNeed(b).then((ok) => {
      if (!ok) this.requested.delete(key); // retry once MIDI is available
      this.onUpdate();
    });
  }

  private list(b: Bank | undefined): ListEntry[] {
    if (!b) return [];
    this.ensure(b);
    const out: ListEntry[] = [];
    for (let i = 0; i < b.count; i++) {
      const name = this.deviceNames.get(`${b.msb}:${b.lsb}:${i}`) ?? b.names?.[i] ?? '';
      out.push({ label: `${b.number(i)}  ${name}`, msb: b.msb, lsb: b.lsb, pc: i });
    }
    return out;
  }

  /** Name of the sound at a bank-select/program address, if known. */
  nameOf(msb: number, lsb: number, pc: number): string | undefined {
    const d = this.deviceNames.get(`${msb}:${lsb}:${pc}`);
    if (d !== undefined) return d;
    return [...PATCH_BANKS, ...PERFORMANCE_BANKS].find((b) => b.msb === msb && b.lsb === lsb)?.names?.[pc];
  }

  patchList(bank: number) {
    return this.list(PATCH_BANKS[bank]);
  }
  performanceList(bank = 0) {
    return this.list(PERFORMANCE_BANKS[bank]);
  }
}
