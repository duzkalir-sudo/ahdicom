# Hand-over report — M2 Measurements and annotations — 2026-10-30

## 1. Summary
M2 adds every measurement and annotation tool of the spec (§3.4): length, angle, Cobb, deviation, length ratio,
ellipse / rectangle / polygon ROI, open polyline, freehand, arrow with text, text and manual calibration, plus the
measurement list (rename, delete, jump, ellipsoid / bullet volume), undo / redo and per-study persistence.
Cornerstone draws the handles; every number shown comes from `dicom-core`, unit-tested against analytic phantoms (D-043).
Also in this milestone: UX review round 1 (D-036…D-042), including the removal of distraction-free mode.
Not done: DICOM SR/GSPS export (later milestone). An explicit spacing-basis choice is not needed (user decision D-051).
**OS actually run on:** Windows 11 x64 (local). **CI:** not run yet for M2 — the push waits for the user's approval
(one push per milestone).

## 2. Feature status
| Feature | Status | Evidence |
|---|---|---|
| Measurement math (lengths per basis, angles, areas, ROI stats, volumes, US regions, SUVbw, precision) | Done | `tests/unit/dicom-core/measure.test.ts`, `suv.test.ts` |
| Tools in the toolbar (3 direct buttons + menu), shortcuts M/E/N/T, Delete, Esc | Done | E2E `m2-measure` (CT phantom, arrow/Esc/Delete) |
| Values with basis label; px + warning when uncalibrated / outside US region | Done | E2E aniso, cr-mag, us-regions |
| Each image measured with its own calibration (multi-image US series) | Done (verifier fix, D-049) | E2E "each image of a series…", fixture `us-multi` |
| ROI stats HU / SUVbw / Bq/ml; SUV refusal names missing tags | Done | E2E PET test (5.19 SUVbw; PatientWeight, RadionuclideTotalDose) |
| Manual calibration (decimal comma accepted), Info panel row, list with remove | Done | E2E calibration tests |
| Measurement list: rename, delete, jump, volume from three diameters | Done | E2E persistence test, `artifacts/screenshots/M2/measure-list-1280x800-dark-en.png` |
| Undo / redo (Ctrl+Z / Ctrl+Y) | Done | E2E persistence test |
| Saved per study, restored after restart; kept when the series leaves the viewport or the study is only partly open | Done | E2E restart, series-switch and partial-study tests; fuzz `measurements.fuzz.test.ts` |
| Basis selection by the user (spec §3.4) | Not needed (user decision D-051) | Basis shown next to values and in the Info panel |

## 3. Verification results
| Protocol step | Result | Notes |
|---|---|---|
| Self code review | Done | Phantom-click and CSP issues found and fixed (D-044, D-045) |
| `npm run typecheck` | Pass | |
| `npm run lint` | Pass | 0 warnings |
| `npm run license:check` | Pass | |
| `npm audit --audit-level=high` | Pass | 6 moderate advisories via Cornerstone → vtk.js → fflate/uuid (no high) |
| `npm run test` | Pass | 194 unit + fuzz (final run on b120324) |
| `npm run test:e2e` | Pass | 35 tests (12 M2); one flaky failure seen once under load, not reproduced in 27 runs (R-030) |
| Built app run manually | UNVERIFIED | Only through Playwright on the built app; the user tests the installer |
| Screenshot inspection | Done | All 22 M2 screenshots opened; no clipping/overflow; text-box background raised to 75 % opacity |
| Performance / memory | Pass | `PERF {"firstImageMs":465,"fps":60.3,"heapAfterMB":63,"cacheAfterCloseMB":0}` |
| CI matrix (Windows, macOS) | Not run | Waiting for push approval |
| Verifier subagent | Passes 1–4 **FAIL** → fixed; pass 5 **PASS** | Pass 1: per-image calibration; calibration dropped on partial-study save; pinned API list (updated with the user's approval). Pass 2 confirmed those fixed and found a save-during-restore race and an over-broad set-aside on read errors; pass 3 found the race still open when several studies load at once (undo during a load, studies waiting their turn). Replaced by a write gate: a study is written only after its saved file was read and restored; undo/redo disabled during loads. Pass 4 confirmed the gate and found a close-all window (late scan batch) — closed with a close gate (D-050). Pass 5: PASS (code review + unit/type checks). The race fix has no dedicated test (timing-dependent); verified by code review and the persistence E2E tests. |

Existing test changed (user-approved 2026-10-30): `tests/e2e/m0-shell.spec.ts` pinned preload API list +`loadMeasurements`,
+`saveMeasurements`; nothing else in the test changed.

## 4. Measured performance
| Metric | Target | Measured | Machine / method |
|---|---|---|---|
| First image of a 520-slice CT | ≤ 1.5 s | 0.47 s | Windows 11 laptop, E2E perf test |
| Scroll rate | ≥ 30 fps | 60.3 fps | same |
| Heap after closing 20 series | no growth | 570 → 63 MB, cache 0 MB | same |

## 5. Screenshot index
| Path | Description |
|---|---|
| `artifacts/screenshots/M2/measure-{1280x800,1920x1080}-{dark,light}-{tr,en}.png` | Length (renamed), ellipse ROI in HU, angle, arrow with text; measurement list |
| `artifacts/screenshots/M2/measure-menu-1280x800-*.png` | Measurement tool menu |
| `artifacts/screenshots/M2/text-prompt-1280x800-*.png` | Annotation text dialog |
| `artifacts/screenshots/M2/pet-refusal-1280x800-*.png` | PET ROI without SUV tags (refusal line) |
| `artifacts/screenshots/M2/measure-list-1280x800-dark-en.png` | List with volume from three diameters |

## 6. Known issues, limitations, risks
- R-024: Cornerstone holds a viewport click 400 ms; very fast click sequences can drop a click; a tool chosen within that time activates after it.
- R-025: SVG text style routed through CSSOM (D-044) — caught by the E2E console check if Cornerstone changes.
- R-026: ROI stats of images released from memory are shown from the last computation.
- R-028: padding exclusion compares rescaled values.
- R-029: set-aside measurement files are not cleaned up; R-030: one flaky E2E observation.
- Remaining non-blocking verifier notes (pass 5): if "close all" fails half-way, edits to the still-open studies are not saved until the studies are reopened (the saved file is not touched); a scan batch delivered after close could re-register files (pre-existing, unverified); a write that fails during close is not retried after it. Measurement text boxes can cover image areas (75 % backing; placement is Cornerstone's).

## 7. Decisions and questions
- Decisions: D-041…D-051.
- Questions for the user: approval to push M2 to GitHub and run the Windows + macOS CI (after the user has tried the installer).

## 8. How to run, test, build
```
npm ci
npm run fixtures
npm run dev        # development
npm run check      # all checks
npm run test:e2e
npm run dist       # installer for the current OS
```
