# Validation matrix (feature → test → evidence)

Evidence was produced on **Windows 11 x64 (local)**, 2026-10-29, Node 24.22.2, Electron 45.1.0.
Unit/fuzz: `npm run test` (Vitest). E2E: `npm run test:e2e` (Playwright `_electron`, built app, Chromium sandbox on,
fails on any console error). Screenshots: `artifacts/screenshots/{M0,M1}/`. CI (Windows/macOS): **not run** (no remote).

## Clinical geometry and values (analytic references)

| Requirement | Reference / formula | Test | Result |
|---|---|---|---|
| Slice order by IPP projection on row × column normal | PS3.3 C.7.6.2.1.1 | `tests/unit/dicom-core/stack.test.ts` (axial, oblique 30°, shuffled), `fixtures.test.ts` shuffled | Pass |
| Spacing from IPP, never SliceThickness | Δd between sorted positions, median | `stack.test.ts` "ignores SliceThickness" | Pass |
| Gap / non-uniform / duplicate / mixed orientation / multi-acquisition detection | tolerances in `STACK_TOLERANCES` (0.01 mm or 1 %, gap > 1.5 × median) | `stack.test.ts`; E2E "geometry warnings…" | Pass |
| Gantry tilt angle | angle(normal, IPP progression); 15° phantom → 15.000° | `stack.test.ts`, `fixtures.test.ts`, E2E | Pass |
| InstanceNumber fallback shown | — | `stack.test.ts`, E2E Info panel "Instance Number" | Pass |
| Orientation labels for axial/sagittal/coronal, rotate 90/180/270, flip H/V, H+V = 180° | LPS letters; camera right = viewUp × viewPlaneNormal | `orientation.test.ts` (12 analytic cases) | Pass |
| Labels match the **rendered** image (no L/R or A/P inversion) | asymmetric phantom: bright marker at L-A-H | E2E "orientation markers…": 3 planes × 9 rotate/flip steps, centroid of the marker vs label side | Pass |
| Projection images (PatientOrientation) | `L\F` → R left, H top | `orientation.test.ts`, E2E (XA `L\F`) | Pass |
| Anisotropic pixels: correct mapping and rendering | PixelSpacing = [row, column]; 25 mm circle with 1.0 × 0.5 mm pixels | `stack.test.ts` (pixel↔patient), E2E aniso: rendered aspect 0.93–1.07, probe (64,64) | Pass |
| HU from rescale | HU = SV × slope + intercept | `voi-format-charset.test.ts`; E2E probe at 3 sphere centres = 1000 / 100 / −100 HU, air = −1000 HU | Pass (exact) |
| VOI LINEAR / LINEAR_EXACT / SIGMOID | PS3.3 C.11.2.1.2 formulas | `voi-format-charset.test.ts`; E2E presets: Brain 80/40, Bone 2000/500, Lung 1500/−600 exact; SIGMOID applied | Pass |
| Modality LUT Sequence | output = LUT[SV − first] | `lut.test.ts`; E2E probe 8190 at stored 4095 | Pass |
| VOI LUT Sequence (256-point piecewise-linear approximation) | gamma 0.5 LUT: 25 % input → ~50 % grey | `lut.test.ts`; E2E luminance 105–150 at 25 % of ramp | Pass |
| Pixel Padding Value (signed) | padding flagged in probe | E2E probe (1,1) = −2000 HU, padding | Pass |
| Lossless transfer syntaxes decode identically | reference pattern | unit: JPEG-LS, J2K, HTJ2K, JPEG lossless, RLE bit-exact vs explicit LE; E2E: probe 4035 and 1208 in 9 TS | Pass |
| Photometric (RGB planar 0/1, YBR_FULL, PALETTE) | known colours | E2E probe colours [255,0,255], palette [235,20,40], YBR ±6 | Pass |
| Pixel-spacing basis | Pixel Spacing → Imager PS ÷ magnification → US → none | `orientation.test.ts` (spacing basis), E2E CR basis "÷ magnification (1.1)" | Pass |
| Turkish character sets | ISO_IR 148, ISO_IR 192, ISO 2022 IR 6\IR 148 escapes, undeclared → uncertain | `voi-format-charset.test.ts`, `fixtures.test.ts`, E2E series bar names + warning | Pass |
| Person-name formatting with Turkish casing | `toLocaleUpperCase('tr-TR')` | `voi-format-charset.test.ts` | Pass |
| Enhanced MR per-frame geometry | per-frame IPP, frames sorted spatially | `fixtures.test.ts`, E2E labels + 20 frames | Pass |

## Data sources and robustness

| Requirement | Test | Result |
|---|---|---|
| Open files/folders, DICOMDIR (case-insensitive IDs) | E2E core flow, "DICOMDIR, ZIP…" (10 images, `usedDicomdir`) | Pass |
| ZIP plain / AES-256 / ZipCrypto with password prompt, wrong password retry | E2E "DICOMDIR, ZIP…" | Pass |
| ZIP bomb (256 MiB zeros, ratio ≈ 1000) refused | E2E, notice shown | Pass |
| ZIP path traversal refused | E2E (`zipTraversal`, nothing extracted), fuzz `safeZipPath` (2000 random names) | Pass |
| Malformed corpus never crashes; readable errors | E2E "malformed files…" (7 corrupt codec streams → error state; only the exact decoder diagnostics are allowed on the console; app still opens a good series) | Pass |
| Parsers never throw on mutated input | `tests/fuzz/parsers.fuzz.test.ts` (60 seeds × 14 sources in CI; 400 seeds run locally) | Pass |
| Deflated TS ingestion | `fixtures.test.ts` (rewrite bit-exact), E2E probe values | Pass |
| Every valid fixture opens (≥ 45 display sets) | E2E "every fixture opens…" | Pass |

## Security and privacy

| Requirement | Test | Result |
|---|---|---|
| sandbox, contextIsolation, no nodeIntegration | E2E m0 (webPreferences, no `process`/`require` in renderer) | Pass |
| CSP present; remote fetch refused; navigation & window.open blocked | E2E m0 | Pass |
| Only allow-listed `window.api` | E2E m0 | Pass |
| WebGL path (no CPU fallback) | E2E m0 | Pass (local GPU) |
| Fuses in packaged app | `npx @electron/fuses read` on `release/win-unpacked` | Pass (RunAsNode, NODE_OPTIONS, inspect off; ASAR integrity on) |
| License allow-list on shipped code | `npm run license:check` (50 packages, 1 approved exception) | Pass |
| `npm audit --audit-level=high` | `npm run audit` | Pass (6 moderate, R-013) |

## UI

| Requirement | Test / evidence | Result |
|---|---|---|
| Layouts 1×1…5×5, 1+2, 2+1, maximize | E2E core flow (cell bounds inside grid), `layout-5x5-*.png` | Pass |
| Scroll (wheel, keys, PgUp/PgDn, Home/End), W/L drag, zoom, pan, Ctrl+wheel, fit, rotate, flip, invert, reset, context menu, numeric W/L | E2E core flow | Pass |
| 1:1 = one image pixel per device pixel; zoom % in device pixels | `m1-coverage` (pixel-centre spacing on screen = 100 / dpr CSS px for 100 columns; mm per CSS px = 0.5 × dpr) | Pass |
| Left-button tools (scroll drag, pan, zoom) do not change W/L | `m1-coverage` | Pass |
| Slice slider, PageUp, sort key/direction (first image z = 0 asc, 87 desc) | `m1-coverage` | Pass |
| PET Units label (BQML), PET % presets, user W/L preset save + apply | `m1-coverage` | Pass |
| Hide patient data: overlay, series bar, tag browser masked | `m1-coverage` | Pass |
| Tag pin and copy-all (text handed to Electron clipboard) | `m1-coverage` | Pass (OS clipboard itself UNVERIFIED: not accessible in this environment) |
| Settings at runtime: language, theme, overlay content, cine bounce, persisted | `m1-coverage` | Pass |
| Scan cancel | `m1-coverage` (cancel via the button's IPC call) | Pass |
| Drag & drop from the OS | — | UNVERIFIED (manual QA) |
| Cine | E2E (index advances while playing) | Pass |
| DICOM overlays incl. per-frame, toggle | E2E (overlay colour at frame line, hidden after toggle) | Pass |
| Tag browser search, location | E2E core flow | Pass |
| Full screen / distraction-free | E2E core flow | Pass |
| Intended-use statement in About, splash, status bar | E2E m0 | Pass |
| Screenshots 1280×800 & 1920×1080 × dark/light × tr/en inspected | `artifacts/screenshots/M0`, `M1` | Inspected; issues fixed (toolbar overflow, thumbnails, labels, tag table) |

## Performance (Windows 11 laptop, local GPU; `artifacts/perf-m1.json`)

| Metric | Target | Measured |
|---|---|---|
| First image of a 520-slice 512×512 CT after selection | ≤ 1.5 s | 0.17–0.53 s (3 runs) |
| Scrolling a cached series | ≥ 30 fps | 55 images/s (display-bound) |
| Scrolling while prefetch is still decoding | — | ~27 renders/s (earlier rAF-paced measurement; see report) |
| Heap after opening/closing 20 series | no unbounded growth | 556–569 MB → 51–74 MB after close; image cache 0 MB |
| Index 520 files | — | ~0.5 s |
