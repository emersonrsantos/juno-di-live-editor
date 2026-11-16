# JUNO-Di Editor (web)

A TypeScript/Web MIDI re-implementation of Roland's `JUXE.exe` editor. Like the original, it is
an engine driven by `../Script/JUXE/Script.xml`: the parameter map, panels, controls and skins
all come from that file and the BMPs next to it, which are served unchanged.

```bash
npm install
npm run dev      # http://localhost:5173 (use Chrome or Edge for SysEx access)
npm test
npm run build    # static site in dist/
```

## Layout

| Path | Purpose |
| --- | --- |
| `src/script/` | XML loading (Shift_JIS) and `$var` template substitution |
| `src/model/model.ts` | Struct/value tree over 7-bit addressed byte blocks |
| `src/model/expr.ts` | RPN expressions and value references (`fm.pat[vs.control.partId].…`) |
| `src/model/jxe.ts` | `.jxe` (KoaDataFile) read/write, byte-compatible with JUXE.exe |
| `src/ui/` | Bitmap skins, text writers, panel builder, controls, canvas windows |
| `src/midi/` | Roland DT1/RQ1 encoding, Web MIDI link, Read/Sync |
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

**Mode:** switching PERFORM/PATCH in the editor sets `fm.setup.soundMode` on the synth
(PERFORM = 1, PATCH = 0, as JUXE.exe does), and Read first reads Setup and follows the synth's mode.
