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
| Slice slider, PageUp, default spatial order (first z = 0, last z = 87 despite shuffled instance numbers) | `m1-coverage` | Pass |
| Flip H/V twice restores the original image (pixel centroid) | `m1-coverage` | Pass |
| Instant tooltips (incl. disabled buttons); TR/EN language button persists | `m1-coverage` | Pass |
| First launch: English, no splash, About holds legal/intended-use text | `m0-shell` | Pass |
| PET Units label (BQML), PET % presets, user W/L preset save + apply | `m1-coverage` | Pass |
| Hide patient data: overlay, series bar, tag browser masked | `m1-coverage` | Pass |
| Tag pin and copy-all (text handed to Electron clipboard) | `m1-coverage` | Pass (OS clipboard itself UNVERIFIED: not accessible in this environment) |
| Settings at runtime: language, theme, overlay content, cine bounce, persisted | `m1-coverage` | Pass |
| Scan cancel | `m1-coverage` (cancel via the button's IPC call) | Pass |
| Drag & drop from the OS | — | UNVERIFIED (manual QA) |
| Cine | E2E (index advances while playing) | Pass |
| DICOM overlays incl. per-frame, toggle | E2E (overlay colour at frame line, hidden after toggle) | Pass |
| Tag browser search, location | E2E core flow | Pass |
| Full screen (F11, Esc); F10 no longer hides the UI | E2E core flow | Pass |
| Intended-use statement in About ("i" button) and status bar | E2E m0 | Pass |
| Screenshots 1280×800 & 1920×1080 × dark/light × tr/en inspected | `artifacts/screenshots/M0`, `M1` | Inspected; issues fixed (toolbar overflow, thumbnails, labels, tag table) |

## Measurements (M2)

| Requirement | Test | Evidence |
|---|---|---|
| Length uses column spacing along rows and row spacing along columns; anisotropic 25 mm circle = 50 mm both ways | unit `measure.test.ts`, E2E `m2-measure` (aniso) | Pass |
| Imager Pixel Spacing ÷ magnification (CR, labelled); manual calibration keeps the pixel aspect; saved and reloaded | unit, E2E (cr-mag, calibration persistence) | Pass |
| US: mm only when all points lie in one spatial region; outside/across/non-spatial → px with a warning | unit (synthetic + `us-regions` fixture), E2E | Pass |
| Angle and Cobb in physical space; deviation perpendicular to the infinite line; length ratio of physical lengths | unit (analytic), E2E (angle 90°) | Pass |
| Shoelace area, ellipse area (conjugate semi-axes), point-in-shape; ROI stats with pixel-centre rule and Welford SD | unit (ramp/circle phantoms, large offsets) | Pass |
| ROI in HU on the CT phantom (1000 HU sphere: mean 1000, SD 0); area equals π·a·b of the handles placed | E2E | Pass |
| SUVbw: hand-computed reference (5.1885), ADMIN, GML, series-time rewrite, midnight; refuses with missing tags named | unit `suv.test.ts`, E2E (pet 5.19 SUVbw; pet-missing names PatientWeight, RadionuclideTotalDose) | Pass |
| Ellipsoid π/6·abc and bullet 5π/24·abc from three ticked lengths | unit, E2E (list volume box) | Pass |
| Arrow with text (Turkish characters), Esc cancels unfinished polygon/ellipse, Delete removes selected, zero-length line discarded | E2E | Pass |
| List: rename, delete, jump to the image, undo/redo (Ctrl+Z / Ctrl+Y) | E2E | Pass |
| Saved per study, restored after restart with identical pixel coordinates; loaded items are not undoable | E2E (two launches with the same app data) | Pass |
| Measurement on a series that left the viewport stays listed and is saved | E2E (orient-axial → sagittal, restart) | Pass |
| Each image measured with its own calibration (US series at 0.2 / 0.4 mm/px) | E2E (`us-multi`) | Pass |
| Calibration kept when the study is only partly open at save time | E2E (three launches) | Pass |
| Ellipse perimeter (Ramanujan II vs numerical integration; anisotropic and rotated cases) and rectangle perimeter | unit + E2E | Pass |
| Trash button on hover deletes a drawing; undo restores it; start screen opens with "Open folder" highlighted | E2E "perimeter … trash button …" | Pass |
| Values drawn on the image (SVG text) for freehand circle, open polyline and deviation | E2E "every tool shows its value on the image" | Pass |
| Dialogs take typed input at once (real key presses), invalid calibration explained, Esc cancels; calibration drawn click-move-click | E2E "dialogs take keyboard input at once" | Pass |
| Unreadable / oversized / foreign measurement files set aside, never trusted | fuzz `measurements.fuzz.test.ts` | Pass |
| No CSP violation from measurement text (D-044) | every E2E (console errors fail the run) | Pass |
| Screenshots 1280×800 & 1920×1080 × dark/light × tr/en | `artifacts/screenshots/M2` (22 files) | Inspected |

## Series comparison (M3)

| Requirement | Test | Evidence |
|---|---|---|
| Image planes, nearest slice with outside detection, auto-sync rule (same FoR, ≤ 5°), offset link | unit `compare.test.ts` (analytic planes) | Pass |
| Reference line = intersection of both image rectangles (sagittal/axial, coronal/axial, oblique 30°, limited source extent, parallel → none) | unit | Pass |
| 3D cursor: slice and pixel of a patient point | unit + E2E (axial click → sagittal index 14, marker at column 40 / row 83.5) | Pass |
| Multi-volume split by temporal position / b-value / echo / acquisition; DWI and 3-phase CT fixtures | unit `compare.test.ts`, `m3-fixtures.test.ts`, E2E (labels b=1000, Phase 3; combine/split toggle) | Pass |
| Automatic slice sync 4 mm ↔ 2 mm stacks in one FoR, both directions | E2E `m3-compare` | Pass |
| Prior study (other FoR) not synced until linked; linked keeps the offset | E2E | Pass |
| Reference line on the axial viewport for the active sagittal slice (column 63.5), toggle off/on | E2E | Pass |
| Window/level (same modality) and zoom follow the active viewport | E2E | Pass |
| Compare with prior: best-matching series side by side, fitted, linked | E2E | Pass |
| Single-slice dynamics (bolus tracking, cine) are not split; nothing crosses Frames of Reference (reference line, 3D cursor); no sync between perpendicular planes; W/L sync only for the same modality; maximize keeps the zoom | unit + E2E "gating" | Pass |
| Screenshots 1280×800 & 1920×1080 × dark/light × tr/en | `artifacts/screenshots/M3` (19 files) | Inspected; fixed: refit on layout change, redundant "Part n" label, wrapped volumes link |

## Performance (Windows 11 laptop, local GPU; `artifacts/perf-m1.json`)

| Metric | Target | Measured |
|---|---|---|
| First image of a 520-slice 512×512 CT after selection | ≤ 1.5 s | 0.17–0.53 s (3 runs) |
| Scrolling a cached series | ≥ 30 fps | 55 images/s (display-bound) |
| Scrolling while prefetch is still decoding | — | ~27 renders/s (earlier rAF-paced measurement; see report) |
| Heap after opening/closing 20 series | no unbounded growth | 556–569 MB → 51–74 MB after close; image cache 0 MB |
| Index 520 files | — | ~0.5 s |
