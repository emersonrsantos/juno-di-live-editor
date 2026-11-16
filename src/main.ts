import './style.css';
import { fetchScript } from './script/load';
import { App } from './app';

const ASSETS = './JUXE/';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function boot() {
  const loading = $('loading');
  try {
    loading.textContent = 'Loading Script.xml…';
    const script = await fetchScript(`${ASSETS}Script.xml`);
    const app = new App(script, ASSETS);
    (window as unknown as { app: App }).app = app;
    await app.start((s) => (loading.textContent = s));
    loading.remove();
    bindToolbar(app);
  } catch (e) {
    loading.textContent = `Failed to start: ${(e as Error).message}`;
    console.error(e);
  }
}

function bindToolbar(app: App) {
  const fileInput = $<HTMLInputElement>('file-input');
  $('btn-new').onclick = () => app.newFile();
  $('btn-open').onclick = () => fileInput.click();
  fileInput.onchange = () => {
    const f = fileInput.files?.[0];
    if (f) app.openFile(f);
    fileInput.value = '';
  };
  $('btn-save').onclick = () => app.saveFile();

  const zoom = $<HTMLSelectElement>('zoom');
  zoom.value = String(parseFloat(localStorage.getItem('juno-di-editor.zoom') ?? '1') || 1);
  zoom.onchange = () => app.setZoom(parseFloat(zoom.value));

  const inSel = $<HTMLSelectElement>('midi-in');
  const outSel = $<HTMLSelectElement>('midi-out');
  const dev = $<HTMLSelectElement>('device-id');
  const thru = $<HTMLInputElement>('midi-thru');
  // Roland displays device IDs 17-32 for SysEx bytes 0x10-0x1F (17 is the factory default)
  for (let i = 0x10; i <= 0x1f; i++) dev.add(new Option(String(i + 1), String(i)));

  const refresh = () => {
    const a = app.midi.access;
    const fill = (sel: HTMLSelectElement, ports: MIDIPort[], cur?: MIDIPort) => {
      sel.innerHTML = '';
      sel.add(new Option('— none —', ''));
      for (const p of ports) sel.add(new Option(p.name ?? p.id, p.id));
      sel.value = cur?.id ?? '';
    };
    fill(inSel, a ? [...a.inputs.values()] : [], app.midi.input);
    fill(outSel, a ? [...a.outputs.values()] : [], app.midi.output);
    dev.value = String(app.midi.deviceId);
    thru.checked = app.midi.through;
    $('midi-state').textContent = a ? (app.midi.output ? 'connected' : 'no output') : 'off';
  };
  app.midi.onState = refresh;
  inSel.onchange = () => app.midi.selectInput(app.midi.access?.inputs.get(inSel.value));
  outSel.onchange = () => app.midi.selectOutput(app.midi.access?.outputs.get(outSel.value));
  dev.onchange = () => app.midi.setDeviceId(parseInt(dev.value, 10));
  thru.onchange = () => app.midi.setThrough(thru.checked);
  $('btn-midi').onclick = async () => {
    await app.connectMidi();
    refresh();
  };
  refresh();
  if (!app.midi.supported) $('btn-midi').setAttribute('disabled', '');
}

boot();
