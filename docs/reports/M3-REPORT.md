# Hand-over report — M3 Comparing series — 2026-11-01

## 1. Summary
M3 adds series comparison (spec §3.5): automatic slice sync between series in the same Frame of Reference (planes
within 5°), a manual link that keeps the slice offset (for earlier studies or other Frames of Reference), window/level
(same modality) and zoom/pan sync, reference lines of the active slice, a 3D cursor, splitting of multi-volume series
(multi-phase CT, DWI b-values, multi-echo, repeated acquisitions) with a "show together" toggle, and "Compare with
prior". All geometry is computed by `dicom-core` and unit-tested against analytic planes (D-054).
Not done by decision: separate program windows (D-055). Not offered: first/last-slice reference lines (R-033).
**OS actually run on:** Windows 11 x64 (local). **CI:** not run yet for M3 — the push waits for the user's approval.

## 2. Feature status
| Feature | Status | Evidence |
|---|---|---|
| Plane model, nearest slice with outside detection, auto-sync rule, offset link, reference line, 3D cursor maths | Done | `tests/unit/dicom-core/compare.test.ts` (analytic planes) |
| Automatic slice sync (same FoR, ≤ 5°), both directions, no loops | Done | E2E `m3-compare` (4 mm ↔ 2 mm) |
| Manual link with offset; prior study not synced until linked | Done | E2E (index 12 → 17) |
| Reference lines (toggle), only within one FoR | Done | E2E (column 63.5; none across FoR) |
| 3D cursor tool (X), only within one FoR | Done | E2E (axial click → sagittal index 14, marker 40 / 83.5) |
| W/L sync (same modality only), zoom/pan sync | Done | E2E (W/L and zoom follow; CT preset does not change MR) |
| Multi-volume split (real volumes only), labels, show together/separately | Done | unit + E2E (DWI b=0/1000, 3 phases; bolus/cine stay one stack) |
| Compare with prior (same patient, earlier date): best match side by side, fitted, linked | Done | E2E, screenshots |
| Images refitted on layout change (not on maximize) | Done | E2E gating (maximize keeps on-screen zoom) |
| Separate program windows | Not needed (D-055) | — |

## 3. Verification results
| Protocol step | Result | Notes |
|---|---|---|
| Self code review | Done | Screenshot review found and fixed: no refit on layout change, redundant "Part n" label, wrapped link |
| `npm run typecheck` / `npm run lint` | Pass | 0 warnings |
| `npm run license:check` / `npm audit --audit-level=high` | Pass | no new dependencies |
| `npm run test` | Pass | 220 unit + fuzz |
| `npm run test:e2e` | Pass | 46 tests (8 M3); one M2 flake seen once under load before the mount-refit fix (R-030 family) |
| Built app run manually | UNVERIFIED | via Playwright on the built app only |
| Screenshot inspection | Done | 19 M3 screenshots opened (1280×800 / 1920×1080 × dark/light × tr/en) |
| Performance / memory | Pass | first image 0.26 s, 120 fps (display), heap back to 71 MB, cache 0 MB |
| CI matrix (Windows, macOS) | Windows pass; macOS 45/46 | Run 41329587847: the reference-line test read the line mid-scroll on the slower macOS runner (test race); the test now waits for the final position. Rerun pending push approval. |
| Verifier subagent | Pass 1 **FAIL** → fixed (D-056); pass 2 **PASS** | Pass 2's recommendation fixed as well: a series dropped into a linked layout re-anchors all viewports; the engine now records a series change only once the new series is ready (it was lost while loading, so new series were not aligned either). Remaining non-blocking: prior-study name match is exact (fails safe); single-slice dynamics keep the duplicate-position warning; no test asserts the refit on layout change (screenshots show it). |

## 4. Measured performance
| Metric | Target | Measured | Machine / method |
|---|---|---|---|
| First image of a 520-slice CT | ≤ 1.5 s | 0.26 s | Windows 11 laptop, E2E perf test |
| Scroll rate | ≥ 30 fps | 119.6 fps | same |
| Heap after closing 20 series | no growth | 575 → 71 MB, cache 0 MB | same |

## 5. Screenshot index
| Path | Description |
|---|---|
| `artifacts/screenshots/M3/sync-{1280x800,1920x1080}-{dark,light}-{tr,en}.png` | Axial + sagittal: reference line, 3D cursor markers, split DWI in the series bar, "Compare with prior" button |
| `artifacts/screenshots/M3/sync-menu-1280x800-*.png` | Synchronization menu |
| `artifacts/screenshots/M3/compare-prior-1280x800-*.png` | Current and prior study side by side, linked |
| `artifacts/screenshots/M3/{linked-prior,reference-line,cursor3d}-1280x800-dark-en.png` | Single-feature views |

## 6. Known issues, limitations, risks
- R-031 3D cursor jumps even when the point is laterally outside the target image.
- R-032 Zoom/pan sync is relative, not physical scale.
- R-033 No first/last-slice reference lines.
- R-034 Slice location on sagittal stacks reads "−12.00 (R)" for 12 mm left (correct, easy to misread) — UX question.
- R-035 Prior study matched by Patient ID (+ name), issuer not checked.
- R-030 Intermittent E2E failures under full-suite load (one cause fixed in M2, one likely cause removed in M3).

## 7. Decisions and questions
- Decisions: D-054, D-055, D-056.
- Questions for the user: approval to push M3 and run the Windows + macOS CI; should slice locations be shown as
  patient coordinates with their own letter (R-034)?

## 8. How to run, test, build
```
npm ci
npm run fixtures
npm run dev        # development
npm run check      # all checks
npm run test:e2e
npm run dist       # installer for the current OS
```
