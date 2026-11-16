// Control implementations. Each <control> in Script.xml maps to one class here.
// Controls are drawn onto the window canvas and receive pointer events in local coords.

import { XNode, childText, childrenOf, parsePoint } from '../script/xnode';
import { Model, ValueNode } from '../model/model';
import { compileExpr, compileValueRef, ExprFn } from '../model/expr';
import { SkinLibrary, Skin, drawFrame } from './bitmaps';
import { TextLibrary } from './text';
import type { PanelNode } from './panels';
import type { NameTables } from '../data/names';

export interface Env {
  model: Model;
  skins: SkinLibrary;
  text: TextLibrary;
  names: NameTables;
  invalidate(): void;
  callFunction(name: string, ctl: Control): void;
  functionEnabled(name: string): boolean;
  openMenu(ctl: Control, items: MenuItem[], onPick: (value: number) => void): void;
  openEdit(ctl: Control, rect: Rect, value: string, maxLen: number, onDone: (v: string) => void): void;
  status(text: string): void;
  note(on: boolean, note: number): void;
}

export interface MenuItem {
  label: string;
  value: number;
  selected?: boolean;
  separator?: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Pointer {
  x: number; // local to control
  y: number;
  dx: number; // movement since down
  dy: number;
  shift: boolean;
  ctrl: boolean;
  button: number;
}

type VRef = (m: Model) => ValueNode | undefined;

export abstract class Control {
  readonly kind = 'control';
  readonly type: string;
  readonly name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cursor = 'default';
  protected refs = new Map<string, VRef>();
  pressed = false;
  hover = false;
  /** absolute position, updated every frame by the renderer */
  ax = 0;
  ay = 0;

  constructor(
    readonly def: XNode,
    readonly env: Env,
    readonly panel: PanelNode,
  ) {
    this.type = this.t('type')!;
    this.name = this.t('name') ?? this.type;
    const p = parsePoint(this.t('position')) ?? [0, 0];
    this.x = p[0];
    this.y = p[1];
    const s = parsePoint(this.t('size'));
    const sk = this.skin;
    this.w = s?.[0] ?? sk?.width ?? 0;
    this.h = s?.[1] ?? sk?.height ?? 0;
  }

  t(tag: string) {
    return childText(this.def, tag);
  }
  num(tag: string, dflt = 0) {
    const s = this.t(tag);
    if (s === undefined) return dflt;
    const n = parseInt(s.trim(), 10);
    return isNaN(n) ? dflt : n;
  }
  get m() {
    return this.env.model;
  }
  get skin(): Skin | undefined {
    return this.env.skins.get(this.t('bitmapRef'));
  }

  ref(tag = 'valueRef'): ValueNode | undefined {
    let r = this.refs.get(tag);
    if (!r) {
      const src = this.t(tag);
      r = src && !src.includes('$') ? compileValueRef(src) : () => undefined;
      this.refs.set(tag, r);
    }
    return r(this.m);
  }
  val(tag = 'valueRef'): number {
    const v = this.ref(tag);
    return v ? this.m.get(v) : 0;
  }
  setVal(x: number, tag = 'valueRef') {
    const v = this.ref(tag);
    if (v && this.m.set(v, x, 'ui')) this.env.invalidate();
  }

  /** Evaluate a possibly-RPN attribute such as `<onValue>$part,1,+</onValue>`. */
  private exprs = new Map<string, ExprFn>();
  expr(tag: string, dflt: number): number {
    let f = this.exprs.get(tag);
    if (!f) {
      const s = this.t(tag);
      f = s === undefined || s.includes('$') ? () => dflt : compileExpr(s);
      this.exprs.set(tag, f);
    }
    return f(this.m);
  }

  enabled() {
    return true;
  }

  abstract draw(ctx: CanvasRenderingContext2D, x: number, y: number): void;
  down(_p: Pointer): void {}
  drag(_p: Pointer): void {}
  up(_p: Pointer): void {}
  wheel(_delta: number, _p: Pointer): void {}
  dblclick(_p: Pointer): void {}
  tip(): string | undefined {
    const v = this.ref();
    return v ? describe(v, this) : undefined;
  }
  interactive() {
    return true;
  }
}

// ---------- value formatting ----------

export function formatValue(env: Env, ctl: Control, v: ValueNode | undefined, raw?: number): string {
  if (!v) return '';
  const m = env.model;
  if (v.def.kind === 'string') return m.getString(v);
  const x = raw ?? m.get(v);
  const offsetSrc = ctl.t('offsetValue');
  const offset = offsetSrc !== undefined ? parseInt(offsetSrc.trim(), 10) || 0 : undefined;
  const tableName = ctl.t('stringTableRef');
  const unit = ctl.t('unit');
  if (tableName) {
    const table = env.text.strings.get(tableName);
    if (table) {
      const idx = offset !== undefined ? x + offset : x - v.min;
      const s = table[idx];
      if (s !== undefined) return unit ? `${s}` : s;
    }
  }
  const n = x + (offset ?? 0);
  return String(n);
}

function describe(v: ValueNode, ctl: Control) {
  const n = v.path.split('.').pop()!;
  return `${n} = ${formatValue(ctl.env, ctl, v)}`;
}

function tableItems(env: Env, ctl: Control, v: ValueNode): MenuItem[] {
  const cur = env.model.get(v);
  const items: MenuItem[] = [];
  const tname = ctl.t('stringTableRef');
  const table = tname ? env.text.strings.get(tname) : undefined;
  const offsetSrc = ctl.t('offsetValue');
  const offset = offsetSrc !== undefined ? parseInt(offsetSrc.trim(), 10) || 0 : undefined;
  for (let x = v.min; x <= v.max && items.length < 2048; x++) {
    let label: string;
    if (table) {
      const idx = offset !== undefined ? x + offset : x - v.min;
      label = table[idx] ?? String(x);
    } else label = String(x + (offset ?? 0));
    items.push({ label, value: x, selected: x === cur });
  }
  return items;
}

// ---------- numeric drag helper ----------

abstract class NumericControl extends Control {
  cursor = 'ns-resize';
  private startValue = 0;
  protected pixelsForRange() {
    return 200;
  }
  down(p: Pointer) {
    const v = this.ref();
    if (!v) return;
    this.startValue = this.m.get(v);
    this.pressed = true;
  }
  drag(p: Pointer) {
    const v = this.ref();
    if (!v || !this.pressed) return;
    const range = v.max - v.min;
    const scale = p.shift ? 0.1 : 1;
    const px = Math.max(range, this.pixelsForRange());
    const delta = Math.round((-p.dy * range * scale) / px);
    this.setVal(this.startValue + delta);
    this.env.status(this.tip() ?? '');
  }
  up() {
    this.pressed = false;
  }
  wheel(delta: number) {
    const v = this.ref();
    if (v) {
      this.setVal(this.m.get(v) + (delta < 0 ? 1 : -1));
      this.env.status(this.tip() ?? '');
    }
  }
  dblclick() {
    const v = this.ref();
    if (v) {
      const d = parseInt(v.def.def, 10);
      if (!isNaN(d)) this.setVal(d);
    }
  }
  fraction(): number {
    const v = this.ref();
    if (!v || v.max === v.min) return 0;
    return (this.m.get(v) - v.min) / (v.max - v.min);
  }
}

class Slider extends NumericControl {
  get vertical() {
    return this.h >= this.w;
  }
  constructor(def: XNode, env: Env, panel: PanelNode) {
    super(def, env, panel);
    if (!this.vertical) this.cursor = 'ew-resize';
  }
  protected pixelsForRange() {
    const s = this.skin;
    return Math.max(16, this.vertical ? this.h - (s?.height ?? 0) : this.w - (s?.width ?? 0));
  }
  drag(p: Pointer) {
    super.drag(this.vertical ? p : { ...p, dy: -p.dx });
  }
  down(p: Pointer) {
    super.down(p);
    // clicking on the track (not the thumb) jumps to that position
    const s = this.skin;
    const v = this.ref();
    if (!s || !v) return;
    const f = this.fraction();
    if (this.vertical) {
      const ty = (this.h - s.height) * (1 - f);
      if (p.y < ty || p.y > ty + s.height) {
        const nf = 1 - (p.y - s.height / 2) / (this.h - s.height);
        this.setVal(v.min + Math.round(Math.max(0, Math.min(1, nf)) * (v.max - v.min)));
        super.down(p);
      }
    } else {
      const tx = (this.w - s.width) * f;
      if (p.x < tx || p.x > tx + s.width) {
        const nf = (p.x - s.width / 2) / (this.w - s.width);
        this.setVal(v.min + Math.round(Math.max(0, Math.min(1, nf)) * (v.max - v.min)));
        super.down(p);
      }
    }
  }
  draw(ctx: CanvasRenderingContext2D, x: number, y: number) {
    const s = this.skin;
    if (!s) return;
    const f = this.fraction();
    if (this.vertical) drawFrame(ctx, s, 0, x + Math.round((this.w - s.width) / 2), y + Math.round((this.h - s.height) * (1 - f)));
    else drawFrame(ctx, s, 0, x + Math.round((this.w - s.width) * f), y + Math.round((this.h - s.height) / 2));
  }
}

class Knob extends NumericControl {
  draw(ctx: CanvasRenderingContext2D, x: number, y: number) {
    const s = this.skin;
    if (!s) return;
    drawFrame(ctx, s, Math.round(this.fraction() * (s.frames - 1)), x, y);
  }
}

/** Slider/text pair switching between two underlying values (e.g. Hz vs. note sync). */
class SwSlider extends Slider {
  ref(tag = 'valueRef') {
    if (tag !== 'valueRef') return super.ref(tag);
    const sw = super.ref('valueRef');
    const note = sw ? this.m.get(sw) - sw.min : 0;
    return super.ref(note ? 'value1Ref' : 'value0Ref');
  }
}

class StaticText extends Control {
  interactive() {
    return false;
  }
  text(): string {
    return formatValue(this.env, this, this.ref());
  }
  draw(ctx: CanvasRenderingContext2D, x: number, y: number) {
    const unit = this.t('unit');
    let s = this.text();
    if (unit && s && this.constructor === StaticText) s += unit;
    this.env.text.draw(ctx, this.t('textWriterRef'), s, x, y, this.w, this.h);
  }
}

/** Shows text, or a picture frame (musical note) when the value is in the note range. */
class StaticTextPicture extends StaticText {
  draw(ctx: CanvasRenderingContext2D, x: number, y: number) {
    const v = this.ref();
    const s = this.skin;
    if (v && s && v.def.kind !== 'string') {
      const x0 = this.m.get(v);
      const first = v.max - s.frames + 1;
      if (x0 >= first) {
        drawFrame(ctx, s, x0 - first, x + this.w - s.width, y + Math.round((this.h - s.height) / 2));
        return;
      }
    }
    super.draw(ctx, x, y);
  }
}

class SwStaticTextPicture extends Control {
  interactive() {
    return false;
  }
  draw(ctx: CanvasRenderingContext2D, x: number, y: number) {
    const sw = this.ref('valueRef');
    const note = sw ? this.m.get(sw) - sw.min : 0;
    if (note) {
      const v = this.ref('value1Ref');
      const s = this.skin;
      if (v && s) drawFrame(ctx, s, this.m.get(v) - v.min, x + this.w - s.width, y + Math.round((this.h - s.height) / 2));
      return;
    }
    const v = this.ref('value0Ref');
    let txt = formatValue(this.env, this, v);
    const unit = this.t('unit');
    if (unit) txt += unit;
    this.env.text.draw(ctx, this.t('textWriterRef'), txt, x, y, this.w, this.h);
  }
}

class Picture extends Control {
  interactive() {
    return false;
  }
  draw(ctx: CanvasRenderingContext2D, x: number, y: number) {
    const s = this.skin;
    if (!s) return;
    const v = this.ref();
    drawFrame(ctx, s, v ? this.m.get(v) - v.min : 0, x, y);
  }
}

// ---------- buttons ----------

/**
 * 4-state button strips are: off, on, off+pressed, on+pressed.
 * Buttons may carry a label drawn with textWriterRef[0] (off) / textWriterRef[1] (on).
 */
abstract class ButtonBase extends Control {
  cursor = 'pointer';
  abstract isOn(): boolean;
  frame(): number {
    const s = this.skin;
    const on = this.isOn() ? 1 : 0;
    if (!s) return 0;
    if (s.frames >= 4) return on + (this.pressed ? 2 : 0);
    if (s.frames >= 2) return this.pressed || on ? 1 : 0;
    return 0;
  }
  draw(ctx: CanvasRenderingContext2D, x: number, y: number) {
    const s = this.skin;
    if (s) drawFrame(ctx, s, this.frame(), x, y);
    const label = this.t('label');
    if (label) {
      const writers = childrenOf(this.def, 'textWriterRef').map((w) => w.text);
      const w = writers[this.isOn() ? Math.min(1, writers.length - 1) : 0];
      this.env.text.draw(ctx, w ?? 'parameterNameTextCC', label, x, y + (this.pressed ? 1 : 0), this.w, this.h);
    }
  }
  down() {
    this.pressed = true;
  }
  up(p: Pointer) {
    const inside = p.x >= 0 && p.y >= 0 && p.x < this.w && p.y < this.h;
    this.pressed = false;
    if (inside) this.click();
  }
  abstract click(): void;
}

class LatchButton extends ButtonBase {
  isOn() {
    const v = this.ref();
    return !!v && this.m.get(v) === this.expr('onValue', 1);
  }
  click() {
    const on = this.expr('onValue', 1);
    const off = this.expr('offValue', 0);
    this.setVal(this.isOn() ? off : on);
  }
}

/** Momentary button that triggers an editor function (Read, Sync, ...). */
class UnlatchButton extends ButtonBase {
  isOn() {
    return false;
  }
  enabled() {
    const f = this.t('function');
    return !f || this.env.functionEnabled(f);
  }
  click() {
    const f = this.t('function');
    if (f) this.env.callFunction(f, this);
  }
}

class IncrementButton extends ButtonBase {
  private timer: number | undefined;
  isOn() {
    return false;
  }
  down() {
    super.down();
    this.step();
    this.timer = window.setTimeout(() => {
      this.timer = window.setInterval(() => this.step(), 60);
    }, 400);
  }
  up(p: Pointer) {
    clearTimeout(this.timer);
    clearInterval(this.timer);
    this.pressed = false;
  }
  click() {}
  step() {
    const v = this.ref();
    if (v) this.setVal(this.m.get(v) + this.num('deltaValue', 1));
  }
}

/** Radio-like button selecting value == onValue (used for parts / select panels). */
class SelectButton extends ButtonBase {
  isOn() {
    const v = this.ref();
    return !!v && this.m.get(v) === this.expr('onValue', 1);
  }
  click() {
    const on = this.expr('onValue', 1);
    const v = this.ref();
    if (!v) return;
    // select-panel buttons toggle their popup
    if (this.type === 'juxSelectPanelButton' && this.isOn()) this.setVal(0);
    else this.setVal(on);
  }
}

/** Solo button: value holds 0 = off, n+1 = solo part n. */
class SoloPartButton extends ButtonBase {
  part() {
    return this.expr('partId', 0);
  }
  isOn() {
    return this.val() === this.part() + 1;
  }
  frame() {
    const s = this.skin;
    if (!s) return 0;
    // 6 state: off, on, off-pressed, on-pressed, disabled-off, disabled-on
    return (this.isOn() ? 1 : 0) + (this.pressed ? 2 : 0);
  }
  click() {
    this.setVal(this.isOn() ? 0 : this.part() + 1);
  }
}

/** Phrase preview: while held, value = onValue; released -> offValue. */
class PreviewButton extends ButtonBase {
  isOn() {
    return this.val() === this.expr('onValue', 1) && this.val() !== this.expr('offValue', 0);
  }
  down() {
    super.down();
    this.setVal(this.isOn() ? this.expr('offValue', 0) : this.expr('onValue', 1));
  }
  click() {}
}

/** Write-panel menu button: opens WRITE PERFORMANCE or WRITE PATCH depending on mode. */
class WritePanelButton extends ButtonBase {
  isOn() {
    return this.val() !== 0;
  }
  draw(ctx: CanvasRenderingContext2D, x: number, y: number) {
    super.draw(ctx, x, y);
    this.env.text.draw(ctx, 'parameterNameTextCC', 'Write', x, y + (this.pressed ? 1 : 0), this.w, this.h);
  }
  click() {
    if (this.isOn()) return this.setVal(0);
    const mode = compileValueRef('vs.control.mode')(this.m);
    this.setVal(mode && this.m.get(mode) === 1 ? 2 : 1);
  }
}

/**
 * Tone select buttons (1-4). activeValueRef = tone being edited;
 * stateValueRef = bitmask of tones selected for simultaneous editing.
 * 6-state strip: off, active, selected, active+selected, pressed variants.
 */
class ToneSelectButton extends ButtonBase {
  id() {
    return this.num('id', 0);
  }
  isOn() {
    return this.val('activeValueRef') === this.id();
  }
  frame() {
    const s = this.skin;
    if (!s) return 0;
    const sel = (this.val('stateValueRef') >> this.id()) & 1;
    if (this.isOn()) return 1;
    return sel ? 2 : 0;
  }
  click() {}
  up(p: Pointer) {
    const inside = p.x >= 0 && p.y >= 0 && p.x < this.w && p.y < this.h;
    this.pressed = false;
    if (!inside) return;
    const id = this.id();
    if (p.shift || p.ctrl) {
      const mask = this.val('stateValueRef') ^ (1 << id);
      this.setVal(mask | (1 << this.val('activeValueRef')), 'stateValueRef');
    } else {
      this.setVal(id, 'activeValueRef');
      this.setVal(1 << id, 'stateValueRef');
    }
  }
}

// ---------- text based ----------

class Combo extends Control {
  cursor = 'pointer';
  textRect(): Rect {
    const tp = parsePoint(this.t('textPosition')) ?? [1, 1];
    const ts = parsePoint(this.t('textSize')) ?? [this.w - 12, this.h];
    return { x: tp[0], y: tp[1], w: ts[0], h: ts[1] };
  }
  text(): string {
    return formatValue(this.env, this, this.ref());
  }
  draw(ctx: CanvasRenderingContext2D, x: number, y: number) {
    const r = this.textRect();
    this.env.text.draw(ctx, this.t('textWriterRef'), this.text(), x + r.x + 1, y + r.y, r.w - 1, r.h);
    const s = this.skin;
    const bp = parsePoint(this.t('buttonPosition'));
    if (s && bp) drawFrame(ctx, s, this.pressed ? 1 : 0, x + bp[0], y + bp[1]);
  }
  items(v: ValueNode): MenuItem[] {
    return tableItems(this.env, this, v);
  }
  down() {
    const v = this.ref();
    if (!v) return;
    this.pressed = true;
    this.env.invalidate();
    this.env.openMenu(this, this.items(v), (x) => this.pick(x));
  }
  pick(x: number) {
    this.setVal(x);
  }
  up() {
    this.pressed = false;
  }
  wheel(delta: number) {
    const v = this.ref();
    if (v) this.setVal(this.m.get(v) + (delta < 0 ? -1 : 1));
  }
}

class MfxSelectCombo extends Combo {
  text() {
    const v = this.ref();
    if (!v) return '';
    const x = this.m.get(v);
    return `${String(x).padStart(2, '0')}: ${this.env.names.mfx[x] ?? '?'}`;
  }
  items(v: ValueNode): MenuItem[] {
    const cur = this.m.get(v);
    const out: MenuItem[] = [];
    for (let x = v.min; x <= v.max; x++) {
      const n = this.env.names.mfx[x];
      if (n === undefined) break;
      out.push({ label: `${String(x).padStart(2, '0')}: ${n}`, value: x, selected: x === cur });
    }
    return out;
  }
}

class WaveSelectCombo extends Combo {
  text() {
    const v = this.ref();
    if (!v) return '';
    const x = this.m.get(v);
    if (x === 0) return '---- : OFF';
    const name = this.env.names.waves[x - 1];
    return `${String(x).padStart(4, '0')}: ${name ?? ''}`;
  }
  items(v: ValueNode): MenuItem[] {
    const cur = this.m.get(v);
    const out: MenuItem[] = [{ label: '---- : OFF', value: 0, selected: cur === 0 }];
    const n = Math.min(v.max, this.env.names.waves.length || v.max);
    for (let x = 1; x <= n; x++)
      out.push({ label: `${String(x).padStart(4, '0')}: ${this.env.names.waves[x - 1] ?? ''}`, value: x, selected: x === cur });
    return out;
  }
}

class Edit extends Combo {
  cursor = 'text';
  draw(ctx: CanvasRenderingContext2D, x: number, y: number) {
    const s = this.skin;
    if (s) drawFrame(ctx, s, 0, x, y);
    const r = this.textRect();
    this.env.text.draw(ctx, this.t('textWriterRef'), this.text(), x + r.x, y + r.y, r.w, r.h);
  }
  down() {
    const v = this.ref();
    if (!v) return;
    const r = this.textRect();
    this.env.openEdit(this, { x: this.ax + r.x, y: this.ay + r.y, w: r.w, h: r.h }, this.m.getString(v).trimEnd(), v.def.size, (s) => {
      this.m.setString(v, s, 'ui');
      this.env.invalidate();
    });
  }
  wheel() {}
}

// ---------- graphical editors ----------

const ENV_LEVEL_TAGS = ['L0ValueRef', 'L1ValueRef', 'L2ValueRef', 'L3ValueRef', 'L4ValueRef'];
const ENV_TIME_TAGS = ['T1ValueRef', 'T2ValueRef', 'T3ValueRef', 'T4ValueRef'];

class Envelope extends Control {
  cursor = 'crosshair';
  private dragIdx = -1;
  private start = { t: 0, l: 0 };

  private bipolar() {
    // pitch envelopes are -63..+63 around 64
    const v = this.ref('L0ValueRef') ?? this.ref('L1ValueRef');
    return !!v && v.min > 0;
  }
  private level(i: number) {
    const tag = ENV_LEVEL_TAGS[i];
    const v = this.ref(tag);
    if (!v) return 0;
    return (this.m.get(v) - v.min) / (v.max - v.min);
  }
  private points() {
    const seg = (this.w - 6) / 5;
    const pts: { x: number; y: number; t?: number; l?: number }[] = [];
    let x = 3;
    const ly = (f: number) => 3 + (this.h - 6) * (1 - f);
    const base = this.bipolar() ? 0.5 : 0;
    pts.push({ x, y: ly(this.ref('L0ValueRef') ? this.level(0) : base), l: 0 });
    for (let i = 0; i < 4; i++) {
      const tv = this.ref(ENV_TIME_TAGS[i]);
      const tf = tv ? (this.m.get(tv) - tv.min) / (tv.max - tv.min) : 0;
      x += tf * seg;
      if (i === 3) x += seg; // sustain segment
      const li = i + 1;
      const lv = this.ref(ENV_LEVEL_TAGS[li]);
      pts.push({ x, y: ly(lv ? this.level(li) : base), t: i, l: lv ? li : undefined });
    }
    return pts;
  }
  draw(ctx: CanvasRenderingContext2D, x: number, y: number) {
    const pts = this.points();
    ctx.save();
    ctx.translate(x, y);
    if (this.bipolar()) {
      ctx.strokeStyle = 'rgba(80,140,200,0.35)';
      ctx.beginPath();
      ctx.moveTo(0, this.h / 2 + 0.5);
      ctx.lineTo(this.w, this.h / 2 + 0.5);
      ctx.stroke();
    }
    ctx.strokeStyle = '#4cf';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
    ctx.fillStyle = '#fc4';
    for (const p of pts) ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    ctx.restore();
  }
  down(p: Pointer) {
    const pts = this.points();
    let best = -1;
    let bd = 64;
    pts.forEach((q, i) => {
      const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    this.dragIdx = best;
    if (best < 0) return;
    const q = pts[best];
    const tv = q.t !== undefined ? this.ref(ENV_TIME_TAGS[q.t]) : undefined;
    const lv = q.l !== undefined ? this.ref(ENV_LEVEL_TAGS[q.l]) : undefined;
    this.start = { t: tv ? this.m.get(tv) : 0, l: lv ? this.m.get(lv) : 0 };
    this.pressed = true;
  }
  drag(p: Pointer) {
    if (this.dragIdx < 0) return;
    const q = this.points()[this.dragIdx];
    const seg = (this.w - 6) / 5;
    if (q.t !== undefined && q.t < 3) {
      const tv = this.ref(ENV_TIME_TAGS[q.t]);
      if (tv) this.setVal(this.start.t + Math.round((p.dx / seg) * (tv.max - tv.min)), ENV_TIME_TAGS[q.t]);
    } else if (q.t === 3) {
      const tv = this.ref(ENV_TIME_TAGS[3]);
      if (tv) this.setVal(this.start.t + Math.round((p.dx / seg) * (tv.max - tv.min)), ENV_TIME_TAGS[3]);
    }
    if (q.l !== undefined) {
      const lv = this.ref(ENV_LEVEL_TAGS[q.l]);
      if (lv) this.setVal(this.start.l - Math.round((p.dy / (this.h - 6)) * (lv.max - lv.min)), ENV_LEVEL_TAGS[q.l]);
    }
    const parts: string[] = [];
    for (const tag of [...ENV_TIME_TAGS, ...ENV_LEVEL_TAGS]) {
      const v = this.ref(tag);
      if (v) parts.push(`${tag[0]}${tag[1]}:${this.m.get(v) - (v.min > 0 ? 64 : 0)}`);
    }
    this.env.status(parts.join('  '));
  }
  up() {
    this.pressed = false;
    this.dragIdx = -1;
  }
  tip() {
    return 'Drag points to edit the envelope';
  }
}

/** Velocity/keyboard range with fade widths: |fadeLo|rangeLo .... rangeHi|fadeHi| */
class FadeRange extends Control {
  cursor = 'ew-resize';
  private grab: string | undefined;
  private startVal = 0;
  private range() {
    const r = parsePoint(this.t('displayRange')) ?? [0, 127];
    return r;
  }
  private xs() {
    const [lo, hi] = this.range();
    const fx = (v: number) => ((v - lo) / (hi - lo)) * this.w;
    const rl = this.val('rangeLowerValueRef');
    const ru = this.val('rangeUpperValueRef');
    const fl = this.val('fadeWidthLowerValueRef');
    const fu = this.val('fadeWidthUpperValueRef');
    return { a: fx(rl - fl), b: fx(rl), c: fx(ru), d: fx(ru + fu) };
  }
  draw(ctx: CanvasRenderingContext2D, x: number, y: number) {
    const { a, b, c, d } = this.xs();
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = '#3af';
    ctx.beginPath();
    ctx.moveTo(a, this.h);
    ctx.lineTo(b, 0);
    ctx.lineTo(c, 0);
    ctx.lineTo(d, this.h);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  down(p: Pointer) {
    const { a, b, c, d } = this.xs();
    const cand: [string, number][] = [
      ['rangeLowerValueRef', b],
      ['rangeUpperValueRef', c],
      ['fadeWidthLowerValueRef', a],
      ['fadeWidthUpperValueRef', d],
    ];
    cand.sort((u, v) => Math.abs(u[1] - p.x) - Math.abs(v[1] - p.x));
    this.grab = cand[0][0];
    this.startVal = this.val(this.grab);
    this.pressed = true;
  }
  drag(p: Pointer) {
    if (!this.grab) return;
    const [lo, hi] = this.range();
    const dv = Math.round((p.dx / this.w) * (hi - lo));
    const sign = this.grab === 'fadeWidthLowerValueRef' ? -1 : 1;
    this.setVal(this.startVal + sign * dv, this.grab);
    this.env.status(
      `Range ${this.val('rangeLowerValueRef')}-${this.val('rangeUpperValueRef')}  Fade ${this.val('fadeWidthLowerValueRef')}/${this.val('fadeWidthUpperValueRef')}`,
    );
  }
  up() {
    this.grab = undefined;
    this.pressed = false;
  }
  tip() {
    return `Range ${this.val('rangeLowerValueRef')}-${this.val('rangeUpperValueRef')}`;
  }
}

class Bias extends Control {
  interactive() {
    return false;
  }
  draw(ctx: CanvasRenderingContext2D, x: number, y: number) {
    const lvl = this.ref('levelValueRef');
    const pos = this.ref('positionValueRef');
    const dir = this.ref('directionValueRef');
    if (!lvl || !pos || !dir) return;
    const level = (this.m.get(lvl) - lvl.min) / (lvl.max - lvl.min) * 2 - 1; // -1..1
    const px = (this.m.get(pos) / 127) * this.w;
    const d = this.m.get(dir); // 0 lower, 1 upper, 2 lower&upper, 3 all
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = '#4cf';
    ctx.lineWidth = 1.5;
    const mid = this.h / 2;
    const yAt = (xx: number) => {
      const dist = (xx - px) / this.w;
      let k = 0;
      if (d === 0) k = dist < 0 ? -dist : 0;
      else if (d === 1) k = dist > 0 ? dist : 0;
      else if (d === 2) k = Math.abs(dist);
      else k = dist;
      return mid - level * k * this.h;
    };
    ctx.beginPath();
    for (let xx = 0; xx <= this.w; xx += 2) {
      const yy = Math.max(0, Math.min(this.h, yAt(xx)));
      xx ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy);
    }
    ctx.stroke();
    ctx.fillStyle = '#fc4';
    ctx.fillRect(px - 1, 0, 2, this.h);
    ctx.restore();
  }
}

class LfoControl extends Control {
  interactive() {
    return false;
  }
  draw(ctx: CanvasRenderingContext2D, x: number, y: number) {
    const wf = this.val('waveformValueRef');
    const rateV = this.ref('rateValueRef');
    const rate = rateV ? Math.min(127, this.m.get(rateV)) : 64;
    const delay = this.val('delayTimeValueRef');
    const fadeMode = this.val('fadeModeValueRef');
    const fade = this.val('fadeTimeValueRef');
    const off = this.val('offsetValueRef'); // 0..4 => +100..-100
    const stepType = this.val('stepTypeValueRef');
    const steps: number[] = [];
    for (let i = 0; i < 16; i++) {
      const r = this.refStep(i);
      steps.push(r);
    }
    const cycles = 1 + (rate / 127) * 7;
    const mid = this.h / 2;
    const amp = this.h / 2 - 3;
    const offset = [1, 0.5, 0, -0.5, -1][off] ?? 0;
    const wave = (ph: number): number => {
      const p = ph - Math.floor(ph);
      switch (wf) {
        case 0: return Math.sin(p * 2 * Math.PI);
        case 1: return p < 0.25 ? p * 4 : p < 0.75 ? 2 - p * 4 : p * 4 - 4;
        case 2: return p * 2 - 1;
        case 3: return 1 - p * 2;
        case 4: return p < 0.5 ? 1 : -1;
        case 5: return Math.sin(Math.floor(ph * 4) * 12.9898) % 1;
        case 6: return Math.min(1, ph);
        case 7: return -Math.min(1, ph);
        case 8: return p < 0.5 ? p * 4 - 1 : 1;
        case 9: return Math.sin(Math.floor(ph * 2) * 78.233) % 1;
        case 10: return Math.sin(p * 2 * Math.PI) * 0.5 + Math.sin(p * 6 * Math.PI) * 0.5;
        case 11: return Math.sin(p * 2 * Math.PI) * (0.5 + 0.5 * Math.sin(ph));
        case 12: {
          const i = Math.floor(p * 16);
          const s = (steps[i] - 64) / 36;
          if (!stepType) return s;
          const n = (steps[(i + 1) % 16] - 64) / 36;
          return s + (n - s) * (p * 16 - i);
        }
        default: return 0;
      }
    };
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = 'rgba(80,140,200,0.35)';
    ctx.beginPath();
    ctx.moveTo(0, mid + 0.5);
    ctx.lineTo(this.w, mid + 0.5);
    ctx.stroke();
    ctx.strokeStyle = '#4cf';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    const d0 = (delay / 127) * this.w * 0.3;
    const f0 = (fade / 127) * this.w * 0.3;
    for (let px = 0; px <= this.w; px++) {
      let env = 1;
      if (fadeMode === 0 || fadeMode === 1) {
        if (px < d0) env = fadeMode === 0 ? 0 : 1;
        else env = Math.min(1, (px - d0) / Math.max(1, f0));
        if (fadeMode === 1) env = px < d0 ? 1 : Math.max(0, 1 - (px - d0) / Math.max(1, f0));
      } else if (fadeMode === 2) env = px < d0 ? 0 : 1;
      else env = px < d0 ? 1 : Math.max(0, 1 - (px - d0) / Math.max(1, f0));
      const v = Math.max(-1, Math.min(1, (wave((px / this.w) * cycles) + offset) / (1 + Math.abs(offset))));
      const yy = mid - v * env * amp;
      px ? ctx.lineTo(px, yy) : ctx.moveTo(px, yy);
    }
    ctx.stroke();
    ctx.restore();
  }
  private refStep(i: number) {
    const base = this.t('stepValueRef');
    if (!base) return 64;
    const tag = `__step${i}`;
    if (!this.refs.has(tag)) this.refs.set(tag, compileValueRef(`${base}${i + 1}`));
    const v = this.refs.get(tag)!(this.m);
    return v ? this.m.get(v) : 64;
  }
}

/** On-screen keyboard. Plays notes on vs.utility.keyboardState.channel via MIDI out. */
/**
 * keyboard.bmp holds one octave plus lowest/highest end pieces. Each white key is drawn
 * from an "upside" slice (between black keys) and a "downside" slice; pressed variants
 * live further down the bitmap. Rectangles come from the control definition.
 */
class Keyboard extends Control {
  cursor = 'pointer';
  private held = -1;
  private rects = new Map<string, [number, number, number, number]>();
  private static WHITE = 19;
  private static LETTERS: Record<number, string> = { 0: 'c', 2: 'd', 4: 'e', 5: 'f', 7: 'g', 9: 'a', 11: 'b' };

  constructor(def: XNode, env: Env, panel: PanelNode) {
    super(def, env, panel);
    for (const c of def.children)
      if (c.tag.endsWith('Rectangle') || c.tag.endsWith('RectanglePressed')) {
        const p = c.text.split(',').map((s) => parseInt(s, 10));
        if (p.length === 4) this.rects.set(c.tag, p as [number, number, number, number]);
      }
    this.w = this.whiteCount() * Keyboard.WHITE;
    this.h = (this.rect('ivoryKeyDownsideRectangle')?.[3] ?? 106) + 1;
  }
  private rect(tag: string) {
    return this.rects.get(tag);
  }
  private range() {
    return parsePoint(this.t('physicalKeyRange')) ?? [36, 96];
  }
  private keyCount() {
    const r = this.range();
    return r[1] - r[0] + 1;
  }
  private whiteCount() {
    let n = 0;
    for (let i = 0; i < this.keyCount(); i++) if (!isBlack(this.range()[0] + i)) n++;
    return n;
  }
  private transpose() {
    const oct = compileValueRef('vs.utility.keyboardState.octave')(this.m);
    return oct ? (this.m.get(oct) - 64) * 12 : 0;
  }
  /** physical key index -> x of its white key (or for black keys, the black key's x) */
  private layout() {
    const [lo] = this.range();
    const keys: { i: number; black: boolean; x: number }[] = [];
    let wx = 0;
    for (let i = 0; i < this.keyCount(); i++) {
      const black = isBlack(lo + i);
      if (black) keys.push({ i, black, x: wx - Keyboard.WHITE + 12 });
      else {
        keys.push({ i, black, x: wx });
        wx += Keyboard.WHITE;
      }
    }
    return keys;
  }
  private noteAt(px: number, py: number): number {
    const keys = this.layout();
    const blackH = (this.rect('ebonyKeyRectangle')?.[3] ?? 64) + 1;
    if (py < blackH) for (const k of keys) if (k.black && px >= k.x && px < k.x + 12) return this.range()[0] + k.i + this.transpose();
    for (const k of keys) if (!k.black && px >= k.x && px < k.x + Keyboard.WHITE) return this.range()[0] + k.i + this.transpose();
    return -1;
  }
  draw(ctx: CanvasRenderingContext2D, x: number, y: number) {
    const s = this.skin;
    if (!s) return;
    const [lo] = this.range();
    const n = this.keyCount();
    const blit = (r: [number, number, number, number] | undefined, dx: number, dy: number) => {
      if (r) ctx.drawImage(s.canvas, r[0], r[1], r[2] - r[0], r[3] - r[1] + 1, x + dx, y + dy, r[2] - r[0], r[3] - r[1] + 1);
    };
    for (const k of this.layout()) {
      const note = lo + k.i;
      const pressed = note + this.transpose() === this.held ? 'Pressed' : '';
      if (k.black) {
        blit(this.rect(`ebonyKeyRectangle${pressed}`), k.x, 0);
        continue;
      }
      const end = k.i === 0 ? 'lowest' : k.i === n - 1 ? 'highest' : '';
      const letter = Keyboard.LETTERS[note % 12];
      // upside slice: positioned relative to its white key's base inside the octave strip
      const upTag = end ? `${end}KeyUpsideRectangle${pressed}` : `${letter}KeyUpsideRectangle${pressed}`;
      const up = this.rect(upTag);
      if (up) {
        const base = end === 'lowest' ? 0 : end === 'highest' ? 152 : 19 + 'cdefgab'.indexOf(letter) * Keyboard.WHITE;
        blit(up, k.x + (up[0] - base), 0);
      }
      const downTag = end ? `${end}KeyDownsideRectangle${pressed}` : `ivoryKeyDownsideRectangle${pressed}`;
      const down = this.rect(downTag);
      if (down) blit(down, k.x, this.rect('ivoryKeyDownsideRectangle')![1]);
    }
  }
  down(p: Pointer) {
    const n = this.noteAt(p.x, p.y);
    if (n < 0) return;
    this.held = n;
    this.env.note(true, n);
  }
  drag(p: Pointer) {
    const n = this.noteAt(p.x, p.y);
    if (n >= 0 && n !== this.held) {
      if (this.held >= 0) this.env.note(false, this.held);
      this.held = n;
      this.env.note(true, n);
      this.env.invalidate();
    }
  }
  up() {
    if (this.held >= 0) this.env.note(false, this.held);
    this.held = -1;
  }
}

function isBlack(i: number) {
  return [1, 3, 6, 8, 10].includes(i % 12);
}

/** Preset/user name list (SELECT PATCH / PERFORMANCE dialogs). */
class NameList extends Control {
  cursor = 'pointer';
  private rowH() {
    return this.num('rowHeight', 13);
  }
  /** Write dialogs only offer the USER bank (bank 0) as destination. */
  private isWrite() {
    return this.t('writePanel') === '1';
  }
  private entries() {
    if (this.type.includes('Performance')) return this.env.names.performanceList(this.isWrite() ? 0 : this.val('currentBankValueRef'));
    return this.env.names.patchList(this.isWrite() ? 0 : this.val('currentBankValueRef'));
  }
  draw(ctx: CanvasRenderingContext2D, x: number, y: number) {
    const rows = this.entries();
    const rh = this.rowH();
    const header = rh + 2;
    const first = Math.max(0, this.val('firstVisibleRowValueRef') - 1);
    const visible = Math.floor((this.h - header) / rh);
    const cur = this.val('currentRowValueRef');
    const tw = this.env.text;
    tw.draw(ctx, this.t('headerWriterRef'), '  No.   Name', x, y, this.w, header);
    for (let i = 0; i < visible; i++) {
      const r = rows[first + i];
      if (!r) break;
      const isCur = first + i === cur;
      tw.draw(
        ctx,
        isCur ? this.t('currentWriterRef') : this.t('textWriterRef'),
        `  ${r.label}`,
        x,
        y + header + i * rh,
        this.w,
        rh,
      );
    }
  }
  down(p: Pointer) {
    const rh = this.rowH();
    const header = rh + 2;
    if (p.y < header) return;
    const first = Math.max(0, this.val('firstVisibleRowValueRef') - 1);
    const idx = first + Math.floor((p.y - header) / rh);
    const rows = this.entries();
    if (!rows[idx]) return;
    this.setVal(idx, 'currentRowValueRef');
    const r = rows[idx];
    this.setVal(r.msb, 'currentRowMsbValueRef');
    this.setVal(r.lsb, 'currentRowLsbValueRef');
    this.setVal(r.pc, 'currentRowPcValueRef');
    if (!this.isWrite()) this.env.callFunction('SelectEntry', this);
  }
  dblclick() {
    if (!this.isWrite()) this.env.callFunction('SelectEntryClose', this);
  }
  wheel(delta: number) {
    const lo = this.ref('firstVisibleRowValueRef');
    const hi = this.ref('lastVisibleRowValueRef');
    if (!lo || !hi) return;
    const n = this.entries().length;
    const rh = this.rowH();
    const visible = Math.floor((this.h - rh - 2) / rh);
    const step = delta > 0 ? 3 : -3;
    const first = Math.max(1, Math.min(Math.max(1, n - visible + 1), this.m.get(lo) + step));
    this.m.set(lo, first, 'internal');
    this.m.set(hi, first + visible - 1, 'internal');
    this.env.invalidate();
  }
}

class NameListScroll extends Control {
  cursor = 'ns-resize';
  draw(ctx: CanvasRenderingContext2D, x: number, y: number) {
    const lo = this.val('currentRangeLowerValueRef');
    const hi = this.val('currentRangeUpperValueRef');
    const total = Math.max(1, this.total());
    const top = ((lo - 1) / total) * this.h;
    const hgt = Math.max(10, ((hi - lo + 1) / total) * this.h);
    ctx.fillStyle = '#bfbfbf';
    ctx.fillRect(x + 1, y + top, this.w - 2, Math.min(this.h - top, hgt));
  }
  private total() {
    return this.type.includes('Performance') ? this.env.names.performanceList().length : this.env.names.patchList(this.patchBank()).length;
  }
  private patchBank() {
    const b = compileValueRef('vs.patchNameList.listCurrentBank')(this.m);
    return b ? this.m.get(b) : 0;
  }
  private start = 0;
  down() {
    this.start = this.val('currentRangeLowerValueRef');
  }
  drag(p: Pointer) {
    const total = Math.max(1, this.total());
    const span = this.val('currentRangeUpperValueRef') - this.val('currentRangeLowerValueRef');
    const first = Math.max(1, Math.min(total - span, this.start + Math.round((p.dy / this.h) * total)));
    this.setVal(first, 'currentRangeLowerValueRef');
    this.setVal(first + span, 'currentRangeUpperValueRef');
  }
}

class NameListScrollButton extends ButtonBase {
  isOn() {
    return false;
  }
  click() {
    const d = this.num('deltaValue', 1);
    const lo = this.val('currentRangeLowerValueRef');
    const span = this.val('currentRangeUpperValueRef') - lo;
    const first = Math.max(1, lo + d);
    this.setVal(first, 'currentRangeLowerValueRef');
    this.setVal(first + span, 'currentRangeUpperValueRef');
  }
}

class BankCombo extends Combo {
  text() {
    const banks = this.type.includes('Performance') ? this.env.names.performanceBanks : this.env.names.patchBanks;
    return banks[this.val()] ?? '';
  }
  items(v: ValueNode): MenuItem[] {
    const banks = this.type.includes('Performance') ? this.env.names.performanceBanks : this.env.names.patchBanks;
    return banks.map((label, i) => ({ label, value: i, selected: i === this.m.get(v) }));
  }
  pick(x: number) {
    const v = this.ref();
    if (v) {
      // bank value range may be undefined in the script; write directly
      v.block.data[v.def.offset] = x;
      this.m.set(v, x, 'internal');
      this.env.callFunction('BankChanged', this);
      this.env.invalidate();
    }
  }
}

class Unknown extends Control {
  interactive() {
    return false;
  }
  draw() {}
}

// ---------- factory ----------

const REGISTRY: Record<string, new (d: XNode, e: Env, p: PanelNode) => Control> = {
  slider: Slider,
  knob: Knob,
  fantomXSwSlider: SwSlider,
  staticText: StaticText,
  display: StaticText,
  staticTextPicture: StaticTextPicture,
  fantomXSwStaticTextPicture: SwStaticTextPicture,
  picture: Picture,
  latchButton: LatchButton,
  unlatchButton: UnlatchButton,
  incrementButton: IncrementButton,
  juxSelectPartButton: SelectButton,
  juxSelectPanelButton: SelectButton,
  fantomXSoloPartButton: SoloPartButton,
  fantomXPreviewButton: PreviewButton,
  previewSelectedButton: PreviewButton,
  xr2WritePanelButton: WritePanelButton,
  xvToneSelectButton: ToneSelectButton,
  combo: Combo,
  fantomXMfxSelectCombo: MfxSelectCombo,
  XR2EWaveIndexSelect: WaveSelectCombo,
  edit: Edit,
  envelope: Envelope,
  fadeRange: FadeRange,
  bias: Bias,
  fantomXLfoControl: LfoControl,
  keyboard: Keyboard,
  juxPerformanceNameListControl: NameList,
  juxPatchNameListControl: NameList,
  xr2PerformanceNameListScroll: NameListScroll,
  xr2PatchNameListScroll: NameListScroll,
  xr2PerformanceNameListScrollButton: NameListScrollButton,
  xr2PatchNameListScrollButton: NameListScrollButton,
  xr2ChangePerformanceBankCombo: BankCombo,
  juxChangePatchBankCombo: BankCombo,
};

export const unknownTypes = new Set<string>();

export function createControl(def: XNode, env: Env, panel: PanelNode): Control {
  const type = childText(def, 'type')!;
  const C = REGISTRY[type];
  if (!C) {
    unknownTypes.add(type);
    return new Unknown(def, env, panel);
  }
  return new C(def, env, panel);
}
