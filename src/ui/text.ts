import { XNode, childText, childrenOf } from '../script/xnode';

export interface TextWriter {
  font: string;
  color: string;
  hAlign: 'left' | 'center' | 'right';
  vAlign: 'top' | 'center' | 'bottom';
  background?: string;
  truncate: boolean;
  vertical: boolean;
}

/** "0xFF00,0xC000,0x0000" (16-bit Mac-style RGB) -> css color */
export function parseColor(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const p = s.split(',').map((x) => parseInt(x.trim(), 16) >> 8);
  if (p.length < 3 || p.some(isNaN)) return undefined;
  return `rgb(${p[0]},${p[1]},${p[2]})`;
}

export class TextLibrary {
  private writers = new Map<string, TextWriter>();
  readonly strings = new Map<string, string[]>();
  readonly numbers = new Map<string, number[]>();

  constructor(script: XNode) {
    for (const t of childrenOf(script, 'textWriter')) {
      const h = parseInt(childText(t, 'fontHeight') ?? '10', 10);
      const align = (childText(t, 'textAlignmentHorizontal') ?? childText(t, 'textAlignment') ?? 'left').toLowerCase();
      const v = (childText(t, 'textAlignmentVertical') ?? 'center').toLowerCase();
      const face = childText(t, 'fontFaceName') ?? 'Arial';
      this.writers.set(childText(t, 'name')!, {
        // Windows font height is the cell height; CSS px size ~ 1.0x for Arial at these sizes
        font: `${h + 1}px "${face}", Arial, Helvetica, sans-serif`,
        color: parseColor(childText(t, 'fontColor')) ?? '#000',
        hAlign: align.startsWith('c') ? 'center' : align.startsWith('r') ? 'right' : 'left',
        vAlign: v.startsWith('t') ? 'top' : v.startsWith('b') ? 'bottom' : 'center',
        background:
          (childText(t, 'backgroundMode') ?? 'opaque').toLowerCase() === 'transparent'
            ? undefined
            : parseColor(childText(t, 'backgroundColor')),
        truncate: childText(t, 'truncate') === '1',
        vertical: /^(1|true)$/i.test(childText(t, 'verticalFont') ?? ''),
      });
    }
    for (const t of childrenOf(script, 'stringTable')) {
      this.strings.set(childText(t, 'name')!, splitTable(childText(t, 'table') ?? ''));
    }
    for (const t of childrenOf(script, 'numberTable')) {
      this.numbers.set(
        childText(t, 'name')!,
        splitTable(childText(t, 'table') ?? '').map((x) => parseInt(x, 10)),
      );
    }
  }

  writer(name: string | undefined): TextWriter {
    return (
      (name && this.writers.get(name)) || {
        font: '10px Arial, sans-serif',
        color: '#9cf',
        hAlign: 'left',
        vAlign: 'center',
        truncate: false,
        vertical: false,
      }
    );
  }

  draw(
    ctx: CanvasRenderingContext2D,
    writerName: string | TextWriter | undefined,
    text: string,
    x: number,
    y: number,
    w: number,
    h: number,
  ) {
    const tw = typeof writerName === 'object' ? writerName : this.writer(writerName);
    if (tw.background) {
      ctx.fillStyle = tw.background;
      ctx.fillRect(x, y, w, h);
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.font = tw.font;
    ctx.fillStyle = tw.color;
    if (tw.vertical) {
      // text runs bottom-to-top; "bottom" alignment anchors it at the bottom edge
      ctx.translate(x + w / 2, y + h);
      ctx.rotate(-Math.PI / 2);
      ctx.textBaseline = 'middle';
      ctx.textAlign = tw.vAlign === 'top' ? 'right' : tw.vAlign === 'center' ? 'center' : 'left';
      const tx = tw.vAlign === 'top' ? h - 2 : tw.vAlign === 'center' ? h / 2 : 2;
      ctx.fillText(text.trimEnd(), tx, 0.5);
      ctx.restore();
      return;
    }
    ctx.textBaseline = 'middle';
    ctx.textAlign = tw.hAlign;
    const tx = tw.hAlign === 'left' ? x : tw.hAlign === 'right' ? x + w : x + w / 2;
    const ty = tw.vAlign === 'top' ? y + 5 : tw.vAlign === 'bottom' ? y + h - 5 : y + h / 2 + 0.5;
    ctx.fillText(text, tx, ty);
    ctx.restore();
  }
}

/** Table entries are comma separated; whitespace/newlines around entries are layout only. */
export function splitTable(s: string): string[] {
  return s.split(',').map((x) => x.replace(/\s+/g, ' ').trim());
}
