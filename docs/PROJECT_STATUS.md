# Project status

_Last updated: 2026-10-30_

## Current milestone
**M2 — Measurements and annotations: in progress.** M1 is done, CI green on Windows + macOS arm64, and UX review round 1 is implemented. The UX commits are pushed together with M2 (one push per milestone, user decision 2026-10-30).

## Where things are
| Area | State |
|---|---|
| M0 foundation | Done. CI green on Windows and macOS arm64. |
| M1 viewer | Done except: concatenation merge, Presentation LUT INVERSE not E2E-asserted, pixel padding not excluded from auto ranges (see PLAN [~]). |
| M2 | In progress (started 2026-10-30): Phase A, measurement math in dicom-core. |
| M3–M8 | Not started. M8 needs explicit approval. |

## How to resume
1. Node 24.22.2 is installed portably at `%LOCALAPPDATA%\Programs\node-v24.22.2-win-x64` (not on PATH). Prepend it to PATH.
2. `npm ci` → `npx install-electron --no` → `npm run fixtures` → `npm run check`.
3. Read `docs/PLAN.md` (checkboxes) and `docs/DECISIONS.md` before changing anything.

## Last verification (2026-10-29, Windows 11)
| Check | Result |
|---|---|
| `npm run check` (typecheck, lint, unit+fuzz, E2E, fixtures, licenses, audit, build) | Pass (158 unit/fuzz, 20 E2E) |
| `npm run dist` (NSIS x64) | Pass; packaged app starts; fuses verified |
| Verifier subagent | 1st pass FAIL (6 blocking gaps, all fixed in b402b58); 2nd pass **PASS** |
| CI matrix (Windows, macOS Apple Silicon) | **Green** (run 40929893039); Intel macOS not tested (D-035) |

## Open questions for the user
- UX review of the M1 screenshot set.

## Failing checks
None known locally.
