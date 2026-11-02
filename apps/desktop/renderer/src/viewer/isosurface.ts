/**
 * Iso-surface extraction (marching cubes, vtk.js) in voxel index space: a vertex (i, j, k) is a continuous voxel
 * index, mapped to patient coordinates by the caller with dicom-core's volume geometry. Runs in the STL worker.
 */
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
// No type declarations ship for this filter; its API is used through the minimal interface below.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import vtkImageMarchingCubes from '@kitware/vtk.js/Filters/General/ImageMarchingCubes';

interface MarchingCubes {
  setInputData(d: unknown): void;
  setContourValue(v: number): void;
  setComputeNormals(on: boolean): void;
  setMergePoints(on: boolean): void;
  getOutputData(): {
    getPoints(): { getData(): Float32Array | Float64Array };
    getPolys(): { getData(): Uint32Array | Int32Array };
  };
}

export interface IsoSurface {
  /** Vertex positions as voxel index triples (i, j, k). */
  positions: Float32Array;
  /** Triangles as vertex index triples. */
  triangles: Uint32Array;
}

/** Surface where the scalar field crosses `threshold` (values above it are inside). */
export function isoSurface(scalars: ArrayLike<number>, dims: readonly [number, number, number], threshold: number): IsoSurface {
  const image = vtkImageData.newInstance();
  image.setDimensions([dims[0], dims[1], dims[2]]);
  image.setSpacing([1, 1, 1]);
  image.setOrigin([0, 0, 0]);
  const values = scalars instanceof Float32Array ? scalars : Float32Array.from(scalars);
  image.getPointData().setScalars(vtkDataArray.newInstance({ numberOfComponents: 1, values }));
  const mc = (vtkImageMarchingCubes as { newInstance(o: Record<string, unknown>): MarchingCubes }).newInstance({
    contourValue: threshold,
    computeNormals: false,
    mergePoints: true,
  });
  mc.setInputData(image);
  const out = mc.getOutputData();
  const positions = Float32Array.from(out.getPoints().getData());
  // Cell array: [3, a, b, c, 3, a, b, c, …]
  const cells = out.getPolys().getData();
  const triangles = new Uint32Array((cells.length / 4) * 3);
  for (let c = 0, t = 0; c + 3 < cells.length; c += 4, t += 3) {
    triangles[t] = cells[c + 1]!;
    triangles[t + 1] = cells[c + 2]!;
    triangles[t + 2] = cells[c + 3]!;
  }
  return { positions, triangles };
}
