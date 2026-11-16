import { defineConfig, Plugin } from 'vite';
import { resolve } from 'node:path';
import { readdirSync } from 'node:fs';

const SCRIPT_DIR = resolve(__dirname, '../Script');

// Exposes the list of bitmap files so names from Script.xml can be matched
// case-insensitively (the original ran on Windows, where file names are not case sensitive).
function assetIndex(): Plugin {
  const id = 'virtual:asset-index';
  return {
    name: 'asset-index',
    resolveId: (s) => (s === id ? '\0' + id : undefined),
    load(s) {
      if (s !== '\0' + id) return;
      const files = readdirSync(resolve(SCRIPT_DIR, 'JUXE')).filter((f) => /\.bmp$/i.test(f));
      return `export default ${JSON.stringify(files)};`;
    },
  };
}

// The original editor's assets (Script.xml, bitmaps, InitialData.jxe) are served
// unchanged from ../Script so the clone stays a drop-in replacement for JUXE.exe.
export default defineConfig({
  base: './',
  publicDir: SCRIPT_DIR,
  plugins: [assetIndex()],
  server: { port: 5173 },
});
