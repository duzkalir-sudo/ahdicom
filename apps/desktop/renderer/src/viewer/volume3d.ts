/**
 * 3D volume rendering controls of one 3D viewport: rendering presets, transfer-function shift and opacity, the
 * clipping box and the scalpel. Works on the vtk.js volume actor that Cornerstone creates; the clipping planes and
 * the outline rasterization come from dicom-core. The scalpel cuts a private copy of the volume, so reformats and the
 * original images are never changed.
 */
import vtkPlane from '@kitware/vtk.js/Common/DataModel/Plane';
import { cache, volumeLoader, type Types } from '@cornerstonejs/core';
import type { StlRequest, StlResponse } from './stl.worker';
import {
  type ClipBox,
  type Vec3,
  type VolumeGeometry,
  clipPlanes,
  directionToLabel,
  rasterizePolygon,
  vec3,
  voxelToPatient,
} from '@ahdicom/dicom-core';

/** Scalpel: remove what lies inside or outside the drawn outline, through the whole depth of the volume. */
export type CutMode = 'inside' | 'outside';

/** Undo steps kept for the scalpel. */
const MAX_CUTS = 10;

/** Largest STL export (triangles); MAX_STL_BYTES in the IPC schema matches. */
export const MAX_STL_TRIANGLES = 10_000_000;

export type StlResult = { ok: true; triangles: number; saved: boolean } | { ok: false; reason: 'empty' | 'tooLarge' | 'failed' };

/** Rendering presets offered per modality; the transfer functions are Cornerstone's built-in presets. */
export type VrPreset = 'bone' | 'softTissue' | 'vessels' | 'lung' | 'mip' | 'mrDefault' | 'mrAngio' | 'mrMip';

const CS_PRESET: Record<VrPreset, string> = {
  bone: 'CT-Bone',
  softTissue: 'CT-Soft-Tissue',
  vessels: 'CT-AAA',
  lung: 'CT-Lung',
  mip: 'CT-MIP',
  mrDefault: 'MR-Default',
  mrAngio: 'MR-Angio',
  mrMip: 'MR-MIP',
};

export function presetsFor(modality: string | undefined): VrPreset[] {
  return modality === 'CT' ? ['bone', 'softTissue', 'vessels', 'lung', 'mip'] : ['mrDefault', 'mrAngio', 'mrMip'];
}

export interface VrState {
  preset: VrPreset;
  /** Transfer functions moved along the value axis (HU for CT). */
  shift: number;
  /** Opacity scale of the preset's opacity curve (1 = as defined). */
  opacity: number;
  clip?: ClipBox;
  /** Patient direction at the low and high end of each volume grid axis (for the clipping-box sliders). */
  axes: [string, string][];
  /** Scalpel armed: the next outline drawn on the view cuts. */
  scalpel?: CutMode;
  /** Cuts that can be undone. */
  cuts: number;
}

type Scalars = Types.PixelDataTypedArray;

interface ColorFn {
  getSize(): number;
  getNodeValue(i: number, out: number[]): number;
  removeAllPoints(): void;
  addRGBPointLong(x: number, r: number, g: number, b: number, midpoint: number, sharpness: number): number;
}

interface OpacityFn {
  getSize(): number;
  getNodeValue(i: number, out: number[]): number;
  removeAllPoints(): void;
  addPointLong(x: number, y: number, midpoint: number, sharpness: number): number;
}

interface VolumeActor {
  getProperty(): { getRGBTransferFunction(i: number): ColorFn; getScalarOpacity(i: number): OpacityFn };
  getMapper(): {
    addClippingPlane(p: unknown): void;
    removeAllClippingPlanes(): void;
    setBlendModeToMaximumIntensity(): void;
    setBlendModeToComposite(): void;
  };
}

function nodes(fn: { getSize(): number; getNodeValue(i: number, out: number[]): number }, width: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < fn.getSize(); i++) {
    const v = new Array<number>(width).fill(0);
    fn.getNodeValue(i, v);
    out.push(v);
  }
  return out;
}

export class VolumeRendering {
  state: VrState;
  private base?: { color: number[][]; opacity: number[][] };
  /** The cut copy shown instead of the source volume once the scalpel was used; `fill` is the value of cut voxels. */
  private copy?: { volumeId: string; fill: number };
  private undoStack: { indices: Uint32Array; values: Float64Array }[] = [];

  constructor(
    private readonly viewport: () => Types.IVolumeViewport,
    private readonly sourceVolumeId: string,
    private readonly geometry: VolumeGeometry,
    private readonly modality: string | undefined,
  ) {
    this.state = { preset: presetsFor(modality)[0]!, shift: 0, opacity: 1, axes: this.axes(), cuts: 0 };
  }

  private axes(): [string, string][] {
    const g = this.geometry;
    return [g.row, g.column, g.normal].map((d) => [directionToLabel(vec3.negate(d)), directionToLabel(d)]);
  }

  private actor(): VolumeActor | undefined {
    return this.viewport().getActors()[0]?.actor as unknown as VolumeActor | undefined;
  }

  /** Applies a rendering preset and keeps the current shift, opacity and clipping box. */
  setPreset(preset: VrPreset): void {
    const vp = this.viewport();
    vp.setProperties({ preset: CS_PRESET[preset] });
    const actor = this.actor();
    if (!actor) return;
    const prop = actor.getProperty();
    this.base = { color: nodes(prop.getRGBTransferFunction(0), 6), opacity: nodes(prop.getScalarOpacity(0), 4) };
    const mapper = actor.getMapper();
    if (preset === 'mip' || preset === 'mrMip') mapper.setBlendModeToMaximumIntensity();
    else mapper.setBlendModeToComposite();
    this.state = { ...this.state, preset };
    this.applyCurves();
    vp.render();
  }

  set(patch: Partial<Pick<VrState, 'shift' | 'opacity'>>): void {
    this.state = { ...this.state, ...patch };
    this.applyCurves();
    this.viewport().render();
  }

  private applyCurves(): void {
    const actor = this.actor();
    if (!actor || !this.base) return;
    const prop = actor.getProperty();
    const color = prop.getRGBTransferFunction(0);
    const opacity = prop.getScalarOpacity(0);
    const { shift, opacity: scale } = this.state;
    color.removeAllPoints();
    for (const [x, r, g, b, mid, sharp] of this.base.color) color.addRGBPointLong(x! + shift, r!, g!, b!, mid!, sharp!);
    opacity.removeAllPoints();
    for (const [x, y, mid, sharp] of this.base.opacity) opacity.addPointLong(x! + shift, Math.min(1, y! * scale), mid!, sharp!);
  }

  /** Clips the rendering to a box of the volume grid (undefined removes the box). */
  setClip(box: ClipBox | undefined): void {
    const actor = this.actor();
    if (!actor) return;
    const mapper = actor.getMapper();
    mapper.removeAllClippingPlanes();
    if (box) {
      for (const p of clipPlanes(this.geometry, box)) {
        mapper.addClippingPlane(vtkPlane.newInstance({ origin: [...p.point], normal: [...p.normal] }));
      }
    }
    this.state = { ...this.state, clip: box };
    this.viewport().render();
  }

  /** Default preset, no shift, preset opacity, no clipping box, no cuts. */
  async reset(): Promise<void> {
    await this.restoreUncut();
    this.state = { preset: presetsFor(this.modality)[0]!, shift: 0, opacity: 1, axes: this.axes(), cuts: 0 };
    this.setClip(undefined);
    this.setPreset(this.state.preset);
  }

  armScalpel(mode: CutMode | undefined): void {
    this.state = { ...this.state, scalpel: mode };
  }

  /** Shows a volume in the viewport keeping the camera, preset, curves and clipping box. */
  private async show(volumeId: string): Promise<void> {
    const vp = this.viewport();
    const camera = vp.getCamera();
    await vp.setVolumes([{ volumeId }]);
    vp.setCamera(camera);
    this.setPreset(this.state.preset);
    this.setClip(this.state.clip);
  }

  /** The cut copy, created on the first cut (the source volume is never modified). */
  private async cutCopy(): Promise<Types.IImageVolume | undefined> {
    if (this.copy) return cache.getVolume(this.copy.volumeId);
    const source = cache.getVolume(this.sourceVolumeId);
    const data = source?.voxelManager?.getCompleteScalarDataArray?.() as Scalars | undefined;
    if (!data) return undefined;
    const volumeId = `${this.sourceVolumeId}:scalpel`;
    const copy = volumeLoader.createAndCacheDerivedVolume(this.sourceVolumeId, {
      volumeId,
      targetBuffer: { type: data.constructor.name as Types.PixelDataTypedArrayString },
    });
    copy.voxelManager?.setCompleteScalarDataArray?.(data);
    let fill = Infinity;
    for (let i = 0; i < data.length; i++) if (data[i]! < fill) fill = data[i]!;
    this.copy = { volumeId, fill };
    await this.show(volumeId);
    return copy;
  }

  /**
   * Cuts with an outline drawn on the view (canvas CSS pixels of a width × height canvas): every voxel whose centre
   * projects inside (or outside) the outline is set to the volume minimum, through the whole depth. Returns false
   * when the projection is not parallel (the outline would not map to straight rays).
   */
  async cut(outline: readonly [number, number][], mode: CutMode, width: number, height: number): Promise<boolean> {
    const vp = this.viewport();
    const g = this.geometry;
    const toCanvas = (ijk: Vec3): [number, number] => {
      const c = vp.worldToCanvas(voxelToPatient(g, ijk) as unknown as Types.Point3);
      return [c[0], c[1]];
    };
    // Parallel projection: canvas = o + i·di + j·dj + k·dk; checked on the far corner.
    const o = toCanvas([0, 0, 0]);
    const step = ([1, 0, 0] as const).map((_, a) => {
      const ijk: [number, number, number] = [0, 0, 0];
      ijk[a] = 1;
      const p = toCanvas(ijk);
      return [p[0] - o[0], p[1] - o[1]] as const;
    });
    const [n0, n1, n2] = g.dimensions;
    const far = toCanvas([n0 - 1, n1 - 1, n2 - 1]);
    const fx = o[0] + (n0 - 1) * step[0]![0] + (n1 - 1) * step[1]![0] + (n2 - 1) * step[2]![0];
    const fy = o[1] + (n0 - 1) * step[0]![1] + (n1 - 1) * step[1]![1] + (n2 - 1) * step[2]![1];
    if (Math.hypot(far[0] - fx, far[1] - fy) > 0.5) return false;
    const copy = await this.cutCopy();
    const vm = copy?.voxelManager;
    const fill = this.copy?.fill;
    if (!vm || fill === undefined) return false;
    const mask = rasterizePolygon(outline, width, height);
    const data = vm.getCompleteScalarDataArray?.() as Scalars;
    const cutInside = mode === 'inside';
    const indices: number[] = [];
    const values: number[] = [];
    let v = 0;
    for (let k = 0; k < n2; k++) {
      for (let j = 0; j < n1; j++) {
        let x = o[0] + j * step[1]![0] + k * step[2]![0];
        let y = o[1] + j * step[1]![1] + k * step[2]![1];
        for (let i = 0; i < n0; i++, v++, x += step[0]![0], y += step[0]![1]) {
          const px = Math.floor(x);
          const py = Math.floor(y);
          const inside = px >= 0 && py >= 0 && px < width && py < height && mask[py * width + px] === 1;
          if (inside !== cutInside || data[v] === fill) continue;
          indices.push(v);
          values.push(data[v]!);
          data[v] = fill;
        }
      }
    }
    if (indices.length > 0) {
      vm.setCompleteScalarDataArray?.(data);
      copy!.modified();
      this.undoStack.push({ indices: Uint32Array.from(indices), values: Float64Array.from(values) });
      if (this.undoStack.length > MAX_CUTS) this.undoStack.shift();
      vp.render();
    }
    this.state = { ...this.state, scalpel: undefined, cuts: this.undoStack.length };
    return true;
  }

  /** Restores the voxels of the last cut. */
  undoCut(): void {
    const last = this.undoStack.pop();
    const copy = this.copy ? cache.getVolume(this.copy.volumeId) : undefined;
    const vm = copy?.voxelManager;
    if (!last || !vm) return;
    const data = vm.getCompleteScalarDataArray?.() as Scalars;
    for (let n = 0; n < last.indices.length; n++) data[last.indices[n]!] = last.values[n]!;
    vm.setCompleteScalarDataArray?.(data);
    copy!.modified();
    this.viewport().render();
    this.state = { ...this.state, cuts: this.undoStack.length };
  }

  /**
   * Exports the iso-surface at `threshold` of what the view shows (after scalpel cuts, inside the clipping box) as a
   * binary STL in patient coordinates (mm), computed in a worker, then saved where the user chooses.
   */
  async exportStl(threshold: number, name: string): Promise<StlResult> {
    const volume = cache.getVolume(this.copy?.volumeId ?? this.sourceVolumeId);
    const scalars = volume?.voxelManager?.getCompleteScalarDataArray?.() as Scalars | undefined;
    if (!scalars) return { ok: false, reason: 'failed' };
    const worker = new Worker(new URL('./stl.worker.ts', import.meta.url), { type: 'module' });
    try {
      const res = await new Promise<StlResponse>((resolve) => {
        worker.onmessage = (e: MessageEvent<StlResponse>) => resolve(e.data);
        worker.onerror = () => resolve({ ok: false, reason: 'failed' });
        const req: StlRequest = {
          scalars,
          geometry: this.geometry,
          threshold,
          maxTriangles: MAX_STL_TRIANGLES,
          ...(this.state.clip ? { clip: this.state.clip } : {}),
        };
        worker.postMessage(req, [scalars.buffer]);
      });
      if (!res.ok) return res;
      const saved = await window.api.saveStl(name, res.bytes);
      return { ok: true, triangles: res.triangles, saved };
    } finally {
      worker.terminate();
    }
  }

  /** Back to the uncut source volume; the cut copy is released. */
  private async restoreUncut(): Promise<void> {
    this.undoStack = [];
    if (!this.copy) return;
    const id = this.copy.volumeId;
    this.copy = undefined;
    await this.show(this.sourceVolumeId);
    this.release(id);
  }

  /** Releases the cut copy (called when the view shows something else). */
  release(id = this.copy?.volumeId): void {
    if (id && cache.getVolume(id)) cache.removeVolumeLoadObject(id);
    if (id === this.copy?.volumeId) this.copy = undefined;
  }
}
