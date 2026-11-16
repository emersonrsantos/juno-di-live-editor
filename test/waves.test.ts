import { describe, it, expect } from 'vitest';
import { WaveNames } from '../src/data/waves';

/** Fake synth with `total` waves; records requests and answers after a tick. */
function synth(total = 850) {
  const requests: number[] = [];
  let online = true;
  const fetch = async (first: number, count: number): Promise<[number, string][] | null> => {
    requests.push(first);
    await new Promise((r) => setTimeout(r, 1));
    if (!online) return null;
    const rows: [number, string][] = [];
    // like the JUNO-Di: past the last wave, entries come back numbered but with blank names
    for (let n = first; n < first + count; n++) rows.push([n, n <= total ? `W${n}` : '']);
    return rows;
  };
  const waves = new WaveNames();
  waves.fetch = fetch;
  return { waves, requests, setOnline: (v: boolean) => (online = v) };
}

describe('WaveNames', () => {
  it('prefetches every block and stops at the end of the list', async () => {
    const { waves, requests } = synth(850);
    await waves.prefetch();
    expect(waves.peek(1)).toBe('W1');
    expect(waves.peek(850)).toBe('W850');
    expect(waves.complete).toBe(true);
    expect(waves.count).toBe(850);
    // 27 blocks of 32 cover 850 waves; the 28th returns nothing and marks the end
    expect(requests.length).toBe(28);
    await waves.prefetch(); // already complete: no more requests
    expect(requests.length).toBe(28);
  });

  it('fetches the block of an on-screen wave immediately', async () => {
    const { waves, requests } = synth();
    expect(waves.get(456)).toBeUndefined();
    expect(requests).toEqual([449]); // block 14 = waves 449..480
    await new Promise((r) => setTimeout(r, 5));
    expect(waves.get(456)).toBe('W456');
    expect(requests).toEqual([449]); // no duplicate request
  });

  it('lets on-screen blocks overtake the background loader', async () => {
    const { waves, requests } = synth();
    const all = waves.prefetch();
    await new Promise((r) => setTimeout(r, 0));
    waves.get(800);
    await all;
    // the far block was requested before the loader reached it, and only once
    expect(requests.indexOf(769)).toBeLessThan(5);
    expect(requests.filter((f) => f === 769).length).toBe(1);
    expect(waves.peek(800)).toBe('W800');
  });

  it('does not loop or give up while the synth is offline', async () => {
    const { waves, requests, setOnline } = synth();
    setOnline(false);
    let updates = 0;
    waves.onUpdate = () => updates++;
    await waves.prefetch();
    expect(updates).toBe(0); // no redraw -> no re-request storm
    expect(requests.length).toBe(1); // loader stops at the first failure
    setOnline(true);
    await waves.prefetch();
    expect(waves.complete).toBe(true);
  });

  it('reset forgets names and stops a running loader', async () => {
    const { waves } = synth();
    const run = waves.prefetch();
    waves.reset();
    await run;
    expect(waves.peek(1)).toBeUndefined();
    expect(waves.complete).toBe(false);
  });
});
