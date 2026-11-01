/**
 * Measurement math against analytic phantoms with known answers (CLAUDE.md rule 9).
 */
import { describe, expect, it } from 'vitest';
import {
  angleDeg,
  bulletVolume,
  cobbAngleDeg,
  ellipseArea,
  ellipseBBox,
  ellipseFromHandles,
  ellipsePerimeter,
  ellipsoidVolume,
  insideEllipse,
  insidePolygon,
  lengthDecimals,
  lengthRatio,
  manualScale,
  pointLineDistance,
  polygonArea,
  polygonBBox,
  polygonPerimeter,
  polylineLength,
  roiStats,
  scaleFromBasis,
  segmentLength,
  ultrasoundScale,
  type MeasureScale,
  type Point2,
  type UltrasoundRegion,
} from '@ahdicom/dicom-core';
import { filesIn, parseFile } from '../helpers/fixtures.js';

const iso: MeasureScale = { basis: 'pixelSpacing', rowMm: 0.5, columnMm: 0.5 };
/** Rows 1.0 mm apart, columns 0.5 mm apart (the `aniso` fixture). */
const aniso: MeasureScale = { basis: 'pixelSpacing', rowMm: 1.0, columnMm: 0.5 };

describe('lengths', () => {
  it('uses column spacing along rows and row spacing along columns', () => {
    expect(segmentLength([0, 0], [100, 0], aniso)).toEqual({ value: 50, unit: 'mm' });
    expect(segmentLength([0, 0], [0, 100], aniso)).toEqual({ value: 100, unit: 'mm' });
    expect(segmentLength([0, 0], [30, 40], iso).value).toBeCloseTo(25, 12);
    // 3-4-5 triangle in mm on anisotropic pixels: 6 columns × 0.5 = 3 mm, 4 rows × 1 = 4 mm.
    expect(segmentLength([10, 10], [16, 14], aniso).value).toBeCloseTo(5, 12);
  });

  it('reports pixels when uncalibrated', () => {
    expect(segmentLength([0, 0], [3, 4])).toEqual({ value: 5, unit: 'px' });
  });

  it('polyline and perimeter', () => {
    const sq: Point2[] = [
      [0, 0],
      [20, 0],
      [20, 20],
      [0, 20],
    ];
    expect(polylineLength(sq, iso).value).toBeCloseTo(30, 12);
    expect(polygonPerimeter(sq, iso).value).toBeCloseTo(40, 12);
    expect(polygonPerimeter(sq, aniso).value).toBeCloseTo(2 * 10 + 2 * 20, 12);
  });

  it('scale from the spacing basis', () => {
    expect(scaleFromBasis({ kind: 'pixelSpacing', rowMm: 1, columnMm: 0.5 })).toEqual({ basis: 'pixelSpacing', rowMm: 1, columnMm: 0.5 });
    expect(scaleFromBasis({ kind: 'imagerMagnified', rowMm: 0.2 / 1.1, columnMm: 0.2 / 1.1, magnification: 1.1 })?.basis).toBe(
      'imagerMagnified',
    );
    expect(scaleFromBasis({ kind: 'ultrasound' })).toBeUndefined();
    expect(scaleFromBasis({ kind: 'none' })).toBeUndefined();
  });

  it('manual calibration keeps the pixel aspect ratio', () => {
    const m = manualScale([0, 0], [100, 0], 50)!;
    expect(m).toEqual({ basis: 'manual', rowMm: 0.5, columnMm: 0.5 });
    expect(segmentLength([0, 0], [0, 40], m).value).toBeCloseTo(20, 12);
    // Anisotropic: a vertical line of 50 rows (50 mm at 1.0 mm) calibrated to 25 mm halves both spacings.
    const a = manualScale([0, 0], [0, 50], 25, aniso)!;
    expect(a.rowMm).toBeCloseTo(0.5, 12);
    expect(a.columnMm).toBeCloseTo(0.25, 12);
    expect(manualScale([0, 0], [0, 0], 10)).toBeUndefined();
    expect(manualScale([0, 0], [1, 0], 0)).toBeUndefined();
    expect(manualScale([0, 0], [1, 0], Number.NaN)).toBeUndefined();
  });

  it('display precision resolves one pixel', () => {
    expect(lengthDecimals(iso)).toBe(1);
    expect(lengthDecimals({ basis: 'pixelSpacing', rowMm: 1, columnMm: 1 })).toBe(1);
    expect(lengthDecimals({ basis: 'pixelSpacing', rowMm: 0.08, columnMm: 0.08 })).toBe(2);
    expect(lengthDecimals({ basis: 'ultrasound', rowMm: 0.2, columnMm: 0.2 })).toBe(1);
    expect(lengthDecimals({ basis: 'pixelSpacing', rowMm: 0.0005, columnMm: 0.0005 })).toBe(3);
    expect(lengthDecimals()).toBe(1);
  });
});

describe('angles and distances', () => {
  it('angle at the vertex, in physical space', () => {
    expect(angleDeg([10, 0], [0, 0], [0, 10], iso)).toBeCloseTo(90, 10);
    expect(angleDeg([10, 0], [0, 0], [-10, 0], iso)).toBeCloseTo(180, 10);
    // 45° in pixel space is atan(10 mm / 5 mm) = 63.435° on anisotropic pixels.
    expect(angleDeg([10, 0], [0, 0], [10, 10], aniso)).toBeCloseTo((Math.atan2(10, 5) * 180) / Math.PI, 10);
    expect(angleDeg([0, 0], [0, 0], [1, 1], iso)).toBeNaN();
  });

  it('Cobb angle is the acute angle between undirected lines', () => {
    const t = (deg: number): Point2 => [100 * Math.cos((deg * Math.PI) / 180), 100 * Math.sin((deg * Math.PI) / 180)];
    // Lines at +20° and −15° to the horizontal → 35°, regardless of drawing direction.
    expect(cobbAngleDeg([0, 0], t(20), [0, 0], t(-15), iso).acute).toBeCloseTo(35, 10);
    expect(cobbAngleDeg(t(20), [0, 0], [0, 0], t(-15), iso).acute).toBeCloseTo(35, 10);
    const r = cobbAngleDeg([0, 0], t(60), [0, 0], t(-60), iso);
    expect(r.acute).toBeCloseTo(60, 10);
    expect(r.obtuse).toBeCloseTo(120, 10);
  });

  it('deviation distance is perpendicular to the reference line', () => {
    expect(pointLineDistance([0, 0], [100, 0], [50, 20], iso)).toEqual({ value: 10, unit: 'mm' });
    // Point beyond the segment end still measures to the infinite line.
    expect(pointLineDistance([0, 0], [10, 0], [200, -30], iso).value).toBeCloseTo(15, 12);
    expect(pointLineDistance([0, 0], [0, 100], [20, 50], aniso).value).toBeCloseTo(10, 12);
    expect(pointLineDistance([5, 5], [5, 5], [8, 9]).value).toBeCloseTo(5, 12);
  });

  it('length ratio uses physical lengths', () => {
    expect(lengthRatio([0, 0], [100, 0], [0, 0], [0, 50], aniso)).toBeCloseTo(1, 12);
    expect(lengthRatio([0, 0], [100, 0], [0, 0], [0, 50])).toBeCloseTo(2, 12);
    expect(lengthRatio([0, 0], [1, 0], [3, 3], [3, 3])).toBeNaN();
  });
});

describe('areas', () => {
  it('shoelace area, either winding', () => {
    const tri: Point2[] = [
      [0, 0],
      [40, 0],
      [0, 30],
    ];
    expect(polygonArea(tri, iso)).toEqual({ value: 150, unit: 'mm²' });
    expect(polygonArea([...tri].reverse(), iso).value).toBe(150);
    expect(polygonArea(tri).unit).toBe('px²');
    // 20 × 20 pixel square on 1.0 × 0.5 mm pixels = 10 mm × 20 mm.
    expect(
      polygonArea(
        [
          [0, 0],
          [20, 0],
          [20, 20],
          [0, 20],
        ],
        aniso,
      ).value,
    ).toBe(200);
  });

  it('ellipse area from Cornerstone handles', () => {
    // Circle of radius 50 px centred at (100, 100).
    const e = ellipseFromHandles([100, 50], [100, 150], [50, 100], [150, 100]);
    expect(e.center).toEqual([100, 100]);
    expect(ellipseArea(e, iso).value).toBeCloseTo(Math.PI * 25 * 25, 9);
    // On anisotropic pixels the same handles are an ellipse with semi-axes 25 mm × 50 mm.
    expect(ellipseArea(e, aniso).value).toBeCloseTo(Math.PI * 25 * 50, 9);
    // A rotated ellipse (conjugate semi-axes) keeps its area.
    expect(ellipseArea({ center: [0, 0], u: [30, 40], v: [-8, 6] }).value).toBeCloseTo(Math.PI * 50 * 10, 9);
  });

  it('point-in-shape tests', () => {
    const e = { center: [10, 10] as Point2, u: [5, 0] as Point2, v: [0, 3] as Point2 };
    expect(insideEllipse(e, 15, 10)).toBe(true);
    expect(insideEllipse(e, 10, 13)).toBe(true);
    expect(insideEllipse(e, 14, 12)).toBe(false);
    expect(insideEllipse({ center: [0, 0], u: [1, 1], v: [2, 2] }, 0, 0)).toBe(false);
    // Concave "C" shape: the notch is outside.
    const c: Point2[] = [
      [0, 0],
      [10, 0],
      [10, 3],
      [3, 3],
      [3, 7],
      [10, 7],
      [10, 10],
      [0, 10],
    ];
    expect(insidePolygon(c, 1, 5)).toBe(true);
    expect(insidePolygon(c, 6, 5)).toBe(false);
    expect(insidePolygon(c, 6, 1)).toBe(true);
    expect(insidePolygon(c, 10, 1)).toBe(true); // on an edge
    expect(insidePolygon(c, 11, 1)).toBe(false);
  });
});

describe('ROI statistics (pixel-centre inclusion)', () => {
  const W = 64;
  const H = 48;
  const ramp = (c: number, r: number): number => c + 100 * r;

  it('rectangle over a ramp: exact count, mean, min, max, SD', () => {
    // Corners at pixel edges (−0.5 offsets) include exactly columns 10..19 and rows 5..9.
    const rect: Point2[] = [
      [9.5, 4.5],
      [19.5, 4.5],
      [19.5, 9.5],
      [9.5, 9.5],
    ];
    const s = roiStats(W, H, polygonBBox(rect), (c, r) => insidePolygon(rect, c, r), ramp)!;
    expect(s.count).toBe(50);
    expect(s.min).toBe(10 + 500);
    expect(s.max).toBe(19 + 900);
    expect(s.mean).toBeCloseTo(14.5 + 700, 10);
    // Independent columns (var 8.25) and rows (var 2 × 100²) add.
    expect(s.sd).toBeCloseTo(Math.sqrt(8.25 + 2 * 100 * 100), 9);
  });

  it('circle: count equals the number of pixel centres within the radius', () => {
    const e = ellipseFromHandles([30, 14], [30, 34], [20, 24], [40, 24]);
    let brute = 0;
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if ((c - 30) ** 2 + (r - 24) ** 2 <= 100) brute++;
    const s = roiStats(
      W,
      H,
      ellipseBBox(e),
      (c, r) => insideEllipse(e, c, r),
      () => 7,
    )!;
    expect(s.count).toBe(brute);
    expect(s).toMatchObject({ mean: 7, min: 7, max: 7, sd: 0 });
  });

  it('clips to the image, skips undefined values, and returns undefined when empty', () => {
    const rect: Point2[] = [
      [-10, -10],
      [2.2, -10],
      [2.2, 1.2],
      [-10, 1.2],
    ];
    const s = roiStats(
      W,
      H,
      polygonBBox(rect),
      (c, r) => insidePolygon(rect, c, r),
      (c, r) => (c === 0 && r === 0 ? undefined : 1),
    )!;
    expect(s.count).toBe(3 * 2 - 1);
    const tiny: Point2[] = [
      [0.2, 0.2],
      [0.8, 0.2],
      [0.8, 0.8],
    ];
    expect(roiStats(W, H, polygonBBox(tiny), (c, r) => insidePolygon(tiny, c, r), ramp)).toBeUndefined();
  });

  it('is numerically stable for large offsets', () => {
    const rect: Point2[] = [
      [-0.5, -0.5],
      [63.5, -0.5],
      [63.5, 47.5],
      [-0.5, 47.5],
    ];
    const s = roiStats(
      W,
      H,
      polygonBBox(rect),
      () => true,
      (c, r) => 1e9 + ((c + r) % 2),
    )!;
    expect(s.count).toBe(W * H);
    expect(s.sd).toBeCloseTo(0.5, 6);
  });
});

describe('volumes from three diameters', () => {
  it('ellipsoid and bullet formulas', () => {
    expect(ellipsoidVolume(10, 10, 10).value).toBeCloseTo((4 / 3) * Math.PI * 125, 9);
    expect(ellipsoidVolume(20, 30, 40).value).toBeCloseTo((Math.PI / 6) * 24000, 9);
    expect(bulletVolume(20, 30, 40).value).toBeCloseTo(((5 * Math.PI) / 24) * 24000, 9);
  });
});

describe('ultrasound calibrated regions', () => {
  const bmode: UltrasoundRegion = {
    minX: 100,
    minY: 50,
    maxX: 540,
    maxY: 430,
    unitsX: 3,
    unitsY: 3,
    deltaX: 0.02,
    deltaY: 0.02,
    spatialFormat: 1,
  };
  const doppler: UltrasoundRegion = { minX: 0, minY: 440, maxX: 639, maxY: 479, unitsX: 4, unitsY: 7, deltaX: 0.01, deltaY: 0.5 };

  it('both points in one spatial region → mm scale from Physical Delta (cm)', () => {
    const r = ultrasoundScale(
      [bmode, doppler],
      [
        [200, 100],
        [300, 100],
      ],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scale.columnMm).toBeCloseTo(0.2, 12);
    expect(r.scale.rowMm).toBeCloseTo(0.2, 12);
    expect(segmentLength([200, 100], [300, 100], r.scale).value).toBeCloseTo(20, 9);
  });

  it('refuses points outside, across regions or in non-spatial regions', () => {
    expect(
      ultrasoundScale(
        [bmode],
        [
          [10, 10],
          [200, 100],
        ],
      ),
    ).toEqual({ ok: false, reason: 'noRegion' });
    expect(
      ultrasoundScale(
        [bmode, doppler],
        [
          [200, 100],
          [200, 460],
        ],
      ),
    ).toEqual({ ok: false, reason: 'differentRegions' });
    expect(
      ultrasoundScale(
        [bmode, doppler],
        [
          [10, 450],
          [20, 460],
        ],
      ),
    ).toEqual({ ok: false, reason: 'notSpatial' });
    expect(ultrasoundScale([bmode], [])).toEqual({ ok: false, reason: 'noRegion' });
  });

  it('region bounds are inclusive pixel indices', () => {
    expect(
      ultrasoundScale(
        [bmode],
        [
          [100, 50],
          [540, 430],
        ],
      ).ok,
    ).toBe(true);
    expect(
      ultrasoundScale(
        [bmode],
        [
          [99, 50],
          [540, 430],
        ],
      ).ok,
    ).toBe(false);
  });
});

describe('us-regions fixture', () => {
  it('parses the calibrated region and measures 0.2 mm per pixel', () => {
    const r = parseFile(filesIn('us-regions')[0]!);
    if (!r.ok) throw new Error(r.error);
    expect(r.instance.ultrasoundRegions).toEqual([
      { minX: 100, minY: 50, maxX: 540, maxY: 430, spatialFormat: 1, dataType: 1, unitsX: 3, unitsY: 3, deltaX: 0.02, deltaY: 0.02 },
    ]);
    const s = ultrasoundScale(r.instance.ultrasoundRegions!, [
      [150, 100],
      [150, 400],
    ]);
    expect(s.ok && segmentLength([150, 100], [150, 400], s.scale).value).toBeCloseTo(60, 9);
  });
});

describe('ellipse perimeter', () => {
  it('circle: exactly 2πr; anisotropic pixels turn it into a true ellipse', () => {
    const e = ellipseFromHandles([100, 50], [100, 150], [50, 100], [150, 100]); // r = 50 px
    expect(ellipsePerimeter(e, iso).value).toBeCloseTo(2 * Math.PI * 25, 9);
    expect(ellipsePerimeter(e).unit).toBe('px');
    // On 0.5 × 1.0 mm pixels the same handles are an ellipse with semi-axes 25 mm and 50 mm.
    // Reference (numerical integration of the arc length): 242.2112 mm.
    expect(ellipsePerimeter(e, aniso).value).toBeCloseTo(242.2112, 3);
  });

  it('rotated conjugate semi-axes give the principal axes; very elongated ellipse stays accurate', () => {
    // u = (30, 40) and v = (-8, 6) are perpendicular: semi-axes 50 and 10. Reference (numerical integration): 210.1004.
    expect(ellipsePerimeter({ center: [0, 0], u: [30, 40], v: [-8, 6] }).value).toBeCloseTo(210.1004, 3);
    // Non-perpendicular conjugate diameters of the same ellipse (x²/50² + y²/10² = 1, θ = 30°) give the same perimeter.
    const t = Math.PI / 6;
    const u: Point2 = [50 * Math.cos(t), 10 * Math.sin(t)];
    const v: Point2 = [-50 * Math.sin(t), 10 * Math.cos(t)];
    expect(ellipsePerimeter({ center: [0, 0], u, v }).value).toBeCloseTo(210.1004, 3);
    expect(ellipsePerimeter({ center: [0, 0], u: [0, 0], v: [0, 0] }).value).toBe(0);
  });
});
