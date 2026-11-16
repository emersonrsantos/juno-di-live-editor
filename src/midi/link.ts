// Web MIDI connection to the JUNO-Di: sends parameter edits as DT1, applies incoming
// DT1 to the model, and performs bulk Read (RQ1) / Sync (DT1) transfers.

import { Model, Block } from '../model/model';
import { chunk, dt1, parseDT1, rq1 } from './roland';

const STORE = 'juno-di-editor.midi';

export class MidiLink {
  access?: MIDIAccess;
  input?: MIDIInput;
  output?: MIDIOutput;
  deviceId = 0x10;
  through = false;
  private pending = new Map<number, { address: number; data: number[] }>();
  private flushScheduled = false;
  private lastRx = 0;
  /** DT1 listeners used by command queries (name lists). */
  private taps = new Set<(address: number, data: number[]) => void>();
  /** Serialises bulk transfers so name queries never interleave with Read/Sync/Write. */
  private chain: Promise<unknown> = Promise.resolve();
  onState: () => void = () => {};
  onLog: (s: string) => void = () => {};

  constructor(
    private model: Model,
    readonly modelId: number[],
    private roots: string[],
  ) {
    model.onChange((b, off, len, src) => {
      if (src !== 'ui' || !this.roots.includes(b.root)) return;
      // coalesce rapid edits of the same address into one message per frame
      const address = b.address + off;
      this.pending.set(address, { address, data: Array.from(b.data.subarray(off, off + len)) });
      this.scheduleFlush();
    });
  }

  get supported() {
    return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
  }

  async init() {
    if (!this.supported) throw new Error('Web MIDI is not available in this browser (use Chrome or Edge).');
    this.access = await navigator.requestMIDIAccess({ sysex: true });
    this.access.onstatechange = () => this.onState();
    let saved: { in?: string; out?: string; dev?: number; through?: boolean } = {};
    try {
      saved = JSON.parse(localStorage.getItem(STORE) ?? '{}');
    } catch {}
    if (saved.dev) this.deviceId = saved.dev;
    this.through = !!saved.through;
    const ins = [...this.access.inputs.values()];
    const outs = [...this.access.outputs.values()];
    const guess = <T extends MIDIPort>(list: T[]) => list.find((p) => /juno/i.test(p.name ?? '')) ?? list[0];
    this.selectInput(ins.find((p) => p.id === saved.in) ?? guess(ins));
    this.selectOutput(outs.find((p) => p.id === saved.out) ?? guess(outs));
  }

  private save() {
    try {
      localStorage.setItem(
        STORE,
        JSON.stringify({ in: this.input?.id, out: this.output?.id, dev: this.deviceId, through: this.through }),
      );
    } catch {}
  }

  setDeviceId(id: number) {
    this.deviceId = id;
    this.save();
  }
  setThrough(on: boolean) {
    this.through = on;
    this.save();
  }

  selectInput(p: MIDIInput | undefined) {
    if (this.input) this.input.onmidimessage = null;
    this.input = p;
    if (p) p.onmidimessage = (e) => this.receive(e.data!);
    this.save();
    this.onState();
  }

  selectOutput(p: MIDIOutput | undefined) {
    this.output = p;
    this.save();
    this.onState();
  }

  private receive(data: Uint8Array) {
    if (data[0] === 0xf0) {
      const msg = parseDT1(data, this.modelId);
      if (!msg) return;
      this.lastRx = performance.now();
      for (const t of this.taps) t(msg.address, msg.data);
      for (const r of this.roots) this.model.writeBytes(r, msg.address, msg.data, 'midi');
      return;
    }
    if (this.through && this.output && data[0] < 0xf0) this.output.send(data);
  }

  send(bytes: number[]) {
    this.output?.send(bytes);
  }

  private scheduleFlush() {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    requestAnimationFrame(() => {
      this.flushScheduled = false;
      for (const p of this.pending.values()) this.send(dt1(this.deviceId, this.modelId, p.address, p.data));
      this.pending.clear();
    });
  }

  note(on: boolean, channel: number, note: number, velocity: number) {
    this.send([(on ? 0x90 : 0x80) | (channel & 15), note & 127, on ? velocity & 127 : 0]);
  }

  /** Run a transfer exclusively (after any transfer already in progress). */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * cm.command queries are RQ1s whose 4-byte size field carries the argument; the synth
   * answers with a stream of DT1s at the same address, ended by an all-zero entry.
   */
  async query(address: number, arg: number[], timeoutMs = 1500): Promise<number[][]> {
    if (!this.output) throw new Error('No MIDI output selected');
    const out: number[][] = [];
    let last = performance.now();
    let ended = false;
    const tap = (a: number, d: number[]) => {
      if (a !== address) return;
      last = performance.now();
      if (d.every((b) => b === 0)) ended = true;
      else out.push(d);
    };
    this.taps.add(tap);
    try {
      const size = arg.reduce((x, b) => x * 128 + (b & 0x7f), 0);
      this.send(rq1(this.deviceId, this.modelId, address, size));
      const start = performance.now();
      while (!ended) {
        await sleep(20);
        const now = performance.now();
        if (!out.length && now - start > timeoutMs) break;
        if (out.length && now - last > 300) break;
      }
    } finally {
      this.taps.delete(tap);
    }
    return out;
  }

  /** Request regions one at a time, waiting for the device to go quiet between them. */
  async read(regions: { address: number; size: number; label: string }[], progress: (i: number, n: number, label: string) => void) {
    if (!this.output) throw new Error('No MIDI output selected');
    for (let i = 0; i < regions.length; i++) {
      const r = regions[i];
      progress(i, regions.length, r.label);
      const sent = performance.now();
      this.lastRx = 0;
      this.send(rq1(this.deviceId, this.modelId, r.address, r.size));
      // wait for first reply (max 1s), then until 120 ms of silence
      while (true) {
        await sleep(20);
        const now = performance.now();
        if (!this.lastRx && now - sent > 1000) break;
        if (this.lastRx && now - this.lastRx > 120) break;
      }
    }
    progress(regions.length, regions.length, '');
  }

  /** Transmit blocks as DT1, paced to avoid overrunning the device's input buffer. */
  async sync(blocks: Block[], progress: (i: number, n: number) => void) {
    if (!this.output) throw new Error('No MIDI output selected');
    const msgs = blocks.flatMap((b) => chunk(b.address, b.data));
    for (let i = 0; i < msgs.length; i++) {
      this.send(dt1(this.deviceId, this.modelId, msgs[i].address, msgs[i].data));
      if (i % 4 === 3) {
        progress(i, msgs.length);
        await sleep(25);
      }
    }
    progress(msgs.length, msgs.length);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
