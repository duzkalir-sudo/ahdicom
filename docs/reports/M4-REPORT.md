# Hand-over report — M4 Advanced visualization — 2026-11-02

## 1. Summary
M4 adds MPR, 3D volume rendering, DSA and PET window values in SUV (spec §3.6).
- **MPR:** axial, coronal and sagittal reformats, with:
  - an eligibility check with readable refusals, and warnings for missing slices, irregular spacing or gantry tilt;
  - a crosshair that moves planes and turns them oblique, and thick slabs (MIP, MinIP, AvgIP);
  - measurements on reformats, computed from the voxels;
  - slice sync, reference lines and the 3D cursor working between reformats and the original images.
- **3D:** presets, curve shift and opacity, clipping box, a scalpel on a private copy with undo, an orientation cube, and STL export of an iso-surface.
- **DSA (viewing):** mask frame, manual and automatic pixel shift.
- **PET in SUVbw:** window, presets, probe and W/L dialog.

All geometry (volume grid, reformat planes, slab, rotation, clipping planes, polygon fill, STL/mesh, DSA, SUV window) is in `dicom-core` with analytic unit tests.

By the user's decision, fusion and time-intensity curves are deferred (D-057).

**OS actually run on:** Windows 11 x64 (local). **CI:** not run yet; the push waits for approval after test round 2.

## 2. Feature status
| Feature | Status | Evidence |
|---|---|---|
| Volume eligibility, refusals and approximate-geometry warnings | Done | `volume.test.ts`; E2E `m4-mpr` (XA refused, gantry tilt warning) |
| Axial/coronal/sagittal reformats, labels, voxel values | Done | E2E `m4-mpr` (64/512/512 planes, A/P/R/L…, 1000 HU at the sphere centre) |
| Crosshair: move, rotate to oblique, centre | Done | unit (rotation, three-plane intersection); E2E (line drag → sagittal 156; 30° turn) |
| Thick slab MIP / MinIP / AvgIP | Done | unit `slabOffsets`/`slabProject`; E2E MIP 20 mm 0 → 1000 HU |
| Measurements on reformats (session only, none on approximate geometry) | Done | E2E (ROI 1000.0 HU SD 0; 20 mm ± 1 CSS px; plane isolation; "No values") |
| Reformats ↔ original images (sync, 3D cursor) | Done | E2E `m4-mpr` "MPR and 2D together" |
| Volume loading: progress, memory refusal, cancel on close | Partial | progress shown; memory refusal and cancel are implemented but have no test (UNVERIFIED) |
| 3D presets, curves, reset, orientation cube | Done | E2E `m4-3d`; `3d-*` screenshots |
| Clipping box | Done | unit `clipPlanes`; E2E (patient-right half removed) |
| Scalpel with undo (private copy) | Done | unit `rasterizePolygon`; E2E (removed in 3D, still 1000 HU in 2D, undo) |
| STL export | Done | unit (STL round trip, sphere ±1 %, schema); E2E (sphere volume ±10 %, centroid within 1 mm of (−50, −40, 0)) |
| DSA: subtraction, mask frame, manual and automatic shift | Done | unit `dsa.test.ts`; E2E `m4-dsa` (shift +3/−2 found, background 0, vessel −200) |
| PET window, presets, probe, W/L dialog in SUVbw | Done | unit (SUV window); E2E `m4-suv`; M1 user-preset test still green |
| Fusion, time-intensity curves | Deferred (D-057) | — |

## 3. Verification results
| Protocol step | Result | Notes |
|---|---|---|
| Self code review | Done | Found and fixed while testing:<br>• stale crosshair after a resize next to a 3D view (extra render pass);<br>• measurement drawings shown on other planes (plane restriction removed);<br>• DSA frames not displayed (Cornerstone needs the series module; metadata provider);<br>• Alt shortcuts swallowed by the Windows menu bar (moved to Shift / Ctrl);<br>• empty right-panel tab |
| `npm run typecheck` / `npm run lint` | Pass | 0 warnings |
| `npm run license:check` / `npm audit --audit-level=high` | Pass | `@kitware/vtk.js` 36.4.1 (BSD-3, already Cornerstone's renderer) pinned directly |
| `npm run test` | Pass | 252 unit + fuzz |
| `npm run test:e2e` | see full check below | M4 + M1 coverage: 24 passed |
| Built app run manually | User test round 1 (MPR/3D) | User: "gördüğüm kadarıyla şimdilik bir sıkıntı yok"; round 2 (DSA/SUV) pending |
| Screenshot inspection | Done | M4 matrix (MPR + 3D, DSA, PET W/L in SUV: 1280×800 / 1920×1080 × dark/light × tr/en) and feature shots opened |
| Performance / memory | Not measured for volumes | M1 performance test still runs in the suite |
| CI matrix (Windows, macOS) | Not run | waiting for push approval |
| Verifier subagent | Pass 1 **FAIL** → fixed | Blocking fixed:<br>• M1 PET user-preset test broken by the SUV dialog → stored-values default with an SUVbw switch;<br>• SUV window math moved to `dicom-core` with tests;<br>• Part 2 docs and report written;<br>• PET dialog screenshots at 1920×1080.<br>Non-blocking fixed: DSA/STL error messages; scalpel undo as a bitmask; schema check guarded and tested; STL centroid check; "MPR" labels; shorter warning. Remaining non-blocking: see §6 |

## 4. Measured performance
| Metric | Target | Measured | Machine / method |
|---|---|---|---|
| Volume build, 512×512×64 CT phantom | — | ~0.1 s (spike) | Windows 11 laptop, E2E spike |

Not measured: large volumes (500+ slices) in MPR/3D, scalpel time on large volumes, and DSA on long runs.

## 5. Screenshot index
| Path | Description |
|---|---|
| `artifacts/screenshots/M4/mpr-3d-{1280x800,1920x1080}-{dark,light}-{tr,en}.png` | Axial, coronal and sagittal reformats with crosshair, plus a 3D view with its panel |
| `artifacts/screenshots/M4/view-menu-1280x800-*.png` | MPR and 3D menu with slab controls |
| `artifacts/screenshots/M4/dsa-{1280x800,1920x1080}-*.png` | DSA after automatic pixel shift, DSA panel |
| `artifacts/screenshots/M4/pet-wl-suv-{1280x800,1920x1080}-*.png` | W/L dialog in SUVbw |
| `artifacts/screenshots/M4/{mpr-ct-phantom,mpr-oblique,mpr-slab-mip,mpr-measure,mpr-tilt,mpr-with-2d,3d-*,dsa-motion,dsa-shifted,pet-suv}-1280x800-dark-en.png` | Single-feature views |

## 6. Known issues, limitations, risks
- **R-036:** reformats of irregular stacks place slices evenly, so they show a warning and give no values.
- **R-037:** volumes and the scalpel copy use cache memory; very large series are refused.
- **R-038:** overlays could be stale after layout changes other than a resize.
- **R-039:** 3D on CI uses software WebGL.
- **R-040:** MPR measurements are session only.
- **R-041:** these run on the UI thread on large data: the scalpel loop, DSA subtraction, the MPR probe slab sum and the automatic shift.
- **R-042:** PET reformats show the window in Bq/ml (SUV only on original images).
- **Untested paths:** volume-load cancel and the memory refusal have no test. DSA LIN (log) mode is unit-tested only (the fixture is LOG).
- **Viewport overlay:** text over bright image areas has low contrast; crosshair lines can pass through the orientation letters.

## 7. Decisions and questions
- **Decisions:** D-057…D-066.
- **Questions for the user:** test round 2 (DSA, SUV); then approval to push M4 and run the Windows + macOS CI.

## 8. How to run, test, build
```
npm ci
npm run fixtures
npm run check      # all checks
npm run dist       # installer for the current OS
```
