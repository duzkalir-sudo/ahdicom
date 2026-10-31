# Project status

_Last updated: 2026-10-30_

## Current milestone
**M2 — Measurements and annotations: done locally (Windows 11).** Waiting for the user's approval to push (one push per milestone, 2026-10-30) and for the Windows + macOS CI run. Report: `docs/reports/M2-REPORT.md`.

## Where things are
| Area | State |
|---|---|
| M0 foundation | Done. CI green on Windows and macOS arm64. |
| M1 viewer | Done except: concatenation merge, Presentation LUT INVERSE not E2E-asserted, pixel padding not excluded from auto ranges (see PLAN [~]). |
| M2 | Done locally: all tools, list, undo/redo, persistence. Open: explicit basis choice (R-027). CI not run yet. |
| M3–M8 | Not started. M8 needs explicit approval. |

## How to resume
1. Node 24.22.2 is installed portably at `%LOCALAPPDATA%\Programs\node-v24.22.2-win-x64` (not on PATH). Prepend it to PATH.
2. `npm ci` → `npx install-electron --no` → `npm run fixtures` → `npm run check`.
3. Read `docs/PLAN.md` (checkboxes) and `docs/DECISIONS.md` before changing anything.

## Last verification (2026-10-30, Windows 11, M2)
| Check | Result |
|---|---|
| `npm run check` (b120324) | Pass (194 unit/fuzz, 35 E2E, licenses, audit high, build); first image 0.29 s |
| Verifier subagent (M2) | Passes 1–4 FAIL → all blocking gaps fixed (D-049, D-050); pass 5 PASS |

Previous (2026-10-29, M1):

| Check | Result |
|---|---|
| `npm run check` (typecheck, lint, unit+fuzz, E2E, fixtures, licenses, audit, build) | Pass (158 unit/fuzz, 20 E2E) |
| `npm run dist` (NSIS x64) | Pass; packaged app starts; fuses verified |
| Verifier subagent | 1st pass FAIL (6 blocking gaps, all fixed in b402b58); 2nd pass **PASS** |
| CI matrix (Windows, macOS Apple Silicon) | **Green** (run 40929893039); Intel macOS not tested (D-035) |

## Open questions for the user
- Approval to push M2 and run CI.
- Explicit spacing-basis choice needed? (R-027)

## Failing checks
None known locally.
