// Electron shell for the JUNO-Di editor.
// - Serves the Vite build (dist/, which includes the original Script/ assets) through a
//   private app:// protocol so fetch() of Script.xml, bitmaps and InitialData.jxe works.
// - Grants Web MIDI + SysEx without a prompt (the editor cannot work without SysEx).

const { app, BrowserWindow, Menu, protocol, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const ROOT = path.join(__dirname, '..', 'dist');
const SCHEME = 'app';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.bmp': 'image/bmp',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

async function serve(request) {
  const url = new URL(request.url);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) return new Response('Forbidden', { status: 403 });
  try {
    // fs (not net.fetch) so this also works when dist/ is packed inside app.asar
    const data = await fs.readFile(file);
    return new Response(data, { headers: { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

const MIDI_PERMISSIONS = new Set(['midi', 'midiSysex']);

function createWindow() {
  const win = new BrowserWindow({
    width: 1024,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    title: 'JUNO-Di Editor',
    backgroundColor: '#0f1013',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.loadURL(`${SCHEME}://editor/index.html`);
  // links (if any) open in the system browser, never inside the editor window
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function buildMenu() {
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      // macOS: the first menu is the app menu, and Cmd+C/V/A only work in text fields
      // (patch names) when an Edit menu provides them.
      ...(mac ? [{ role: 'appMenu' }, { role: 'editMenu' }] : [{ label: 'File', submenu: [{ role: 'quit' }] }]),
      {
        label: 'View',
        submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }],
      },
    ]),
  );
}

app.whenReady().then(() => {
  protocol.handle(SCHEME, serve);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(MIDI_PERMISSIONS.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => MIDI_PERMISSIONS.has(permission));
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
