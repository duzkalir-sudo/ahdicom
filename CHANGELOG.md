# Changelog

All notable changes. Format: Keep a Changelog; versions follow SemVer (pre-1.0).

## [Unreleased]

### Added (M2 — measurements)
- Measurement tools: length, angle, Cobb angle, deviation (point to line), length ratio, ellipse / rectangle / polygon ROI,
  open polyline, freehand, arrow with text, text, manual calibration.
- Values computed by `dicom-core` with the spacing basis shown next to them (patient plane, magnification corrected,
  detector, US region, calibrated); uncalibrated images show px with a warning.
- ROI statistics in HU (CT), SUVbw or Bq/ml (PET, with the missing tags named when SUV is refused), raw otherwise.
- Measurements tab: list with value, series and image; rename, delete, jump to the image; ellipsoid / bullet volume from three
  ticked diameters; manual calibrations with remove.
- Undo / redo (Ctrl+Z / Ctrl+Y); Esc cancels a measurement being drawn; Delete removes the selected one.
- Measurements and calibrations are saved per study in the app data folder and restored when the study is opened again.
- Each image is measured with its own calibration (multi-image US/DX series); unreadable measurement files are set aside, failed saves are reported.

### Changed (UX review round 1, 2026-10-30)
- No splash screen; the "i" button opens About with the intended-use statement and legal information.
- English is the default language; TR/EN button in the toolbar.
- Tooltips appear immediately on hover for every icon, including disabled ones.
- Sort selector removed from the Info panel (images are always in spatial order).
- Tags tab renamed "DICOM Bilgileri" / "DICOM Data" with a short explanation.

### Removed
- Distraction-free mode (toolbar button and F10); full screen (F11) remains.

### Fixed
- Freehand ROI and open polyline now show their values on the image (reported by the user); a tool chosen right after a click on the image no longer receives that click, even when the app is busy.
- Dialogs focus their input field (typing works at once), Esc closes them, disabled buttons look disabled; the calibration box explains an invalid number (reported by the user).
- Flip horizontal/vertical worked only once (Cornerstone `setViewPresentation` cannot un-flip).

### Changed
- Product name AHDicom (was the working name "Clinic DICOM Viewer"); appId `org.ahdicom.viewer`.
- CI on GitHub (Windows, macOS Apple Silicon); Intel macOS is built but no longer tested (D-035).
- macOS fixes from CI: full-screen toggle during the macOS animation; "No GPU" warning for CPU-fallback rendering.
- Performance targets enforced locally, recorded in CI (D-033).

## [0.1.0] — 2026-10-29 — M0 foundation + M1 core 2D viewer (unreleased, not for primary diagnosis)

### Added
- Monorepo (npm workspaces): `apps/desktop` (Electron 45 + electron-vite + React 19), `packages/dicom-core` (pure TS clinical math).
- Hardened Electron shell: `app://` scheme, CSP, sandbox, context isolation, blocked navigation/popups/permissions/network,
  zod-validated IPC with sender checks, Electron fuses, single instance, temp-folder cleanup.
- `dicom-core`: header parser with input limits, Specific Character Set decoding (ISO_IR 100/148/192, ISO 2022 escapes),
  IPP-based sorting and spacing/gap/tilt analysis, study/series/display-set model, orientation labels from camera and
  PatientOrientation, PS3.3 VOI functions, Modality/VOI LUT sequences, pixel-spacing basis, tag tree, overlays, DICOMDIR,
  deflate rewrite, RLE header validation.
- Viewer: folder/file/DICOMDIR/ZIP (AES, ZipCrypto) opening with progress and drag & drop; series bar with thumbnails;
  layouts 1×1–5×5, 1+2, 2+1; scroll, W/L, presets (CT, PET %, user), numeric W/L; zoom/pan/fit/1:1, rotate/flip/invert/reset;
  cine; four-corner overlay, orientation markers, scale bar, value probe in modality units; DICOM overlays; tag browser;
  Info panel with geometry warnings and sorting; settings; keyboard shortcuts with cheat sheet; Turkish and English UI;
  dark and light themes; intended-use statement in splash, About and status bar.
- Synthetic fixture generator (≈ 50 sets incl. compressed transfer syntaxes, charsets, DICOMDIR, encrypted ZIPs, malformed corpus).
- Tests: 158 unit/fuzz tests, 20 Playwright `_electron` E2E tests with screenshot matrix and performance measurement.
- electron-builder config (NSIS x64, DMG per arch, unsigned, no publish), CI workflow, license gate over shipped bundles.

### Fixed during verification
- Cornerstone 5.14 truncates the VOI LUT Function string ("SIGMOID" → "S") and crashes rendering: value restored in the loader.
- Cornerstone's naturalized reader cannot parse Deflated Explicit VR LE: datasets are inflated before ingestion.
- Corrupt JPEG 2000 / RLE streams produced empty or blank images instead of errors: decoded-buffer and RLE-header checks.
- Toolbar overflow at 1280 px, cropped thumbnails, stale VOI LUT state between series, overlapping edge labels.
- Verifier findings: 1:1 and zoom % now in device pixels (HiDPI); Modality LUT re-applied after cache eviction;
  bounded main-thread reads for tags/overlays; Pan/Zoom/Scroll left-button tools no longer leave W/L bound;
  PET Units label; hide-patient-data masks identifying tags; clipboard via validated IPC; decode failures no longer
  produce unhandled rejections; stricter E2E error guard; English plurals; local dates in the recent list.
