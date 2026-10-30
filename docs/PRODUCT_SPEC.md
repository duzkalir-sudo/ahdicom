# Product Specification — AHDicom (working name)

Status: living document. Source: initial project brief (sections 1–6). Roadmap and milestones: `docs/PLAN.md`.
Binding engineering rules: `CLAUDE.md`.

---

## 1. Product context and intended use

**Users.** Neurosurgeons, radiation oncology / medical physics staff and researchers of a neurosurgery and
Gamma Knife radiosurgery clinic.

**Typical data.** Brain MR (T1/T2/FLAIR/contrast-enhanced, thin-slice volumetric), CT (head, spine, CT angiography),
PET-CT, DSA/XA angiography, plain radiographs, occasional ultrasound. Patient names frequently contain Turkish
characters (Ç, Ğ, İ, ı, Ö, Ş, Ü).

**Platforms.** Windows 10/11 x64 and macOS 13+ on Apple Silicon. An Intel (x64) macOS installer is provided but not
tested (no Intel Macs in the clinic; D-035). Mostly offline clinical workstations.

**Intended use statement** (About dialog behind the "i" button, together with the legal information, in full;
compact badge in the status bar). No splash screen (user decision, D-036):

> For image review, measurement and research. Not for primary diagnosis.
> Görüntü inceleme, ölçüm ve araştırma amaçlıdır. Tanısal amaçlı değildir.

**Reference product.** RadiAnt DICOM Viewer (Windows-only). We aim for its functional breadth, speed and simplicity
with an original, clean, modern design. Its name, icons, texts, artwork and screenshots are never copied.

---

## 2. Architecture

### 2.1 Processes
| Process | Responsibilities |
|---|---|
| Main | Windows, menus, file-system access, ZIP extraction, folder scanning, SQLite archive, export jobs |
| Utility process(es) | DIMSE networking (a stuck association can never freeze the app); heavy scanning/parsing jobs |
| Preload | One typed, allow-listed API (`window.api.*`). No raw `ipcRenderer`, no Node APIs exposed |
| Renderer | React UI, Cornerstone3D rendering engine, tool groups, viewports. Pixel decoding in web workers via the Cornerstone DICOM image loader (WASM codecs) |

### 2.2 Packages
`packages/dicom-core` — pure TypeScript, fully unit-tested, no Electron/DOM imports:
metadata normalization, study/series/instance model, series splitting and sorting, geometry (IOP/IPP, slice spacing,
orientation labels, reference-line math, plane intersection), measurement math, calibration logic, SUVbw, TIC,
DSA math, anonymization profile, character-set decoding helpers.
The renderer consumes `dicom-core`; **no clinical math lives inside React components**.

### 2.3 Data model
Patient → Study (StudyInstanceUID) → Series (SeriesInstanceUID, possibly split into several display sets) →
Instance / Frame. A **display set** is one coherent stack/volume.

### 2.4 Image access, settings, persistence
- Local files reach the image loader only through a custom, read-only, allow-listed protocol (or file-manager image
  IDs). The renderer never receives arbitrary file-system access.
- Settings: JSON in the OS user-data folder, schema-validated, versioned with migrations.
- User annotations: saved per StudyInstanceUID as JSON in the app data folder. Original DICOM files are never
  modified. Later option: export as DICOM SR / GSPS.

---

## 3. Feature specification (RadiAnt parity matrix)

Priority: **P0** required for first clinical-research use · **P1** required for parity · **P2** optional/extra.
**M** = milestone (see `docs/PLAN.md`).

### 3.1 Opening and data sources
| Feature | Pri | M |
|---|---|---|
| Open single/multiple files, folders (recursive, multi-select), drag & drop anywhere | P0 | 1 |
| Read DICOMDIR (CD/DVD/USB); scan folders without DICOMDIR; ignore non-DICOM files gracefully | P0 | 1 |
| Open ZIP archives incl. password-protected (ZipCrypto/AES); extract to a temp folder, cleaned on exit | P1 | 1 |
| Asynchronous loading: first image visible while the rest of the series streams in; progress indicator | P0 | 1 |
| Recent studies list on the start screen | P1 | 1 |
| Command-line arguments (open path, layout, full screen) and custom URL protocol `appname://` (validated, local actions only) | P2 | 7 |

### 3.2 Supported data
| Feature | Pri | M |
|---|---|---|
| Modalities CR, DX, MG, CT, MR, PT, NM, US, XA, RF, SC, ES, OT; single- and multi-frame; enhanced MR/CT (per-frame functional groups); concatenations | P0 | 1 |
| Transfer syntaxes: implicit/explicit VR LE, explicit BE, deflated, RLE, JPEG baseline/extended, JPEG lossless (process 14, SV1), JPEG-LS, JPEG 2000, HTJ2K | P0 | 1 |
| Photometric: MONOCHROME1/2, RGB, YBR_FULL, YBR_FULL_422, PALETTE COLOR, planar configuration 0/1 | P0 | 1 |
| Modality LUT (rescale and LUT sequence), VOI LUT (multiple windows, LINEAR / LINEAR_EXACT / SIGMOID, LUT sequence), Presentation LUT shape, pixel padding, signed data | P0 | 1 |
| DICOM overlays (60xx, incl. per-frame), toggle on/off | P1 | 1 |
| Structured Reports rendered as a readable document; encapsulated PDF opened in the system viewer | P1 | 6 |
| Encapsulated MPEG-2/MPEG-4/H.264 video: play in-app when Chromium supports the codec, otherwise offer export | P1 | 6 |

### 3.3 2D viewer basics
| Feature | Pri | M |
|---|---|---|
| Series thumbnail bar grouped by study (thumbnail, description, modality, image count, loading state) | P0 | 1 |
| Viewport layouts 1×1 up to 5×5 plus presets (1+2, 2+1); double-click maximize/restore | P0 | 1 |
| Stack scroll (wheel, drag, keyboard, Page Up/Down, Home/End), slice slider and index overlay | P0 | 1 |
| Window/level by drag; CT presets (brain, subdural, stroke, bone, lung, abdomen, mediastinum, angio); PET presets as % of range and SUV; user presets; numeric W/L or min/max entry | P0 | 1 |
| Zoom (fluid, fit, 1:1 pixel), pan, rotate 90°/180°, flip H/V, invert, reset | P0 | 1 |
| Cine for dynamic series with adjustable fps, loop/bounce | P0 | 1 |
| Image filters: sharpen, smooth, edge (display-only, clearly indicated) | P2 | 6 |
| Four-corner overlay (patient, study, series, image info, W/L, zoom), orientation markers, scale bar, "hide patient data" toggle, configurable overlay content | P0 | 1 |
| DICOM tag browser: tree incl. sequences, search, copy value/all, pin/highlight tags, show file location | P0 | 1 |
| Series sorting: spatial position by default (InstanceNumber fallback shown). The sort-key/direction selector was removed from the Info panel at the user's request (D-038); sorting logic remains in `dicom-core` | P1 | 1 |
| Split multi-volume series (multi-phase CT, DWI b-values, multi-echo) into display sets; merge series into one panel | P1 | 3 |
| Copy active viewport or all visible viewports to clipboard as one image | P1 | 6 |
| Full screen (distraction-free mode removed by user decision, D-042) | P1 | 1 |

### 3.4 Measurements and ROI (2D and MPR)
| Feature | Pri | M |
|---|---|---|
| Length; manual calibration; basis selection (Pixel Spacing vs Imager Pixel Spacing with magnification factor, labelled); US calibrated regions; uncalibrated images show "px" with a warning | P0 | 2 |
| Angle; Cobb angle; deviation distance; length ratio | P0/P1 | 2 |
| Ellipse/circle and rectangle ROI: area, mean, min, max, SD (HU for CT, SUVbw for PET, raw otherwise) | P0 | 2 |
| Closed polygon (area, perimeter, stats); open polygon (length); freehand pencil | P1 | 2 |
| Ellipsoid/bullet volume from three orthogonal diameters | P1 | 2 |
| Arrow and text annotations | P0 | 2 |
| Measurement list panel (select, rename, delete, jump to slice), undo/redo, Esc cancels unfinished measurement, saved per study | P0 | 2 |
| Pixel probe (value at cursor in modality units) | P1 | 2 |

### 3.5 Comparing series
| Feature | Pri | M |
|---|---|---|
| Multiple series in one window and multiple windows | P0 | 3 |
| Automatic slice sync for series in the same Frame of Reference and near-parallel planes (≤ 5° default) | P0 | 3 |
| Manual sync across studies (slice offset, zoom/pan, W/L), sync-mode toolbar toggle | P1 | 3 |
| Reference (scout/cross-reference) lines between non-parallel series | P0 | 3 |
| 3D cursor: click a point, all linked viewports jump to it | P0 | 3 |
| Prior/current comparison workflow | P1 | 3 |

### 3.6 Advanced visualization
| Feature | Pri | M |
|---|---|---|
| Orthogonal 2D MPR with warnings for non-uniform spacing, gaps, gantry tilt | P0 | 4 |
| Oblique 3D MPR with crosshairs, slab thickness with MIP / MinIP / AvgIP | P0 | 4 |
| Measurements in MPR views | P1 | 4 |
| 3D volume rendering: presets, opacity/color transfer editing, rotate/zoom/pan, clipping box, scalpel with undo | P1 | 4 |
| 3D snapshots, rotation movie export | P2 | 6 |
| STL export of an iso-surface | P2 | 4 |
| Fusion of two series (PET-CT, SPECT-CT, MR-MR): colormaps, opacity, registration by FoR / patient coordinates | P1 | 4 |
| SUVbw (ROIs, probe, window values), validated against hand-computed references and vendor edge cases | P1 | 4 |
| Time-intensity curves (ROI-based, CSV export) | P2 | 4 |
| DSA mode for XA: mask selection, auto and manual pixel shift | P1 | 4 |
| Synchronizing the MPR crosshair point with 2D viewers | P1 | 4 |

### 3.7 Local archive and PACS
| Feature | Pri | M |
|---|---|---|
| Local archive (SQLite index + managed store): import from files/folders/DICOMDIR/ZIP/PACS, de-duplicate by SOPInstanceUID, keywords, multi-keyword search, delete, CSV export, multiple archive locations | P1 | 5 |
| PACS node configuration (AE title, host, port, optional TLS, charset, timeout) and C-ECHO | P0 | 5 |
| C-FIND study/series with filters (name, ID, birth date, date ranges, modality, accession, description), Turkish-safe queries | P0 | 5 |
| C-MOVE and C-GET retrieve with queue, progress, cancel, retry | P0 | 5 |
| Storage SCP: OFF by default, IP/AE allow-list, pause when OS session is locked | P1 | 5 |
| C-STORE send image/series/study/patient; restrict proposed transfer syntaxes for legacy nodes | P1 | 5 |

### 3.8 Export and output
| Feature | Pri | M |
|---|---|---|
| Export images to PNG/JPEG/BMP (with/without annotations, original or displayed resolution) | P0 | 6 |
| Export cine/stack to MP4 (WebCodecs + permissive muxer; no GPL FFmpeg without approval) | P1 | 6 |
| Export DICOM in original format; folder naming includes patient ID and date | P0 | 6 |
| Anonymized DICOM export per PS3.15 Annex E Basic Profile (consistent UID remapping, burned-in-annotation warning for US/SC/XA) | P0 | 6 |
| Print to system printer (2D, MPR, VR) | P2 | 6 |

### 3.9 Interface and system
| Feature | Pri | M |
|---|---|---|
| English (default) and Turkish UI with a TR/EN button in the toolbar; every string through i18n | P0 | 0 |
| Customizable keyboard shortcuts and mouse bindings per tool | P1 | 7 |
| Settings: theme, language, overlay content, presets, cache size, archive locations, PACS nodes, export defaults | P0 | 1–7 |
| Touch/trackpad gestures | P2 | 7 |
| Optional RT module (RTSTRUCT contours, RTDOSE isodose lines, read-only) — **requires user approval** | P2 | 8 |

---

## 4. UX and visual design

- **Goal:** simple and calm, never crude; a well-made professional tool.
- **Layout:** top toolbar grouped (Open · Layout · Navigate · Measure · Sync · MPR/3D/Fusion · Export · Settings);
  left collapsible series bar grouped by study; central viewport grid; right collapsible panel with tabs
  (Measurements, DICOM Tags, Info); bottom status bar (loading progress, memory/cache use, intended-use badge).
- **Start screen:** large drop zone; buttons Open files, Open folder, Open DICOMDIR/CD, Open ZIP, Local archive, PACS;
  recent studies list.
- **Default mouse bindings** (configurable): wheel = scroll slices; left drag = active tool (default W/L);
  right drag = zoom; middle drag = pan; Ctrl/Cmd + wheel = zoom; right click without drag = context menu.
  Bindings shown in a small legend and in tooltips.
- **Keyboard:** sensible defaults, cheat-sheet overlay (`?` or F1), every toolbar tooltip shows its shortcut;
  Cmd on macOS, Ctrl on Windows.
- **Visual system:** dark theme default, light theme available; one accent color, neutral greys, 4/8 px grid,
  consistent icon size/stroke, system font stack, tabular numerals. UI chrome contrast ≥ WCAG AA.
  Viewport background pure black; active viewport clearly outlined.
- **States:** designed empty, loading, partial-load, error and "unsupported data" states with helpful text.
- **Tooltips:** every icon shows its name (and shortcut) immediately on hover, also when disabled.
- **Localization:** Turkish strings are 30–40 % longer; no clipping. Dates follow locale (DD.MM.YYYY in Turkish).
  Patient names render Ç, Ğ, İ, ı, Ö, Ş, Ü correctly.
- **HiDPI:** crisp at Retina and 150–200 % Windows scaling. Minimum window 1280×800.
- **Feedback:** long operations show progress and are cancellable; destructive actions ask for confirmation.

---

## 5. DICOM and clinical-correctness requirements

1. **Slice ordering** by projection of ImagePositionPatient onto the slice normal (from ImageOrientationPatient);
   fall back to InstanceNumber only when geometry is missing, and show that fallback in the Info panel.
2. **Slice spacing** from IPP differences, never from SliceThickness. Detect and warn: non-uniform spacing, missing
   slices, duplicated positions, mixed orientations, gantry tilt, multiple acquisitions in one series.
3. **Orientation labels** from IOP (cross-sectional) or PatientOrientation (projection images); correct after
   rotate/flip. Verified with an asymmetric orientation phantom so any L/R or A/P inversion fails a test.
4. **Pixel-spacing basis:** Pixel Spacing; Imager Pixel Spacing with Estimated Radiographic Magnification Factor when
   present; US Sequence of Ultrasound Regions; manual calibration. Always show which basis a length uses.
5. **Values:** CT in HU after rescale; PET in Bq/ml and SUVbw (decay-corrected using radiopharmaceutical start time,
   total dose, half-life, patient weight, Units, Decay Correction, Corrected Image). Refuse SUV with a clear message
   when required tags are missing; never silently guess.
6. **Specific Character Set:** at minimum ISO_IR 100, ISO_IR 148 (Turkish), ISO_IR 192 (UTF-8), ISO 2022 IR 6
   combinations; fall back with a visible indicator when decoding is uncertain.
7. **MPR/VR** use the true voxel geometry; never stretch silently. Interpolated/resampled views are labelled as
   reconstructions.
8. **Measurements** report units, precision appropriate to spacing, and the slice/series they belong to.

---

## 6. Performance, robustness, security

Targets (measured on the development machine; actual numbers are reported, never asserted):
- First image of a local 512×512 CT series (≥ 500 slices) visible ≤ 1.5 s after selection.
- Smooth stack scrolling (target ≥ 30 fps) at 512×512; W/L dragging without visible lag.
- Configurable decoded-image cache with LRU eviction and a memory indicator; no unbounded growth when opening and
  closing 20 series in a row (heap measured before/after).
- Malformed input never crashes or hangs the app: truncated files, wrong lengths, bad JPEG/J2K streams, huge
  dimensions, zip bombs. A fuzz/malformed corpus lives in `tests/fuzz` and runs in CI. (RadiAnt shipped security
  fixes for malformed JPEG pixel data and for its update check: both areas are high risk.)
- Electron security checklist per `CLAUDE.md` rule 4. No auto-update channel unless the user asks.
