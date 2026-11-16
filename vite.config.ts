import { defineConfig, Plugin } from 'vite';
import { resolve } from 'node:path';
import { readdirSync } from 'node:fs';

// Runtime assets from the original editor (Script.xml, skins, InitialData.jxe), unchanged.
const ASSET_DIR = resolve(__dirname, 'public');

// Exposes the list of bitmap files so names from Script.xml can be matched
// case-insensitively (the original ran on Windows, where file names are not case sensitive).
function assetIndex(): Plugin {
  const id = 'virtual:asset-index';
  return {
    name: 'asset-index',
    resolveId: (s) => (s === id ? '\0' + id : undefined),
    load(s) {
      if (s !== '\0' + id) return;
      const files = readdirSync(resolve(ASSET_DIR, 'JUXE')).filter((f) => /\.bmp$/i.test(f));
      return `export default ${JSON.stringify(files)};`;
    },
  };
}

// public/JUXE holds the original editor's assets (Script.xml, bitmaps, InitialData.jxe),
// served unchanged so the clone stays driven by the same script as JUXE.exe.
export default defineConfig({
  base: './',
  publicDir: ASSET_DIR,
  plugins: [assetIndex()],
  server: { port: 5173 },
});
