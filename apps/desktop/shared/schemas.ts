/**
 * zod schemas for every IPC payload and for persisted JSON. Main validates all input with these.
 */
import { z } from 'zod';

export const ThemeSchema = z.enum(['dark', 'light', 'system']);
export const LanguageSchema = z.enum(['tr', 'en']);

export const OverlaySettingsSchema = z.object({
  patient: z.boolean(),
  study: z.boolean(),
  series: z.boolean(),
  image: z.boolean(),
  windowLevel: z.boolean(),
  zoom: z.boolean(),
  orientation: z.boolean(),
  scaleBar: z.boolean(),
  probe: z.boolean(),
});

export const UserPresetSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  center: z.number().finite(),
  width: z.number().finite().positive(),
});

export const SETTINGS_VERSION = 1;

export const SettingsSchema = z.object({
  version: z.literal(SETTINGS_VERSION),
  theme: ThemeSchema,
  language: LanguageSchema,
  cacheSizeMB: z.number().int().min(256).max(32768),
  hidePatientData: z.boolean(),
  overlay: OverlaySettingsSchema,
  userPresets: z.array(UserPresetSchema).max(50),
  cineFps: z.number().min(1).max(120),
  cineMode: z.enum(['loop', 'bounce']),
  showMouseLegend: z.boolean(),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  theme: 'dark',
  language: 'en',
  cacheSizeMB: 2048,
  hidePatientData: false,
  overlay: {
    patient: true,
    study: true,
    series: true,
    image: true,
    windowLevel: true,
    zoom: true,
    orientation: true,
    scaleBar: true,
    probe: true,
  },
  userPresets: [],
  cineFps: 15,
  cineMode: 'loop',
  showMouseLegend: true,
};

export const SettingsPatchSchema = SettingsSchema.omit({ version: true })
  .extend({ overlay: OverlaySettingsSchema.partial() })
  .partial()
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export const OpenKindSchema = z.enum(['files', 'folder', 'dicomdir', 'zip']);
export type OpenKind = z.infer<typeof OpenKindSchema>;

export const FileIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const ScanIdSchema = z.string().regex(/^[A-Za-z0-9_-]{4,64}$/);

export const OpenPathsSchema = z.object({
  paths: z.array(z.string().min(1).max(4096)).min(1).max(1000),
});

export const FileReadSchema = z.object({ fileId: FileIdSchema });
export const FileOverlaysSchema = z.object({ fileId: FileIdSchema, frame: z.number().int().min(1).max(100000) });
export const ZipPasswordSchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/),
  password: z.string().max(1024).nullable(),
});
export const RecentIdSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/) });
export const FullscreenSchema = z.object({ on: z.union([z.boolean(), z.literal('toggle')]) });
export const ClipboardWriteSchema = z.object({ text: z.string().max(4 * 1024 * 1024) });

/** DICOM UID: digits and dots, at most 64 characters (PS3.5 9.1). */
export const UidSchema = z.string().regex(/^[0-9.]{1,64}$/);

export const MEASUREMENT_TOOLS = [
  'length',
  'angle',
  'cobb',
  'deviation',
  'ratio',
  'ellipse',
  'rectangle',
  'polygon',
  'polyline',
  'freehand',
  'arrow',
  'text',
] as const;

const Finite = z.number().finite().min(-1e6).max(1e6);

/** One saved measurement: image (SOP Instance UID + frame) and points in image pixel coordinates [column, row]. */
export const MeasurementItemSchema = z.object({
  id: z.string().min(1).max(64),
  tool: z.enum(MEASUREMENT_TOOLS),
  sopInstanceUid: UidSchema,
  frame: z.number().int().min(1).max(100000).optional(),
  points: z.array(z.tuple([Finite, Finite])).min(1).max(5000),
  closed: z.boolean().optional(),
  /** Arrow / text annotation text. */
  label: z.string().max(200).optional(),
  /** User-given name shown in the list and next to the value. */
  name: z.string().max(100).optional(),
});
export type MeasurementItem = z.infer<typeof MeasurementItemSchema>;

export const CalibrationSchema = z.object({
  rowMm: z.number().finite().positive().max(1000),
  columnMm: z.number().finite().positive().max(1000),
});

export const MEASUREMENTS_VERSION = 1;

/** Measurements of one study, saved as JSON in the app data folder (never in the DICOM files). */
export const MeasurementFileSchema = z.object({
  version: z.literal(MEASUREMENTS_VERSION),
  studyInstanceUid: UidSchema,
  calibrations: z.record(UidSchema, CalibrationSchema).refine((r) => Object.keys(r).length <= 1000, 'too many calibrations'),
  items: z.array(MeasurementItemSchema).max(5000),
});
export type MeasurementFile = z.infer<typeof MeasurementFileSchema>;

export const RecentEntrySchema = z.object({
  id: z.string(),
  openedAt: z.string(),
  kind: OpenKindSchema.or(z.literal('drop')),
  roots: z.array(z.string()).max(1000),
  patientName: z.string().optional(),
  patientId: z.string().optional(),
  studyDescription: z.string().optional(),
  studyDate: z.string().optional(),
  modalities: z.array(z.string()),
  instanceCount: z.number().int(),
});
export type RecentEntry = z.infer<typeof RecentEntrySchema>;
/** What the renderer receives: no file-system paths. */
export type RecentEntryPublic = Omit<RecentEntry, 'roots'>;
export const RecentFileSchema = z.object({ version: z.literal(1), entries: z.array(RecentEntrySchema).max(50) });
