// Canvas host for a top-level panel ("window"). Handles drawing, hit testing and
// pointer routing. Each top-level <panel> of the script becomes one Window.

import { Control, Pointer } from './controls';
import { PanelNode } from './panels';
import { SkinLibrary, drawFrame } from './bitmaps';
import { Model } from '../model/model';
import { compileValueRef } from '../model/expr';

export class Window {
  readonly el: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private hits: Control[] = [];
  private active?: Control;
  private hovered?: Control;
  private downAt = { x: 0, y: 0 };
  private zoom = 1;
  visible = false;
  onStatus: (s: string) => void = () => {};

  constructor(
    readonly root: PanelNode,
    private model: Model,
    private skins: SkinLibrary,
    readonly floating: boolean,
  ) {
    this.el = document.createElement('div');
    this.el.className = floating ? 'jx-window jx-floating' : 'jx-window jx-main';
    if (floating) {
      const bar = document.createElement('div');
      bar.className = 'jx-titlebar';
      bar.textContent = root.name;
      const close = document.createElement('button');
      close.className = 'jx-close';
      close.textContent = '×';
      close.title = 'Close';
      close.onclick = () => this.close();
      bar.appendChild(close);
      this.el.appendChild(bar);
      makeDraggable(this.el, bar);
      this.el.style.display = 'none';
    }
    this.canvas = document.createElement('canvas');
    this.el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.setZoom(1);
    this.bindEvents();
  }

  setZoom(z: number) {
    this.zoom = z;
    const dpr = window.devicePixelRatio || 1;
    const w = this.root.w;
    const h = this.root.h;
    this.canvas.width = Math.round(w * z * dpr);
    this.canvas.height = Math.round(h * z * dpr);
    this.canvas.style.width = `${w * z}px`;
    this.canvas.style.height = `${h * z}px`;
  }

  /** Close a popup by clearing the view-state value its openCondition tests ("ref,N,=="). */
  close() {
    const m = this.root.condSrc?.match(/^([\w.[\]]+),\d+,==/);
    if (m) {
      const v = compileValueRef(m[1])(this.model);
      if (v) this.model.set(v, 0, 'ui');
    }
  }

  isOpen() {
    return !this.root.cond || !!this.root.cond(this.model);
  }

  render() {
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.ctx;
    ctx.setTransform(this.zoom * dpr, 0, 0, this.zoom * dpr, 0, 0);
    ctx.imageSmoothingEnabled = (this.zoom * dpr) % 1 !== 0;
    ctx.fillStyle = '#1b1d22';
    ctx.fillRect(0, 0, this.root.w, this.root.h);
    this.hits = [];
    this.drawPanel(this.root, -this.root.x, -this.root.y, true);
  }

  private drawPanel(p: PanelNode, ox: number, oy: number, isRoot = false) {
    if (!isRoot && p.cond && !p.cond(this.model)) return;
    const x = ox + p.x;
    const y = oy + p.y;
    const s = this.skins.get(p.bitmap);
    if (s) drawFrame(this.ctx, s, 0, x, y);
    for (const it of p.items) {
      if (it.kind === 'panel') this.drawPanel(it, x, y);
      else {
        it.ax = x + it.x;
        it.ay = y + it.y;
        try {
          it.draw(this.ctx, it.ax, it.ay);
        } catch (e) {
          console.warn('draw failed', it.type, it.name, e);
        }
        if (it.interactive()) this.hits.push(it);
      }
    }
  }

  private hitTest(x: number, y: number): Control | undefined {
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const c = this.hits[i];
      if (x >= c.ax && y >= c.ay && x < c.ax + c.w && y < c.ay + c.h) return c;
    }
    return undefined;
  }

  private local(e: PointerEvent | WheelEvent | MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / this.zoom, y: (e.clientY - r.top) / this.zoom };
  }

  private pointer(c: Control, e: PointerEvent | MouseEvent | WheelEvent): Pointer {
    const l = this.local(e);
    return {
      x: l.x - c.ax,
      y: l.y - c.ay,
      dx: l.x - this.downAt.x,
      dy: l.y - this.downAt.y,
      shift: e.shiftKey,
      ctrl: e.ctrlKey || e.metaKey,
      button: e.button,
    };
  }

  private bindEvents() {
    const cv = this.canvas;
    cv.addEventListener('pointerdown', (e) => {
      const l = this.local(e);
      const c = this.hitTest(l.x, l.y);
      if (!c) return;
      e.preventDefault();
      this.downAt = l;
      this.active = c;
      cv.setPointerCapture(e.pointerId);
      c.down(this.pointer(c, e));
      this.onStatus(c.tip() ?? '');
      this.invalidate();
    });
    cv.addEventListener('pointermove', (e) => {
      if (this.active) {
        this.active.drag(this.pointer(this.active, e));
        this.invalidate();
        return;
      }
      const l = this.local(e);
      const c = this.hitTest(l.x, l.y);
      if (c !== this.hovered) {
        this.hovered = c;
        cv.style.cursor = c?.cursor ?? 'default';
        this.onStatus(c?.tip() ?? '');
      }
    });
    const end = (e: PointerEvent) => {
      if (!this.active) return;
      const c = this.active;
      this.active = undefined;
      c.up(this.pointer(c, e));
      this.onStatus(c.tip() ?? '');
      this.invalidate();
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener(
      'wheel',
      (e) => {
        const l = this.local(e);
        const c = this.hitTest(l.x, l.y);
        if (!c) return;
        e.preventDefault();
        c.wheel(e.deltaY, this.pointer(c, e));
        this.onStatus(c.tip() ?? '');
        this.invalidate();
      },
      { passive: false },
    );
    cv.addEventListener('dblclick', (e) => {
      const l = this.local(e);
      const c = this.hitTest(l.x, l.y);
      if (!c) return;
      c.dblclick(this.pointer(c, e));
      this.invalidate();
    });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  invalidate = () => {};
}

function makeDraggable(el: HTMLElement, handle: HTMLElement) {
  handle.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return;
    const sx = e.clientX - el.offsetLeft;
    const sy = e.clientY - el.offsetTop;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      el.style.left = `${Math.max(0, ev.clientX - sx)}px`;
      el.style.top = `${Math.max(0, ev.clientY - sy)}px`;
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}
