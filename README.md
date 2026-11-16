# JUNO-Di Live Editor

**Roland's JUNO-Di editor, rewritten for 2026.** 🎛️

It looks and works like the old JUNO-Di editor, with one big upgrade: **live editing**. Every
change goes to the synth the moment you make it, just like turning a knob on the panel. Tune
the sound and hear it at the same time, no more tweak-sync-listen-repeat.

Prefer the classic workflow? It's still here: **Read** the sound from the synth, edit it at your
leisure, **Sync** it back and **Write** it to memory.

## Getting started

```bash
npm install
npm run dev      # http://localhost:5173 (use Chrome or Edge for SysEx access)
npm test
npm run build    # static site in dist/
```

## Desktop app (Electron)

```bash
npm run desktop     # build and run in an Electron window
npm run dist:win    # release/: "JUNO-Di Editor Setup x.y.z.exe" (installer) and a portable .exe
npm run dist:mac    # release/: .dmg and .zip for Apple Silicon (arm64) and Intel (x64); run on a Mac
```

macOS builds are ad-hoc signed (`scripts/adhoc-sign.cjs`) but not notarized: on first launch,
open the app, then allow it under System Settings → Privacy & Security → "Open Anyway".

## Releases

GitHub Actions (`.github/workflows/`): `ci.yml` builds and tests every push and PR;
`build.yml` packages the Windows and macOS apps; `release.yml` runs when a `v*` tag matching
`package.json`'s version is pushed and attaches all packages and a web zip to a GitHub Release:

```bash
npm version 0.2.0 && git push --follow-tags
```

`electron/main.cjs` serves `dist/` (which includes the original `Script/` assets) through a
private `app://` protocol and grants Web MIDI + SysEx without a permission prompt. Builds are
unsigned, so Windows SmartScreen may warn on first launch.

Note: npm's install-script allowlist must permit `electron` (see `allowScripts` in
package.json) so its postinstall can download the Electron runtime.

## Assets

`public/JUXE/` contains the files the editor loads at runtime, copied unchanged from Roland's
JUNO-Di Editor: `Script.xml` (parameter map and panel layout), the panel bitmaps and
`InitialData.jxe` (default data). They are © Roland Corporation. The original programs
(`JUXE.exe`, `JUXL.exe`) and manuals are not part of this repository and are not needed.

## Layout

| Path | Purpose |
| --- | --- |
| `public/JUXE/` | Original runtime assets (Script.xml, bitmaps, InitialData.jxe) |
| `src/script/` | XML loading (Shift_JIS) and `$var` template substitution |
| `src/model/model.ts` | Struct/value tree over 7-bit addressed byte blocks |
| `src/model/expr.ts` | RPN expressions and value references (`fm.pat[vs.control.partId].…`) |
| `src/model/jxe.ts` | `.jxe` (KoaDataFile) read/write, byte-compatible with JUXE.exe |
| `src/ui/` | Bitmap skins, text writers, panel builder, controls, canvas windows |
| `src/midi/` | Roland DT1/RQ1 encoding, Web MIDI link, Read/Sync |
| `electron/main.cjs` | Desktop shell: app:// protocol, MIDI/SysEx permission, menu |
| `src/data/` | Name tables (banks, GM2/MFX names) and the bundled wave name table |
| `src/app.ts` | Editor behaviour not in the script (mode/part state, functions, files) |

## Status against a real JUNO-Di

Verified: Read (RQ1 → DT1, ~14 s for a full performance), live edits (DT1 per change),
Sync (DT1 bulk, ~3 s) — each checked by reading values back from the synth — and Write.

**Write** stores the current sound into user memory: performances 0501–0564 (bank MSB 85,
LSB 0, program 0–63) in PERFORM mode, patches 0501–0628 (MSB 87, LSB 0, program 0–127) in PATCH
mode. Both were verified on a JUNO-Di (0564 and 0628). The `cm.command.*` addresses are commands
triggered by **RQ1**, with the argument in the 4-byte size field:

```
-> F0 7E 7F 06 01 F7                          identity request
-> RQ1 0F 00 10 00  size = 55 00 3F 7F        write performance to 0564 (MSB, LSB, PC, 7F)
                    (size = 57 00 7F 7F writes the patch-mode patch to patch 0628)
<- DT1 0F 00 10 01  00 00 00 55 00 3F 7F      writeStart
<- CC0 85, CC32 0, PC 63 on the control channel
<- DT1 0F 00 10 02  00 00 00 55 00 3F 7F      writeComplete
```

**Name lists** are fetched from the synth the first time a bank is shown, with the same kind of
command: RQ1 `0F 00 0x 02` (`performanceNameInformation2` / `patchNameInformation2` /
`rhythmSetNameInformation2`), size = `[MSB, LSB, first program, count ≤ 127]`. The synth streams
one DT1 per entry and ends with an all-zero entry:

| Bank | MSB / LSB | Entries | Reply payload |
| --- | --- | --- | --- |
| User patches 0501–0628 | 87 / 0 | 128 | `MSB LSB PC category 00 name×12` |
| Preset patches 0001–1082 | 87 / 64–72 | 1082 | `MSB LSB PC category 00 name×12` |
| Preset rhythm sets | 86 / 64 | 20 | same as patches |
| Preset performances 0001–0064 | 85 / 64 | 64 | `MSB LSB PC name×12` |
| User performances 0501–0564 | 85 / 0 | 64 | same as performances |

GM2 banks are not served by the synth and use names built into the editor.

**Wave names** (WG section) are bundled: `src/data/JunoDiWaveNameTable.xml` holds the 850
internal waveform names as a `<stringTable>` (`internalWaveNameTable`, entry 1 = wave 0001) in the
same format as Script.xml's SRX tables (`srx01WaveNameTable` ...). JUXE.exe asks the synth for these at
run time; they are fixed in ROM, so they were read once from a JUNO-Di with RQ1 `0F 00 01 02`
(`waveANameInformation2`, size = `[first wave as 3 nibbles, count]`, reply `[number as 4 nibbles,
name×12]`) and the editor no longer queries them. The table is merged into Script.xml's definitions
at startup (`mergeScripts`).

**Live Sync** (toolbar, on by default, remembered): every edit is sent as you make it and
the Sync button is disabled. Off: edits stay in the editor, the status bar counts unsent blocks, and
Sync sends them. Mode switches and sound selections always go out immediately; turning the toggle
back on sends any pending edits.

**Mode:** switching PERFORM/PATCH in the editor sets `fm.setup.soundMode` on the synth
(PERFORM = 1, PATCH = 0, as JUXE.exe does), and Read first reads Setup and follows the synth's mode.
