// Wave names live on the synth, not in Script.xml. Streaming all of them takes ~17 s
// (≈50 names/s), so they are fetched in blocks:
//  - blocks containing waves that are on screen are requested immediately;
//  - after connecting, a background loader walks the remaining blocks one at a time, so
//    the full list is ready by the time a wave dropdown is opened. Because it waits for
//    each block before queuing the next, on-screen requests never wait behind it for long.

/**
 * Fetch names for waves [first, first + count). Resolves to [wave number, name] pairs
 * (empty = past the last wave) or null if the synth did not answer.
 */
export type WaveFetcher = (first: number, count: number) => Promise<[number, string][] | null>;

export class WaveNames {
  static readonly BLOCK = 32;
  /** JUNO-Di internal waves; used to size lists before every name has arrived. */
  static readonly EXPECTED = 850;

  private names: (string | undefined)[] = [];
  private blocks = new Map<number, Promise<number>>();
  private done = new Set<number>();
  private endBlock = Infinity;
  private generation = 0;
  private prefetching = false;

  fetch: WaveFetcher = async () => null;
  onUpdate: () => void = () => {};

  /** Name of a 1-based wave number, requesting its block if it isn't known yet. */
  get(n: number): string | undefined {
    if (n < 1) return undefined;
    const name = this.names[n - 1];
    if (name === undefined) void this.requestBlock(Math.floor((n - 1) / WaveNames.BLOCK));
    return name;
  }

  /** Name if already known, without triggering a request (for building long lists). */
  peek(n: number): string | undefined {
    return this.names[n - 1];
  }

  /** Number of waves to list: everything known so far, at least the expected count. */
  get count() {
    return Math.max(this.names.length, this.endBlock === Infinity ? WaveNames.EXPECTED : this.names.length);
  }

  get complete() {
    return this.endBlock !== Infinity && [...Array(this.endBlock).keys()].every((b) => this.done.has(b));
  }

  /** Forget everything (a different or reconnected synth). Running loaders stop. */
  reset() {
    this.generation++;
    this.names = [];
    this.blocks.clear();
    this.done.clear();
    this.endBlock = Infinity;
    this.prefetching = false;
  }

  /** Load all remaining blocks in the background; safe to call repeatedly. */
  async prefetch() {
    if (this.prefetching || this.complete) return;
    this.prefetching = true;
    const gen = this.generation;
    try {
      for (let b = 0; b < this.endBlock && gen === this.generation; b++) {
        if (this.done.has(b)) continue;
        const got = await this.requestBlock(b);
        if (got < 0) return; // no MIDI / no answer: try again on the next prefetch
      }
    } finally {
      if (gen === this.generation) this.prefetching = false;
    }
  }

  private requestBlock(b: number): Promise<number> {
    if (b >= this.endBlock || this.done.has(b)) return Promise.resolve(0);
    const pending = this.blocks.get(b);
    if (pending) return pending;
    const gen = this.generation;
    const first = b * WaveNames.BLOCK + 1;
    const p = this.fetch(first, WaveNames.BLOCK).then((rows) => {
      // answers for a previous synth/connection are dropped
      if (gen !== this.generation) return -1;
      this.blocks.delete(b);
      if (!rows) return -1; // no answer; no redraw either, or it would re-request and spin while offline
      // Past the last wave the JUNO-Di answers with numbered entries whose names are blank,
      // so only named entries count, and a block without any marks the end of the list.
      let kept = 0;
      for (const [n, name] of rows)
        if (name && n >= first && n < first + WaveNames.BLOCK) {
          this.names[n - 1] = name;
          kept++;
        }
      this.done.add(b);
      if (!kept) this.endBlock = Math.min(this.endBlock, b);
      this.onUpdate();
      return kept;
    });
    this.blocks.set(b, p);
    return p;
  }
}
