import { XNode, childText, childrenOf } from './script/xnode';
import { Model, StructNode, ValueNode } from './model/model';
import { compileValueRef } from './model/expr';
import { readJxe, writeJxe } from './model/jxe';
import { SkinLibrary } from './ui/bitmaps';
import { TextLibrary } from './ui/text';
import { PanelBuilder } from './ui/panels';
import { Control, Env, MenuItem, Rect, createControl, unknownTypes } from './ui/controls';
import { Window } from './ui/view';
import { Bank, NameTables, userSlot } from './data/names';
import { MidiLink } from './midi/link';
import { rq1 } from './midi/roland';

const MAIN_WINDOW_POS: [number, number] = [20, 60];
const RHYTHM_MSB = new Set([86, 120]);

export class App implements Env {
  model: Model;
  skins: SkinLibrary;
  text: TextLibrary;
  names = new NameTables();
  midi: MidiLink;
  windows: Window[] = [];
  private dirty = false;
  private vsScheduled = false;
  private lastMode: number | undefined;
  private followingSynth = false;
  private zoom = 1;
  private lastPerformPart = 0;
  private statusEl = document.getElementById('status')!;
  private desk = document.getElementById('desk')!;
  private fileName = 'Untitled.jxe';

  constructor(
    private script: XNode,
    private assetBase: string,
  ) {
    this.model = new Model(script);
    this.skins = new SkinLibrary(script, assetBase);
    this.text = new TextLibrary(script);
    const out = childrenOf(script, 'midiOut').find((m) => childText(m, 'modelID'))!;
    const modelId = childText(out, 'modelID')!.split(/\s+/).map((b) => parseInt(b, 16));
    const roots = childrenOf(out, 'rootStruct').map((r) => r.text);
    this.midi = new MidiLink(this.model, modelId, roots);
    this.names.onUpdate = () => this.invalidate();
    // a (re)connected synth may hold different user names: fetch them again
    this.midi.onPortChange = () => {
      this.names.invalidate();
      this.status(
        this.midi.output
          ? `Connected to ${this.midi.output.name}.`
          : 'JUNO-Di disconnected. It will reconnect automatically when it is switched on or plugged in.',
      );
      this.invalidate();
    };
    this.midi.onDirty = () => {
      const n = this.midi.dirty.size;
      if (n && !this.midi.realtime) this.status(`${n} edited block${n > 1 ? 's' : ''} not sent yet — press Sync to send to the JUNO-Di.`);
      this.invalidate();
    };
    this.names.onNeed = (bank) => this.fetchNames(bank);
    this.names.onNeedWaves = (first, count) => this.fetchWaveNames(first, count);
    this.model.onChange((b, off, _l, src) => {
      if (src === 'ui' && b.root === 'fm') this.onTypeChange(b.path, off);
      if (src !== 'internal' && !this.vsScheduled) {
        this.vsScheduled = true;
        queueMicrotask(() => {
          this.vsScheduled = false;
          this.updateViewState();
        });
      }
      this.invalidate();
    });
  }

  async start(progress: (s: string) => void) {
    await this.skins.loadAll((d, n) => progress(`Loading skins ${d}/${n}`));
    progress('Building panels');
    const builder = new PanelBuilder(this.script, (def, panel) => createControl(def, this, panel));
    for (const inst of childrenOf(this.script, 'panel')) {
      const root = builder.build(inst);
      if (!root) continue;
      const floating = this.windows.length > 0;
      const w = new Window(root, this.model, this.skins, floating);
      w.onStatus = (s) => this.status(s);
      w.invalidate = () => this.invalidate();
      if (floating) {
        const wp = root.windowPosition ?? [80, 160];
        w.el.style.left = `${Math.max(0, wp[0] - MAIN_WINDOW_POS[0])}px`;
        w.el.style.top = `${Math.max(0, wp[1] - MAIN_WINDOW_POS[1])}px`;
      }
      this.windows.push(w);
      this.desk.appendChild(w.el);
    }
    if (builder.missing.size) console.warn('Missing panel types', [...builder.missing]);
    if (unknownTypes.size) console.warn('Unsupported control types', [...unknownTypes]);
    try {
      const z = parseFloat(localStorage.getItem('juno-di-editor.zoom') ?? '');
      if (z) this.setZoom(z);
    } catch {}
    await this.loadInitial();
    this.updateViewState();
    this.render();
  }

  // ---------- Env ----------

  invalidate() {
    if (this.dirty) return;
    this.dirty = true;
    requestAnimationFrame(() => this.render());
  }

  private render() {
    this.dirty = false;
    for (const w of this.windows) {
      const open = !w.floating || w.isOpen();
      if (open !== w.visible) {
        w.visible = open;
        w.el.style.display = open ? '' : 'none';
      }
      if (open) w.render();
    }
  }

  status(s: string) {
    this.statusEl.textContent = s;
  }

  note(on: boolean, note: number) {
    const ks = (n: string) => {
      const v = compileValueRef(`vs.utility.keyboardState.${n}`)(this.model);
      return v ? this.model.get(v) : 0;
    };
    this.midi.note(on, ks('channel'), note, ks('velocity') || 100);
  }

  openMenu(ctl: Control, items: MenuItem[], onPick: (v: number) => void) {
    closeOverlays();
    const r = this.screenRect(ctl, { x: ctl.ax, y: ctl.ay, w: ctl.w, h: ctl.h });
    const menu = document.createElement('div');
    menu.className = 'jx-menu';
    const many = items.length > 24;
    for (const it of items) {
      const el = document.createElement('div');
      el.className = 'jx-menu-item' + (it.selected ? ' selected' : '');
      el.textContent = it.label;
      el.onpointerup = (e) => {
        e.stopPropagation();
        onPick(it.value);
        closeOverlays();
        ctl.pressed = false;
        this.invalidate();
      };
      menu.appendChild(el);
    }
    if (many) menu.style.columnCount = String(Math.min(4, Math.ceil(items.length / 32)));
    document.body.appendChild(menu);
    const mh = menu.offsetHeight;
    const top = r.y + r.h + mh > window.innerHeight ? Math.max(4, r.y - mh) : r.y + r.h;
    menu.style.left = `${Math.min(r.x, window.innerWidth - menu.offsetWidth - 4)}px`;
    menu.style.top = `${top}px`;
    menu.style.minWidth = `${r.w}px`;
    menu.querySelector('.selected')?.scrollIntoView({ block: 'center' });
    setTimeout(() => document.addEventListener('pointerdown', outside, { once: true }), 0);
    const outside = (e: Event) => {
      if (!menu.contains(e.target as Node)) {
        closeOverlays();
        ctl.pressed = false;
        this.invalidate();
      } else document.addEventListener('pointerdown', outside, { once: true });
    };
  }

  openEdit(ctl: Control, rect: Rect, value: string, maxLen: number, onDone: (v: string) => void) {
    closeOverlays();
    const r = this.screenRect(ctl, rect);
    const input = document.createElement('input');
    input.className = 'jx-edit';
    input.value = value;
    input.maxLength = maxLen;
    Object.assign(input.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    let done = false;
    const commit = (ok: boolean) => {
      if (done) return;
      done = true;
      // device names are printable ASCII only
      if (ok) onDone(input.value.replace(/[^\x20-\x7e]/g, ' ').padEnd(maxLen, ' ').slice(0, maxLen));
      input.remove();
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') commit(true);
      if (e.key === 'Escape') commit(false);
    };
    input.onblur = () => commit(true);
    document.body.appendChild(input);
    input.focus();
    input.select();
  }

  private screenRect(ctl: Control, r: Rect): Rect {
    const w = this.windows.find((w) => contains(w.root, ctl.panel)) ?? this.windows[0];
    const cr = w.canvas.getBoundingClientRect();
    return { x: cr.left + r.x * this.zoom, y: cr.top + r.y * this.zoom, w: r.w * this.zoom, h: r.h * this.zoom };
  }

  /** Sync is only needed (and only enabled) when real-time sync is off. */
  functionEnabled(name: string) {
    return name !== 'Sync' || !this.midi.realtime;
  }

  async setRealtime(on: boolean) {
    this.midi.setRealtime(on);
    this.invalidate();
    if (on && this.midi.dirty.size && this.midi.output) {
      // catch the synth up with edits made while real-time sync was off
      const blocks = [...this.midi.dirty];
      await this.midi.exclusive(() => this.midi.sync(blocks, () => this.status('Sending pending edits…')));
      this.status('Real-time sync on. Pending edits sent.');
    } else this.status(on ? 'Real-time sync on: edits are sent as you make them.' : 'Real-time sync off: press Sync to send edits.');
  }

  callFunction(name: string, ctl: Control) {
    if (!this.functionEnabled(name)) return;
    switch (name) {
      case 'Read':
        return void this.readFromDevice();
      case 'Sync':
        return void this.syncToDevice();
      case 'WritePerformance':
        return void this.writeToDevice('performance');
      case 'WritePatch':
        return void this.writeToDevice('patch');
      case 'SelectEntry':
      case 'SelectEntryClose':
        this.selectEntry(ctl, name === 'SelectEntryClose');
        return;
      case 'BankChanged':
        this.resetListScroll(ctl);
        return;
      case 'SelectRhythmKey':
        return;
      default:
        this.status(`Function "${name}" is not implemented`);
    }
  }

  // ---------- view-state logic (behaviour implemented inside JUXE.exe) ----------

  private v(path: string): ValueNode | undefined {
    return compileValueRef(path)(this.model);
  }
  private get(path: string) {
    const v = this.v(path);
    return v ? this.model.get(v) : 0;
  }
  private setInternal(path: string, x: number) {
    const v = this.v(path);
    if (v) this.model.set(v, x, 'internal');
  }

  updateViewState() {
    for (let i = 0; i < 16; i++)
      this.setInternal(`vs.control.partEntityType[${i}]`, RHYTHM_MSB.has(this.get(`fm.pfm.part[${i}].patchBankSelectMsb`)) ? 2 : 1);
    this.setInternal('vs.control.partEntityType[16]', RHYTHM_MSB.has(this.get('fm.setup.kbdPatchBankSelectMsb')) ? 2 : 1);
    this.setInternal('vs.control.partEntityType[17]', 2);
    const mode = this.get('vs.control.mode');
    let part = this.get('vs.control.partId');
    if (mode === 1) {
      if (part < 16) this.lastPerformPart = part;
      part = 16;
    } else if (part >= 16) part = this.lastPerformPart;
    else this.lastPerformPart = part;
    this.setInternal('vs.control.partId', part);
    this.setInternal('vs.control.entityType', this.get(`vs.control.partEntityType[${part}]`));
    // switching the editor's mode switches the synth (JUXE.exe: PERFORM -> soundMode 1, PATCH -> 0)
    if (mode !== this.lastMode) {
      const prev = this.lastMode;
      this.lastMode = mode;
      if (prev !== undefined && !this.followingSynth) {
        const sm = this.v('fm.setup.soundMode');
        if (sm) this.model.set(sm, mode === 1 ? 0 : 1, 'immediate');
      }
    }
    this.invalidate();
  }

  private onTypeChange(path: string, offset: number) {
    const s = this.model.nodeAt(path);
    if (!s || s.isValue) return;
    for (const name of ['mfxType', 'chorusType', 'reverbType']) {
      const v = s.children.get(name);
      if (v?.isValue && v.def.offset === offset) {
        const type = this.model.get(v);
        queueMicrotask(() => this.model.resetTypeParams(s, type));
      }
    }
  }

  // ---------- MIDI functions ----------

  private span(node: StructNode, label: string) {
    const blocks = this.model.blocks.get('fm')!.filter((b) => b.path === node.path || b.path.startsWith(node.path + '.'));
    const lo = Math.min(...blocks.map((b) => b.address));
    const hi = Math.max(...blocks.map((b) => b.address + b.size));
    return { address: lo, size: hi - lo, label, blocks };
  }

  private regions() {
    const fm = this.model.roots.get('fm')!;
    const ch = (n: string) => fm.children.get(n) as StructNode;
    const out = [this.span(ch('setup'), 'Setup'), this.span(ch('system'), 'System')];
    if (this.get('vs.control.mode') === 0) {
      out.push(this.span(ch('pfm'), 'Performance'));
      for (let i = 0; i < 16; i++) {
        const rhythm = this.get(`vs.control.partEntityType[${i}]`) === 2;
        out.push(this.span(ch(`${rhythm ? 'rhy' : 'pat'}[${i}]`), `Part ${i + 1}`));
      }
    } else {
      const rhythm = this.get('vs.control.entityType') === 2;
      out.push(this.span(ch(rhythm ? 'rhy[16]' : 'pat[16]'), rhythm ? 'Rhythm Set' : 'Patch'));
    }
    return out;
  }

  /**
   * Name lists come from cm.command queries: RQ1 0F 00 0x 02 with size = [MSB LSB first count].
   * Replies: performance [MSB LSB PC name×12]; patch / rhythm [MSB LSB PC category 00 name×12].
   * One query returns at most 127 entries, so banks are fetched in two halves.
   */
  private async fetchNames(bank: Bank): Promise<boolean> {
    if (!this.midi.output || !bank.source) return false;
    const sub = { performance: 2, rhythm: 4, patch: 3 }[bank.source];
    const address = this.v(`cm.command.${bank.source === 'rhythm' ? 'rhythmSet' : bank.source}NameInformation2`)?.address ?? 0x0f * 128 ** 3 + sub * 128 + 2;
    const nameAt = bank.source === 'performance' ? 3 : 5;
    try {
      return await this.midi.exclusive(async () => {
        for (let first = 0; first < bank.count; first += 64) {
          const rows = await this.midi.query(address, [bank.msb, bank.lsb, first, Math.min(64, bank.count - first)]);
          for (const d of rows) {
            if (d[0] !== bank.msb || d[1] !== bank.lsb) continue;
            this.names.setName(d[0], d[1], d[2], String.fromCharCode(...d.slice(nameAt, nameAt + 12)).trim());
          }
          this.invalidate();
        }
        return true;
      });
    } catch {
      return false;
    }
  }

  /**
   * Wave names: RQ1 cm.command.waveANameInformation2 (0F 00 01 02) with size =
   * [first wave as 3 nibbles, count] streams DT1 [wave number as 4 nibbles, name×12].
   * (waveANameInformation, 0F 00 01 01, streams all 850 waves but takes ~17 s.)
   */
  private async fetchWaveNames(first: number, count: number): Promise<number> {
    if (!this.midi.output) return -1;
    const address = this.v('cm.command.waveANameInformation2')!.address;
    try {
      const arg = [(first >> 8) & 15, (first >> 4) & 15, first & 15, count];
      const rows = await this.midi.exclusive(() => this.midi.query(address, arg, 1500));
      let got = 0;
      for (const d of rows) {
        const n = ((d[0] & 15) << 12) | ((d[1] & 15) << 8) | ((d[2] & 15) << 4) | (d[3] & 15);
        if (n < first || n >= first + count) continue;
        this.names.waves[n - 1] = String.fromCharCode(...d.slice(4, 16)).trim();
        got++;
      }
      this.invalidate();
      return got;
    } catch {
      return -1;
    }
  }

  async connectMidi() {
    try {
      await this.midi.init();
      this.names.invalidate();
      this.invalidate();
    } catch (e) {
      this.status(String((e as Error).message ?? e));
    }
  }

  async readFromDevice() {
    if (!this.midi.output) return this.status('Select a MIDI output first.');
    try {
      await this.midi.exclusive(async () => {
        // read Setup first so the editor follows the synth's current mode
        const [setup] = this.regions();
        await this.midi.read([setup], () => this.status('Reading Setup…'));
        const sm = this.get('fm.setup.soundMode');
        if (sm === 0 || sm === 1) {
          this.followingSynth = true;
          this.setInternal('vs.control.mode', sm === 1 ? 0 : 1);
          this.updateViewState();
          this.followingSynth = false;
        }
        await this.midi.read(this.regions().slice(1), (i, n, label) =>
          this.status(i < n ? `Reading ${label}… (${i + 2}/${n + 1})` : 'Read complete.'),
        );
      });
      this.updateViewState();
    } catch (e) {
      this.status(`Read failed: ${(e as Error).message}`);
    }
  }

  async syncToDevice() {
    if (!this.midi.output) return this.status('Select a MIDI output first.');
    const blocks = this.regions().flatMap((r) => r.blocks);
    try {
      await this.midi.exclusive(() =>
        this.midi.sync(blocks, (i, n) => this.status(i < n ? `Sending… ${Math.round((i / n) * 100)}%` : 'Sync complete.')),
      );
    } catch (e) {
      this.status(`Sync failed: ${(e as Error).message}`);
    }
  }

  /**
   * Store the synth's temporary performance into a user slot 0501-0564
   * (bank MSB 85, LSB 0, program 0-63) — the JUNO-Di's only writable memory.
   * Protocol (JUXE.exe code + MIDI-OX capture of the original):
   *   -> Identity Request
   *   -> RQ1 cm.command.writeRequest (0F 00 10 00), "size" field = [MSB, LSB, PC, 7F]
   *   <- DT1 at writeStart    (0F 00 10 01) = [00 00 00, MSB, LSB, PC, 7F]
   *   <- program change to the written slot on the control channel
   *   <- DT1 at writeComplete (0F 00 10 02) = same payload
   * Verified against a JUNO-Di (slot 0564). The editor first syncs so the
   * temporary area matches what you see.
   */
  async writeToDevice(kind: 'patch' | 'performance', opts: { skipConfirm?: boolean } = {}) {
    return this.midi.exclusive(() => this.doWrite(kind, opts));
  }

  private async doWrite(kind: 'patch' | 'performance', opts: { skipConfirm?: boolean }) {
    if (!this.midi.output) return this.status('Select a MIDI output first.');
    const perf = kind === 'performance';
    if (!perf && this.get('vs.control.mode') !== 1) return this.status('Switch to PATCH mode to write a patch.');
    if (!perf && this.get('vs.control.entityType') === 2) return this.status('Writing rhythm sets is not supported.');
    const list = perf ? 'vs.performanceNameList' : 'vs.patchNameList';
    const msb = this.get(`${list}.currentRowMsb`);
    const lsb = this.get(`${list}.currentRowLsb`);
    const pc = this.get(`${list}.currentRowPc`);
    // writable memory: performances 0501-0564 (85/0/0-63), patches 0501-0628 (87/0/0-127)
    const [wantMsb, last] = perf ? [85, 63] : [87, 127];
    if (msb !== wantMsb || lsb !== 0 || pc > last) return this.status(`Choose a destination between 0501 and ${userSlot(last)} first.`);
    const name = this.model.getString(this.v(perf ? 'fm.pfm.common.performanceName' : 'fm.pat[16].common.patchName')!).trim();
    const slot = userSlot(pc);
    if (!opts.skipConfirm) {
      const ok = await confirmDialog(
        `Write ${kind} "${name}" to ${slot}?`,
        `This overwrites the ${kind} currently stored in ${slot} on the JUNO-Di. It cannot be undone.`,
      );
      if (!ok) return;
    }

    // patch mode: regions() is just Setup, System and the patch buffer pat[16]
    const target = this.regions().filter((r) => r.label !== 'Setup' && r.label !== 'System');
    await this.midi.sync(target.flatMap((r) => r.blocks), (i, n) => this.status(`Preparing… ${Math.round((i / n) * 100)}%`));

    const req = this.v('cm.command.writeRequest')!;
    const start = this.v('cm.command.writeStart')!;
    const complete = this.v('cm.command.writeComplete')!;
    let started = false;
    const done = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(false);
      }, 10000);
      // replies start AT writeStart / writeComplete and run past them, so match the start offset
      const off = this.model.onChange((b, o, _l, src) => {
        if (src !== 'midi' || b !== complete.block) return;
        if (o === start.def.offset) started = true;
        if (o === complete.def.offset) {
          clearTimeout(timer);
          off();
          resolve(true);
        }
      });
    });
    this.status(`Writing ${slot}…`);
    this.midi.send([0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7]); // identity request, as the original does
    await new Promise((r) => setTimeout(r, 100));
    // a command, not a read: the 4-byte size field carries the destination
    this.midi.send(rq1(this.midi.deviceId, this.midi.modelId, req.address, ((msb * 128 + lsb) * 128 + pc) * 128 + 0x7f));
    if (await done) {
      this.names.setName(msb, lsb, pc, name);
      this.setInternal('vs.control.writePanelSw', 0);
      this.status(`Wrote ${kind} "${name}" to ${slot}.`);
      return true;
    }
    this.status(
      started ? `The synth started writing ${slot} but did not confirm completion.` : `No answer from the synth; ${slot} was not written.`,
    );
    return false;
  }

  private selectEntry(ctl: Control, close: boolean) {
    const isPerf = ctl.type.includes('Performance');
    const msb = this.get(isPerf ? 'vs.performanceNameList.currentRowMsb' : 'vs.patchNameList.currentRowMsb');
    const lsb = this.get(isPerf ? 'vs.performanceNameList.currentRowLsb' : 'vs.patchNameList.currentRowLsb');
    const pc = this.get(isPerf ? 'vs.performanceNameList.currentRowPc' : 'vs.patchNameList.currentRowPc');
    if (ctl.t('writePanel') === '1') {
      this.status('Writing to user memory is not supported yet.');
      return;
    }
    const setUi = (p: string, x: number) => {
      const v = this.v(p);
      if (v) this.model.set(v, x, 'immediate');
    };
    let base: string;
    if (isPerf) base = 'fm.setup.performance';
    else if (this.get('vs.control.mode') === 0) base = `fm.pfm.part[${this.get('vs.control.partId')}].patch`;
    else base = RHYTHM_MSB.has(msb) ? 'fm.setup.rhyPatch' : 'fm.setup.kbdPatch';
    setUi(`${base}BankSelectMsb`, msb);
    setUi(`${base}BankSelectLsb`, lsb);
    setUi(`${base}ProgramNumber`, pc);
    if (!isPerf && this.get('vs.control.mode') === 1) setUi('fm.setup.kbdPatchBankSelectMsb', msb);
    this.updateViewState();
    // the device loads the selection into its temporary area; fetch it back
    if (this.midi.output) setTimeout(() => this.readFromDevice(), 250);
    if (close) this.setInternal('vs.control.selectPanelSw', 0);
  }

  private resetListScroll(ctl: Control) {
    const list = ctl.type.includes('Performance') ? 'vs.performanceNameList' : 'vs.patchNameList';
    const span = this.get(`${list}.listCurRangeUp`) - this.get(`${list}.listCurRangeLo`);
    this.setInternal(`${list}.listCurRangeLo`, 1);
    this.setInternal(`${list}.listCurRangeUp`, 1 + span);
    this.setInternal(`${list}.currentNumber`, 0);
  }

  // ---------- files ----------

  private async loadInitial() {
    try {
      const res = await fetch(`${this.assetBase}InitialData.jxe`);
      if (res.ok) readJxe(this.model, await res.arrayBuffer());
    } catch (e) {
      console.warn('InitialData.jxe', e);
    }
  }

  async newFile() {
    await this.loadInitial();
    this.fileName = 'Untitled.jxe';
    this.updateViewState();
    this.status('Initialized from InitialData.jxe');
  }

  async openFile(file: File) {
    try {
      readJxe(this.model, await file.arrayBuffer());
      this.fileName = file.name;
      this.updateViewState();
      this.status(`Opened ${file.name}`);
    } catch (e) {
      this.status(`Could not open ${file.name}: ${(e as Error).message}`);
    }
  }

  saveFile() {
    const bytes = writeJxe(this.model);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = this.fileName.endsWith('.jxe') ? this.fileName : `${this.fileName}.jxe`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.status(`Saved ${a.download}`);
  }

  setZoom(z: number) {
    this.zoom = z;
    for (const w of this.windows) w.setZoom(z);
    try {
      localStorage.setItem('juno-di-editor.zoom', String(z));
    } catch {}
    this.invalidate();
  }
}

function contains(root: { items: unknown[] }, target: unknown): boolean {
  if (root === target) return true;
  for (const it of root.items as { kind: string; items?: unknown[] }[])
    if (it.kind === 'panel' && contains(it as { items: unknown[] }, target)) return true;
  return false;
}

/** In-page confirmation (native confirm() would block the page and MIDI callbacks). */
function confirmDialog(title: string, detail: string): Promise<boolean> {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'jx-modal';
    back.innerHTML = `<div class="jx-dialog"><h3></h3><p></p><div class="jx-actions"><button data-v="0">Cancel</button><button data-v="1" class="primary">Write</button></div></div>`;
    back.querySelector('h3')!.textContent = title;
    back.querySelector('p')!.textContent = detail;
    back.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        back.remove();
        resolve(b.dataset.v === '1');
      }),
    );
    document.body.appendChild(back);
    (back.querySelector('button[data-v="0"]') as HTMLButtonElement).focus();
  });
}

export function closeOverlays() {
  document.querySelectorAll('.jx-menu').forEach((m) => m.remove());
}
