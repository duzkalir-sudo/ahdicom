/**
 * 3D volume rendering controls of one 3D viewport: rendering presets, transfer-function shift and opacity, and the
 * clipping box. Works on the vtk.js volume actor that Cornerstone creates; the clipping planes come from dicom-core.
 */
import vtkPlane from '@kitware/vtk.js/Common/DataModel/Plane';
import type { Types } from '@cornerstonejs/core';
import { type ClipBox, type VolumeGeometry, clipPlanes, directionToLabel, vec3 } from '@ahdicom/dicom-core';

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
}

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

  constructor(
    private readonly viewport: () => Types.IVolumeViewport,
    private readonly geometry: VolumeGeometry,
    private readonly modality: string | undefined,
  ) {
    this.state = { preset: presetsFor(modality)[0]!, shift: 0, opacity: 1, axes: this.axes() };
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

  /** Default preset, no shift, preset opacity, no clipping box. */
  reset(): void {
    this.state = { preset: presetsFor(this.modality)[0]!, shift: 0, opacity: 1, axes: this.axes() };
    this.setClip(undefined);
    this.setPreset(this.state.preset);
  }
}
