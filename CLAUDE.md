# CLAUDE.md — AHDicom (product name chosen by the user on 2026-10-29; see docs/DECISIONS.md D-001)

## Mission
A cross-platform desktop DICOM viewer for a neurosurgery / Gamma Knife clinic. Functional scope is modeled on
RadiAnt DICOM Viewer (full spec: `docs/PRODUCT_SPEC.md`, roadmap: `docs/PLAN.md`).
Targets: Windows 10/11 x64 and macOS 13+ (Apple Silicon and Intel).
Intended use: image review, measurement and research. It is NOT a certified medical device: About dialog,
splash screen and status bar must always state "Not for primary diagnosis / Tanısal amaçlı değildir".

## Stack (changing any item requires a `docs/DECISIONS.md` entry and user approval)
- Electron (current stable) + electron-builder (NSIS for Windows, DMG for macOS arm64 + x64)
- Vite + React + TypeScript (`strict: true`, no `any` without a justifying comment)
- Rendering/tools: `@cornerstonejs/core`, `@cornerstonejs/tools`, `@cornerstonejs/dicom-image-loader` (exact versions pinned)
- DICOM read/write: `dcmjs`; networking (DIMSE): `dcmjs-dimse` running in the main/utility process, never the renderer.
  Its README says it is work-in-progress and not for clinical use: in M5, benchmark it against `dicom-dimse-native`
  (DCMTK-based, prebuilt binaries) with the Orthanc test suite and record the choice in `docs/DECISIONS.md`.
- Local archive: SQLite (`better-sqlite3`) in the main process
- State: Zustand; icons: `lucide-react`; i18n: `i18next` (Turkish default, English second)
- Tests: Vitest (unit/integration), Playwright `_electron` API (E2E + screenshots)

## Repo layout
- `apps/desktop/main` Electron main + utility processes (file system, DB, DIMSE, export)
- `apps/desktop/preload` the ONLY bridge; typed, minimal, allow-listed API
- `apps/desktop/renderer` React UI + Cornerstone viewports
- `packages/dicom-core` pure TS: indexing, sorting, geometry, measurement math, SUV, anonymization (no Electron imports)
- `scripts/fixtures` synthetic DICOM generator; `tests/fixtures` generated output (git-ignored if large)
- `tests/unit`, `tests/e2e`, `tests/fuzz`; `docs/`; `artifacts/` (screenshots, reports; git-ignored)

## Commands (must exist and must pass before you report anything as done)
- `npm run typecheck` · `npm run lint` · `npm run test` · `npm run test:e2e` · `npm run fixtures`
- `npm run license:check` (fails on non-allow-listed licenses) · `npm audit --audit-level=high`
- `npm run build` · `npm run dist` (installer for the current OS)
- `npm run check` = all of the above except `dist`, in that order

## Hard rules
1. Never add real patient data to the repo, tests, logs, screenshots or reports. Fixtures are synthetic (`npm run fixtures`).
2. Never modify, delete, skip or weaken existing tests, snapshots or thresholds to make them pass unless the user
   explicitly asks. If you believe a test is wrong, stop and explain why in the report.
3. Never claim a result you have not observed. Every "done" item needs evidence (command + outcome, screenshot path).
   Anything not verified is labelled `UNVERIFIED` with the reason.
4. Electron security: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict CSP
   (`script-src 'self'`; allow `'wasm-unsafe-eval'` only if codecs require it, documented in DECISIONS.md),
   no remote content, navigation and `window.open` blocked, every IPC payload validated (zod), sender checked.
5. Every DICOM/ZIP/DICOMDIR is untrusted input. Decode off the UI thread, enforce size/frame/dimension limits,
   and turn malformed input into a readable error message, never a crash or hang. Fuzz tests must stay green.
6. Privacy: no telemetry, no update checks, no network traffic except user-configured PACS nodes.
   No PHI (name, ID, birth date, accession) in logs or crash reports. DICOM listener is OFF by default.
7. Runtime dependency licenses allowed: MIT, BSD-2/3, Apache-2.0, ISC, 0BSD, Zlib, BlueOak. Anything else
   (GPL, LGPL, AGPL, MPL, unknown) needs explicit user approval. Test-only infrastructure (e.g. Orthanc in CI) is exempt
   but must not be bundled.
8. Do not copy RadiAnt's name, icons, artwork, texts or screenshots. Functional parity only, original design.
9. Clinical geometry first: orientation, spacing, W/L, measurement and SUV code must be unit-tested against
   analytic phantoms with known answers before any UI depends on it.
10. Keep commits small and scoped; conventional commit messages; one milestone per branch/PR when possible.

## Definition of Done (every task and every milestone)
- `npm run check` passes locally with zero failures and zero new warnings.
- E2E flows for the touched features run against the real Electron app (not only unit level).
- Playwright collects renderer console messages; any `error` during E2E fails the run.
- UI changes: screenshots saved to `artifacts/screenshots/<milestone>/` at 1280×800 and 1920×1080, dark and light
  theme, Turkish and English. You MUST open and inspect every screenshot yourself and fix clipping, overlap,
  misalignment, low contrast, text overflow (Turkish strings are longer), broken icons, empty/loading/error states.
  Inspect them by opening each PNG with the Read tool; never describe a screenshot you have not opened.
- IMPORTANT: before any hand-over, run the `verifier` subagent (`.claude/agents/verifier.md`) on the milestone diff.
  It works in a fresh context against `docs/PLAN.md` and this file. Fix correctness/requirement gaps it reports;
  list the remaining (non-blocking) findings in the report.
- `docs/PROJECT_STATUS.md`, `docs/PLAN.md` (checkboxes), `docs/DECISIONS.md`, `docs/RISK_REGISTER.md`,
  `docs/VALIDATION_MATRIX.md` (feature → test → evidence), `CHANGELOG.md` updated.
- Final message follows `docs/REPORT_TEMPLATE.md`.

## Cross-platform truth
You can execute only on the current OS. Windows and macOS behaviour is proven by the CI matrix
(`.github/workflows/ci.yml`: `windows-latest` and `macos-latest`, unit + E2E + `dist`). Never state that something
works on an OS without a green CI run on that OS; say which OS you actually ran on.

## Claude Code workflow
- Large or ambiguous work: explore and plan first (plan mode), then implement. Keep `docs/PLAN.md` as the
  source of truth so a new session can resume from it.
- Use subagents for broad documentation/codebase research so the main context stays focused on implementation.
- Between milestones the user may run `/clear`; always re-read `docs/PLAN.md` and `docs/PROJECT_STATUS.md` first.
- When compacting, preserve: current milestone, modified-file list, failing checks, open decisions, test commands.

## Stop and ask the user when
- a decision is irreversible, changes scope, or changes the stack;
- a needed dependency is not on the license allow-list;
- a test looks wrong;
- real patient data, signing certificates or credentials would be required.
