/**
 * Normalized metadata model shared by main process, renderer and tests.
 * All values are plain JSON so they can cross the IPC boundary.
 */

/** Geometry of one frame (single-frame image or one frame of a multi-frame image). */
export interface FrameGeometry {
  imagePositionPatient?: [number, number, number];
  imageOrientationPatient?: [number, number, number, number, number, number];
  /** [row spacing, column spacing] in mm, from Pixel Measures / Pixel Spacing. */
  pixelSpacing?: [number, number];
  sliceThickness?: number;
  rescaleSlope?: number;
  rescaleIntercept?: number;
  windowCenter?: number[];
  windowWidth?: number[];
  /** Temporal / stack identifiers useful for splitting and sorting. */
  temporalPositionIndex?: number;
  stackId?: string;
  inStackPositionNumber?: number;
}

/** One DICOM instance (file) as indexed by the scanner. */
export interface InstanceRecord {
  /** Opaque id assigned by the main process; maps to a file path only inside main. */
  fileId: string;
  /** Base file name (no directory), used only for "sort by file name". */
  fileName: string;
  fileSize: number;
  transferSyntaxUid: string;
  sopClassUid: string;
  sopInstanceUid: string;
  studyInstanceUid: string;
  seriesInstanceUid: string;
  frameOfReferenceUid?: string;

  patientName?: string;
  patientId?: string;
  patientBirthDate?: string;
  patientSex?: string;
  patientAge?: string;
  patientWeight?: number;
  studyDate?: string;
  studyTime?: string;
  studyDescription?: string;
  accessionNumber?: string;
  studyId?: string;
  institutionName?: string;
  referringPhysicianName?: string;

  modality?: string;
  seriesNumber?: number;
  seriesDescription?: string;
  seriesDate?: string;
  seriesTime?: string;
  bodyPartExamined?: string;
  protocolName?: string;
  manufacturer?: string;
  manufacturerModelName?: string;
  stationName?: string;

  instanceNumber?: number;
  acquisitionNumber?: number;
  acquisitionTime?: string;
  contentTime?: string;
  acquisitionDateTime?: string;
  imageType?: string[];
  echoNumbers?: number;
  echoTime?: number;
  repetitionTime?: number;
  magneticFieldStrength?: number;
  diffusionBValue?: number;
  kvp?: number;
  xRayTubeCurrent?: number;
  exposureTime?: number;
  convolutionKernel?: string;
  gantryDetectorTilt?: number;
  frameTime?: number;
  recommendedDisplayFrameRate?: number;
  cineRate?: number;

  /** Pixel description; undefined for non-image instances (SR, PDF, …). */
  rows?: number;
  columns?: number;
  numberOfFrames: number;
  bitsAllocated?: number;
  bitsStored?: number;
  highBit?: number;
  pixelRepresentation?: number;
  samplesPerPixel?: number;
  photometricInterpretation?: string;
  planarConfiguration?: number;
  hasPixelData: boolean;

  /** Shared (instance-level) geometry and value transforms. */
  geometry: FrameGeometry;
  /** Per-frame geometry for enhanced multi-frame instances (length == numberOfFrames) when present. */
  perFrame?: FrameGeometry[];

  imagerPixelSpacing?: [number, number];
  estimatedRadiographicMagnificationFactor?: number;
  pixelSpacingCalibrationType?: string;
  patientOrientation?: [string, string];
  rescaleType?: string;
  /** PET Units (0054,1001), e.g. BQML, CNTS, GML. */
  petUnits?: string;
  voiLutFunction?: string;
  windowExplanation?: string[];
  presentationLutShape?: string;
  pixelPaddingValue?: number;
  hasModalityLutSequence?: boolean;
  hasVoiLutSequence?: boolean;
  /** Overlay groups present (0x6000, 0x6002, …) */
  overlayGroups?: number[];
  hasUltrasoundRegions?: boolean;
  /** Sequence of Ultrasound Regions (0018,6011), at most 16 items. */
  ultrasoundRegions?: UltrasoundRegion[];
  /** First item of the Radiopharmaceutical Information Sequence (0054,0016). */
  radiopharmaceutical?: Radiopharmaceutical;
  /** PET Decay Correction (0054,1102): NONE, START or ADMIN. */
  decayCorrection?: string;
  /** Corrected Image (0028,0051), e.g. ['ATTN', 'DECY']. */
  correctedImage?: string[];
  acquisitionDate?: string;

  /** Specific Character Set as stored, and whether any decoded text was uncertain. */
  specificCharacterSet?: string;
  charsetUncertain: boolean;
}

/** One item of the Sequence of Ultrasound Regions (PS3.3 C.8.5.5.1). Bounds are inclusive pixel indices. */
export interface UltrasoundRegion {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  spatialFormat?: number;
  dataType?: number;
  /** Physical Units X/Y Direction (0018,6024/6026): 3 = cm, 4 = seconds, 5 = hertz, … */
  unitsX: number;
  unitsY: number;
  /** Physical Delta X/Y (0018,602C/602E): physical units per pixel. */
  deltaX: number;
  deltaY: number;
}

/** Radiopharmaceutical Information Sequence item fields used for SUV (PS3.3 C.8.9.2). */
export interface Radiopharmaceutical {
  startTime?: string;
  startDateTime?: string;
  /** Radionuclide Total Dose in Bq. */
  totalDose?: number;
  /** Radionuclide Half Life in seconds. */
  halfLife?: number;
}

export type WarningCode =
  | 'nonUniformSpacing'
  | 'missingSlices'
  | 'duplicatePositions'
  | 'mixedOrientations'
  | 'gantryTilt'
  | 'multipleAcquisitions'
  | 'sortFallbackInstanceNumber'
  | 'missingGeometry'
  | 'charsetUncertain'
  | 'nonImage'
  | 'mixedDimensions';

export interface StackWarning {
  code: WarningCode;
  /** Optional numeric detail (e.g. tilt in degrees, number of gaps). */
  value?: number;
}

export type SortKey = 'spatial' | 'instanceNumber' | 'acquisitionTime' | 'fileName';
export type SortDirection = 'asc' | 'desc';

/** One displayable image: a single-frame instance or one frame of a multi-frame instance. */
export interface DisplayImage {
  fileId: string;
  /** 1-based frame number for multi-frame instances; undefined for single-frame. */
  frame?: number;
  sopInstanceUid: string;
  instanceNumber?: number;
  geometry: FrameGeometry;
  fileName: string;
  acquisitionTime?: string;
  acquisitionNumber?: number;
}

export interface StackGeometrySummary {
  /** How the images are ordered. */
  sortedBy: SortKey;
  /** True when spatial sort was requested but geometry was missing and InstanceNumber was used. */
  sortFallback: boolean;
  /** Median spacing between adjacent slice positions along the normal (mm), from IPP. */
  sliceSpacing?: number;
  /** Signed distances between consecutive images along the normal (mm). */
  spacings: number[];
  /** Angle between the slice normal and the direction of slice progression (degrees). */
  tiltDeg?: number;
  /** Slice normal (row × column). */
  normal?: [number, number, number];
}

export interface DisplaySet {
  id: string;
  studyInstanceUid: string;
  seriesInstanceUid: string;
  /** Index of this display set within its series (0 when the series is not split). */
  splitIndex: number;
  modality?: string;
  seriesNumber?: number;
  seriesDescription?: string;
  kind: 'stack' | 'multiframe' | 'single' | 'nonImage';
  images: DisplayImage[];
  /** Instance-level record of the first image (for overlay/corner text and pixel description). */
  firstInstance: InstanceRecord;
  geometry: StackGeometrySummary;
  warnings: StackWarning[];
  /** Set when a multi-volume series was split: the attribute and value that select this volume. */
  splitBy?: { key: VolumeSplitKey; value: number };
}

/** Attributes that separate the volumes of a multi-volume series (multi-phase, DWI, multi-echo, repeats). */
export type VolumeSplitKey = 'temporal' | 'bValue' | 'echo' | 'acquisition';

export interface SeriesNode {
  seriesInstanceUid: string;
  modality?: string;
  seriesNumber?: number;
  seriesDescription?: string;
  instanceCount: number;
  displaySets: DisplaySet[];
}

export interface StudyNode {
  studyInstanceUid: string;
  patientKey: string;
  patientName?: string;
  patientId?: string;
  patientBirthDate?: string;
  patientSex?: string;
  studyDate?: string;
  studyTime?: string;
  studyDescription?: string;
  accessionNumber?: string;
  modalities: string[];
  series: SeriesNode[];
}
