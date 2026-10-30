# Execution plan (living document)

Source of truth for resuming work. Spec: `docs/PRODUCT_SPEC.md`. Rules: `CLAUDE.md`. Decisions: `docs/DECISIONS.md`.
Status legend: `[x]` done with evidence · `[~]` partial (see PROJECT_STATUS) · `[ ]` not started.

## Stack (exact pins, verified on npm 2026-10-29 — D-003)
| Area | Package | Version |
|---|---|---|
| Runtime | Node (dev + CI) | 24.22.2 LTS (Electron 45 bundles Node 24.22.1) |
| Shell | electron / electron-builder / electron-vite | 45.1.0 / 26.18.1 / 6.0.0 |
| Build | vite / @vitejs/plugin-react / typescript | 8.3.5 / 6.1.2 / 6.0.3 (D-004) |
| UI | react, react-dom / zustand / lucide-react / i18next / react-i18next / zod | 19.3.1 / 5.0.16 / 1.64.0 / 26.5.11 / 17.1.9 / 4.6.7 |
| Imaging | @cornerstonejs/core, tools, dicom-image-loader, metadata, utils | 5.14.0 (all) |
| DICOM | dicom-parser / dcmjs | 1.8.21 / 0.52.0 |
| ZIP | @zip.js/zip.js | 2.24.0 |
| Tests | vitest / @playwright/test | 5.0.5 / 1.64.1 |
| Lint | eslint / typescript-eslint / prettier | 10.13.0 / 8.72.1 / 3.9.10 |
| Polyfill | events (renderer, for vtk.js) | 3.3.0 |
| Licenses | license-checker-rseidelsohn (+ own bundle-based checker) | 5.0.1 |
| Later | better-sqlite3 (M5), dcmjs-dimse vs dicom-dimse-native (M5 benchmark) | 13.0.3 / 0.3.4 / 2.6.1 |

## Repo skeleton
```
apps/desktop/
  main/        index.ts (lifecycle, security, protocol app://), ipc.ts (zod + sender check), scan/ (worker thread),
               files.ts (opaque file-id registry), zip.ts, dicomdir.ts, settings.ts, recent.ts, tags.ts, overlays.ts
  preload/     index.ts → window.api (typed, allow-listed)
  renderer/    index.html, src/{app,components,viewer,state,i18n,styles}
  shared/      ipc-contract.ts (zod schemas + types shared by main/preload/renderer)
packages/dicom-core/src  geometry, orientation, charset, parse, stack, model, voi, format, tags, dicomdir
scripts/fixtures         synthetic DICOM writer + encoders → tests/fixtures/generated
scripts/license-check.ts license gate over the files that actually ship (bundle manifest)
tests/unit  tests/e2e  tests/fuzz
```

## Milestones

### M0 — Foundation — **done** (verified 2026-10-29 on Windows 11; CI not run)
- [x] Monorepo (npm workspaces), TS strict, ESLint (flat config), Prettier
- [x] Electron main: `app://bundle` scheme, CSP header + meta, sandbox/contextIsolation, navigation/window.open/webview/permission blocked, single-instance lock, network blocked at session, fuses
- [x] Preload: typed `window.api`, zod-validated IPC + sender origin check
- [x] Renderer shell: theme tokens (dark/light), i18n tr/en, layout, start screen, About + splash with intended use, status-bar badge
- [x] Vitest harness, Playwright `_electron` harness (console/page/CSP errors fail tests, screenshot helper)
- [x] License checker over shipped bundles + exceptions file + THIRD_PARTY_NOTICES; `npm audit --audit-level=high`
- [x] Synthetic fixture generator (`npm run fixtures`, deterministic, ~11 s)
- [x] CI on GitHub (`windows-latest`, `macos-latest` arm64): green; Intel macOS dropped as a tested platform (D-035)
- [x] Docs
- [x] `npm run dist` → Windows NSIS installer (local + CI) and macOS arm64 DMG (CI); x64 DMG built, untested

#### Fixture list (all synthetic; `tests/fixtures/generated/`)
| Id | Content | Purpose |
|---|---|---|
| ct-phantom | 512×512×64 CT, 0.5 mm px, 2.5 mm slices, spheres of known HU (−100, 0, 100, 1000) and diameters, air background −1000, rescale −1024/1 | HU probe, W/L, later ROI/volume tests |
| ct-large | 512×512×520 CT, uncompressed | performance target (first image, scroll fps) |
| orient-axial/sag/cor | asymmetric phantom: bright marker blobs at patient Left, Anterior, Head side | orientation markers, L/R / A/P inversion test |
| oblique | volume with IOP rotated 20° about two axes | oblique labels, sorting |
| gantry-tilt | CT with 15° tilt (IPP sheared along y) | tilt warning |
| nonuniform | stack with one missing slice and one irregular spacing | spacing warnings |
| shuffled | stack whose InstanceNumber order ≠ spatial order, file names random | spatial sort |
| no-geometry | stack without IPP/IOP | InstanceNumber fallback indicator |
| mixed-orient | localizer series with 3 planes | display-set split |
| enhanced-mr | Enhanced MR multi-frame, per-frame functional groups (20 frames) | multi-frame geometry |
| pet / pet-missing | PT with full SUV tags / without weight + dose | SUV refusal (M4), PET presets |
| cr-mag | CR with Imager Pixel Spacing + magnification factor + PatientOrientation | projection labels, spacing basis (M2) |
| us-regions | US RGB with Sequence of Ultrasound Regions | calibrated regions (M2) |
| rgb / rgb-planar / palette / ybr-full / mono1 | color and photometric variants | photometric decoding |
| ts-* | same 256×256 image in implicit LE, explicit LE, explicit BE, deflated, RLE, JPEG lossless SV1, JPEG baseline, JPEG-LS, J2K, HTJ2K | transfer-syntax decoding |
| voi-lut / modality-lut / sigmoid / multi-window / padding / signed | LUT sequences, VOI functions, multiple windows, pixel padding, signed 16-bit | value pipeline |
| overlay | MR with 6000 overlay (and per-frame overlay on multi-frame) | overlay toggle |
| xa-cine | XA multi-frame 30 frames + frame time | cine |
| turkish-148 / turkish-192 / iso2022 | patient names "ÇAĞLAR^Şükrü İğneada", "ÖZGÜL^Ayşe" in ISO_IR 148, ISO_IR 192, ISO 2022 IR 100\IR 148 | charset decoding |
| dicomdir-set | DICOMDIR + referenced files in CD-style 8.3 folder names | DICOMDIR reading |
| zip-plain / zip-aes / zip-zipcrypto | ZIP archives of a small study (password `test1234`) | ZIP + password |
| sr / pdf | Basic Text SR, Encapsulated PDF | non-image display sets |
| malformed/* | truncated, wrong lengths, bad JPEG/J2K/RLE streams, huge dimensions, zero-byte, random bytes with DICM, zip bomb, path-traversal zip | robustness, fuzz |

### M1 — Core 2D viewer — **done except items marked [~]/[ ]** (verified 2026-10-29 on Windows 11)
Opening/data
- [x] Open files / folders (recursive, multi-select) / drag & drop anywhere; non-DICOM ignored with count
- [x] DICOMDIR reading (case-insensitive file IDs); folder scan fallback
- [x] ZIP incl. password (AES/ZipCrypto) → temp dir cleaned on exit; zip-bomb/path-traversal limits
- [x] Scanning in a worker thread with progress + cancel (cancel verified through the button's IPC call, not the click); first series shown while scanning continues (UNVERIFIED in E2E)
- [x] Recent studies list on start screen
Data support
- [~] Modalities, single/multi-frame, enhanced per-frame geometry — **concatenations not merged** (each part opens as its own multi-frame set)
- [x] Listed transfer syntaxes decode or show a clear error (JPEG extended 12-bit and JPEG-LS near-lossless: decoder present, no fixture)
- [x] Photometric variants; Modality LUT (rescale + LUT sequence); VOI LUT (multiple windows, LINEAR/LINEAR_EXACT/SIGMOID, LUT sequence); signed data
- [~] Presentation LUT shape INVERSE implemented (not asserted in E2E); Pixel Padding flagged in probe but not forced to black / excluded from auto ranges
- [x] DICOM overlays 60xx (incl. per-frame), toggle
Viewer
- [x] Series bar grouped by study (thumbnail, description, modality, count, loading state, warnings)
- [x] Layouts 1×1…5×5, 1+2, 2+1; double-click maximize/restore
- [x] Stack scroll (wheel, drag tool, keys, PgUp/PgDn, Home/End), slider, index overlay
- [x] W/L drag; CT presets; PET % presets; user presets; numeric W/L and min/max entry
- [x] Zoom (fluid, fit, 1:1), pan, rotate 90/180, flip H/V, invert, reset
- [x] Cine with fps, loop/bounce
- [x] Four-corner overlay, orientation markers (correct after rotate/flip), scale bar, hide-patient-data, configurable content
- [x] Tag browser (sequence tree, search, copy value/all, pin, file location)
- [x] Spatial order with InstanceNumber fallback shown in the Info panel (sort selector removed at the user's request, D-038)
- [x] Full screen and distraction-free mode
- [x] Keyboard cheat sheet (`?`/F1), instant tooltips with shortcuts (D-040), mouse-binding legend
- [x] English default + TR/EN toolbar button (D-037); no splash, legal info behind the "i" button (D-036)
- [x] Settings: theme, language, overlay content, cache size, user W/L presets
- **Acceptance:** the criteria pass in E2E (see `docs/VALIDATION_MATRIX.md`), except these items that are implemented but
  **not E2E-verified**: drag & drop from the OS (Playwright cannot create OS file drops; manual QA), actual OS clipboard
  contents (clipboard unavailable in the development environment; the text handed to Electron is verified),
  "first series shown while scanning continues" (timing-dependent), cine frame-rate accuracy (only bounce/loop behaviour is
  checked), Intel macOS (not tested by decision D-035).
- **STOP after M1** → UX review. Round 1 (2026-10-30) feedback implemented: splash removed, flip toggle fixed,
  instant tooltips, sort section removed, English default + language button, Tags tab renamed with an explanation (D-041).

### M2–M8
See `docs/PRODUCT_SPEC.md` §3 and milestone acceptance criteria in the brief; detailed task lists are added when each
milestone starts. M8 (RT module) only after explicit user approval.

## Test strategy
- **Unit (Vitest):** all `dicom-core` math against analytic phantoms (orientation with asymmetric vectors, IPP sort,
  spacing/tilt detection, VOI formulas from PS3.3, charset byte sequences, PN/DA formatting); parser against every fixture;
  IPC schemas; settings migrations; ZIP limits.
- **Fuzz (Vitest, `tests/fuzz`):** malformed corpus + seeded random mutations of valid fixtures through the parser and
  ZIP reader; must never throw/hang (per-case timeout).
- **E2E (Playwright `_electron`, real built app, `chromiumSandbox: true`):** fails on any renderer/main console error, page
  error or CSP violation; asserts WebGL path (no CPU fallback); pixel-level checks on screenshots for orientation; HU probe
  readout; screenshot matrix saved to `artifacts/screenshots/<milestone>/`.
- **Performance:** E2E timing of first image (ct-large) and scroll fps; heap before/after opening/closing 20 series.

## Verification protocol per milestone
Self review → typecheck/lint/license/audit → unit + fuzz → E2E → run built app manually → screenshot inspection →
perf numbers → CI (or state not run) → verifier subagent → docs → report (`docs/REPORT_TEMPLATE.md`).

## Risks (summary; full list in RISK_REGISTER)
Cornerstone GPU path lacks Modality/VOI LUT sequence and pixel padding (own handling needed) · WebGL availability on CI
runners · large-series memory (NATURALIZED cache not counted by Cornerstone cache) · malformed codec streams in WASM
decoders · Turkish text length in UI · CI cannot be run from this machine (no GitHub remote).
