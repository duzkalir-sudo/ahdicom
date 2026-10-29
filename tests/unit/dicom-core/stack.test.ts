import { describe, expect, it } from 'vitest';
import { analyzeStack, parseDicomTime, sortImages, type DisplayImage } from '@clinic/dicom-core';

const AX: [number, number, number, number, number, number] = [1, 0, 0, 0, 1, 0];

function img(
  i: number,
  ipp: [number, number, number] | undefined,
  extra: Partial<DisplayImage> = {},
  iop: DisplayImage['geometry']['imageOrientationPatient'] = AX,
): DisplayImage {
  return {
    fileId: `f${i}`,
    sopInstanceUid: `1.2.${i}`,
    instanceNumber: i,
    fileName: `IM${String(i).padStart(4, '0')}`,
    geometry: { imagePositionPatient: ipp, imageOrientationPatient: ipp ? iop : undefined },
    ...extra,
  };
}

function analyze(images: DisplayImage[]) {
  const s = sortImages(images);
  return { sorted: s.images, ...analyzeStack(s.images, s) };
}

describe('spatial sorting', () => {
  it('sorts by IPP projection on the normal, not by instance number or file name', () => {
    // Instance numbers deliberately reversed relative to z; file names shuffled.
    const images = [img(3, [0, 0, 0]), img(1, [0, 0, 5]), img(2, [0, 0, 2.5])];
    const { sorted, geometry, warnings } = analyze(images);
    expect(sorted.map((x) => x.geometry.imagePositionPatient![2])).toEqual([0, 2.5, 5]);
    expect(geometry.sortedBy).toBe('spatial');
    expect(geometry.sliceSpacing).toBeCloseTo(2.5, 10);
    expect(warnings).toEqual([]);
  });

  it('descending order reverses', () => {
    const s = sortImages([img(1, [0, 0, 0]), img(2, [0, 0, 1])], 'spatial', 'desc');
    expect(s.images.map((x) => x.instanceNumber)).toEqual([2, 1]);
  });

  it('uses the slice normal for oblique stacks (projection, not raw z)', () => {
    // Plane tilted 30° about x: row = +x, column = (0, cos30, sin30), normal = (0, -sin30, cos30)
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    const iop: [number, number, number, number, number, number] = [1, 0, 0, 0, c, s];
    const n = [0, -s, c];
    const at = (d: number): [number, number, number] => [0, n[1]! * d, n[2]! * d];
    const images = [img(1, at(6), {}, iop), img(2, at(0), {}, iop), img(3, at(3), {}, iop)];
    const { sorted, geometry, warnings } = analyze(images);
    expect(sorted.map((x) => x.instanceNumber)).toEqual([2, 3, 1]);
    expect(geometry.sliceSpacing).toBeCloseTo(3, 10);
    expect(geometry.tiltDeg).toBeCloseTo(0, 6);
    expect(warnings).toEqual([]);
  });

  it('falls back to InstanceNumber when geometry is missing and reports it', () => {
    const images = [img(2, undefined), img(1, undefined), img(3, undefined)];
    const { sorted, geometry, warnings } = analyze(images);
    expect(sorted.map((x) => x.instanceNumber)).toEqual([1, 2, 3]);
    expect(geometry.sortFallback).toBe(true);
    expect(warnings.map((w) => w.code)).toEqual(['sortFallbackInstanceNumber']);
  });

  it('reports missing geometry only when some images have it and others do not', () => {
    const images = [img(1, [0, 0, 0]), img(2, undefined), img(3, [0, 0, 2])];
    expect(analyze(images).warnings.map((w) => w.code)).toEqual(['sortFallbackInstanceNumber', 'missingGeometry']);
  });

  it('other sort keys', () => {
    const images = [
      img(1, [0, 0, 0], { fileName: 'b10', acquisitionTime: '101500' }),
      img(2, [0, 0, 1], { fileName: 'b2', acquisitionTime: '101000.5' }),
      img(3, [0, 0, 2], { fileName: 'a1', acquisitionTime: '10:20:00' }),
    ];
    expect(sortImages(images, 'fileName').images.map((x) => x.fileName)).toEqual(['a1', 'b2', 'b10']);
    expect(sortImages(images, 'acquisitionTime').images.map((x) => x.instanceNumber)).toEqual([2, 1, 3]);
    expect(sortImages(images, 'instanceNumber', 'desc').images.map((x) => x.instanceNumber)).toEqual([3, 2, 1]);
  });
});

describe('stack warnings (spacing from IPP, never SliceThickness)', () => {
  it('ignores SliceThickness when computing spacing', () => {
    const images = [0, 3, 6].map((z, i) => {
      const x = img(i + 1, [0, 0, z]);
      x.geometry.sliceThickness = 1; // misleading thickness must not matter
      return x;
    });
    expect(analyze(images).geometry.sliceSpacing).toBe(3);
  });

  it('detects a missing slice (gap) and non-uniform spacing', () => {
    const zs = [0, 2, 4, 8, 10, 12];
    const { warnings, geometry } = analyze(zs.map((z, i) => img(i + 1, [0, 0, z])));
    expect(geometry.sliceSpacing).toBe(2);
    expect(warnings).toContainEqual({ code: 'missingSlices', value: 1 });
    expect(warnings.map((w) => w.code)).toContain('nonUniformSpacing');
  });

  it('detects small irregular spacing without gaps', () => {
    const zs = [0, 2, 4, 6.3, 8.3, 10.3];
    const { warnings } = analyze(zs.map((z, i) => img(i + 1, [0, 0, z])));
    expect(warnings.map((w) => w.code)).toEqual(['nonUniformSpacing']);
  });

  it('tolerates rounding noise below 0.01 mm', () => {
    const zs = [0, 2.5, 5.004, 7.5, 10.001];
    expect(analyze(zs.map((z, i) => img(i + 1, [0, 0, z]))).warnings).toEqual([]);
  });

  it('detects duplicated positions and multiple acquisitions', () => {
    const images = [
      img(1, [0, 0, 0], { acquisitionNumber: 1 }),
      img(2, [0, 0, 1], { acquisitionNumber: 1 }),
      img(3, [0, 0, 0], { acquisitionNumber: 2 }),
      img(4, [0, 0, 1], { acquisitionNumber: 2 }),
    ];
    const codes = analyze(images).warnings.map((w) => w.code);
    expect(codes).toContain('duplicatePositions');
    expect(codes).toContain('multipleAcquisitions');
  });

  it('measures gantry tilt as the angle between normal and slice progression', () => {
    // Axial images, each slice shifted 5 mm in z and tan(15°)·5 mm in y → 15° tilt.
    const t = Math.tan((15 * Math.PI) / 180);
    const images = [0, 1, 2, 3].map((k) => img(k + 1, [0, 5 * k * t, 5 * k]));
    const { geometry, warnings } = analyze(images);
    expect(geometry.tiltDeg).toBeCloseTo(15, 6);
    expect(geometry.sliceSpacing).toBeCloseTo(5, 10);
    expect(warnings).toEqual([{ code: 'gantryTilt', value: 15 }]);
  });

  it('reports mixed orientations', () => {
    const images = [img(1, [0, 0, 0]), img(2, [0, 0, 1], {}, [0, 1, 0, 0, 0, -1])];
    const s = { sortedBy: 'instanceNumber' as const, sortFallback: false };
    expect(analyzeStack(images, s).warnings.map((w) => w.code)).toEqual(['mixedOrientations']);
  });
});

describe('parseDicomTime', () => {
  it('parses TM variants', () => {
    expect(parseDicomTime('101530.25')).toBeCloseTo(10 * 3600 + 15 * 60 + 30.25, 6);
    expect(parseDicomTime('10')).toBe(36000);
    expect(parseDicomTime('10:15:30')).toBe(36930);
    expect(parseDicomTime('25')).toBeUndefined();
    expect(parseDicomTime('abc')).toBeUndefined();
  });
});

describe('pixel ↔ patient mapping with anisotropic pixels (PS3.3 C.7.6.2.1.1)', () => {
  it('uses column spacing along the row direction and row spacing along the column direction', async () => {
    const { pixelToPatient, patientToPixel, parseImageOrientation } = await import('@clinic/dicom-core');
    const o = parseImageOrientation([1, 0, 0, 0, 1, 0])!;
    const ps: [number, number] = [1.0, 0.5]; // rows 1.0 mm apart, columns 0.5 mm apart
    const p = pixelToPatient([10, 20, 30], o, ps, 4, 2); // column 4, row 2
    expect(p).toEqual([12, 22, 30]);
    expect(patientToPixel(p, [10, 20, 30], o, ps)).toEqual([4, 2]);
  });
});

describe('1-bit native pixel data length', () => {
  it('accepts packed multi-frame 1-bit data whose frame size is not a multiple of 8 bits', async () => {
    const { parseInstance } = await import('@clinic/dicom-core');
    const { writePart10, tag, TSUID } = await import('../../../scripts/fixtures/lib/writer.js');
    const rows = 3;
    const cols = 3;
    const frames = 3; // 27 bits -> 4 bytes (not 3 x ceil(9/8) = 6)
    const ds = [
      { tag: tag(0x0008, 0x0016), vr: 'UI' as const, value: '1.2.840.10008.5.1.4.1.1.7' },
      { tag: tag(0x0008, 0x0018), vr: 'UI' as const, value: '1.2.3.4' },
      { tag: tag(0x0020, 0x000d), vr: 'UI' as const, value: '1.2.3.5' },
      { tag: tag(0x0020, 0x000e), vr: 'UI' as const, value: '1.2.3.6' },
      { tag: tag(0x0028, 0x0002), vr: 'US' as const, value: 1 },
      { tag: tag(0x0028, 0x0004), vr: 'CS' as const, value: 'MONOCHROME2' },
      { tag: tag(0x0028, 0x0008), vr: 'IS' as const, value: String(frames) },
      { tag: tag(0x0028, 0x0010), vr: 'US' as const, value: rows },
      { tag: tag(0x0028, 0x0011), vr: 'US' as const, value: cols },
      { tag: tag(0x0028, 0x0100), vr: 'US' as const, value: 1 },
      { tag: tag(0x0028, 0x0101), vr: 'US' as const, value: 1 },
      { tag: tag(0x0028, 0x0102), vr: 'US' as const, value: 0 },
      { tag: tag(0x0028, 0x0103), vr: 'US' as const, value: 0 },
      { tag: tag(0x7fe0, 0x0010), vr: 'OB' as const, value: new Uint8Array(4) },
    ];
    const bytes = writePart10(ds, { transferSyntaxUid: TSUID.explicitLE });
    const r = parseInstance(bytes, { fileId: 'bit1test', fileName: 'x', fileSize: bytes.length });
    expect(r.ok).toBe(true);
  });
});
