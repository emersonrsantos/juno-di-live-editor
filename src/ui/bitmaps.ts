// Bitmap skins. A <bitmap> entry describes a BMP strip:
//   stateCount  number of frames (default 1)
//   direction   0 = frames stacked vertically (default), 1 = frames laid out horizontally
//   mask        1 = a grayscale mask of the same size follows the image along the axis
//               orthogonal to the frames (black = opaque, white = transparent)

import fileList from 'virtual:asset-index';
import { XNode, childText, childrenOf } from '../script/xnode';

export interface Skin {
  name: string;
  frames: number;
  width: number; // frame width
  height: number; // frame height
  canvas: HTMLCanvasElement; // all frames, mask applied
  horizontal: boolean;
}

const byLower = new Map<string, string>((fileList as string[]).map((f) => [f.toLowerCase(), f]));

export class SkinLibrary {
  private defs = new Map<string, { frames: number; horizontal: boolean; mask: boolean }>();
  private skins = new Map<string, Skin>();

  constructor(
    script: XNode,
    private baseUrl: string,
  ) {
    for (const b of childrenOf(script, 'bitmap')) {
      const name = childText(b, 'name')!;
      this.defs.set(name.toLowerCase(), {
        frames: parseInt(childText(b, 'stateCount') ?? '1', 10) || 1,
        horizontal: childText(b, 'direction') === '1',
        mask: childText(b, 'mask') === '1',
      });
    }
  }

  get(name: string | undefined): Skin | undefined {
    return name ? this.skins.get(name.toLowerCase()) : undefined;
  }

  async loadAll(onProgress?: (done: number, total: number) => void) {
    const names = [...new Set([...this.defs.keys(), ...[...byLower.keys()].map((f) => f.replace(/\.bmp$/, ''))])];
    let done = 0;
    await Promise.all(
      names.map(async (n) => {
        try {
          const s = await this.load(n);
          if (s) this.skins.set(n, s);
        } catch (e) {
          console.warn('bitmap', n, e);
        }
        onProgress?.(++done, names.length);
      }),
    );
  }

  private async load(lower: string): Promise<Skin | undefined> {
    const file = byLower.get(lower + '.bmp');
    if (!file) return undefined;
    const def = this.defs.get(lower) ?? { frames: 1, horizontal: false, mask: false };
    const res = await fetch(`${this.baseUrl}${file}`);
    const img = await createImageBitmap(await res.blob());
    let w = img.width;
    let h = img.height;
    // mask lies orthogonal to the frame direction
    if (def.mask) {
      if (def.horizontal) h = Math.floor(h / 2);
      else w = Math.floor(w / 2);
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    if (def.mask) {
      const m = document.createElement('canvas');
      m.width = w;
      m.height = h;
      const mctx = m.getContext('2d', { willReadFrequently: true })!;
      mctx.drawImage(img, def.horizontal ? 0 : -w, def.horizontal ? -h : 0);
      const id = ctx.getImageData(0, 0, w, h);
      const md = mctx.getImageData(0, 0, w, h).data;
      for (let i = 0; i < id.data.length; i += 4) id.data[i + 3] = 255 - md[i];
      ctx.putImageData(id, 0, 0);
    }
    const frames = def.frames;
    return {
      name: file.replace(/\.bmp$/i, ''),
      frames,
      horizontal: def.horizontal,
      width: def.horizontal ? Math.floor(w / frames) : w,
      height: def.horizontal ? h : Math.floor(h / frames),
      canvas,
    };
  }
}

export function drawFrame(ctx: CanvasRenderingContext2D, s: Skin, frame: number, x: number, y: number) {
  const f = Math.max(0, Math.min(s.frames - 1, frame | 0));
  const sx = s.horizontal ? f * s.width : 0;
  const sy = s.horizontal ? 0 : f * s.height;
  ctx.drawImage(s.canvas, sx, sy, s.width, s.height, x, y, s.width, s.height);
}
