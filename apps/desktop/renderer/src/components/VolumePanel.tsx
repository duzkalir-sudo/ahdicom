/** Controls of the active 3D view: rendering preset, transfer-function shift and opacity, clipping box. */
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type ClipBox, type Vec3 } from '@ahdicom/dicom-core';
import { useStore } from '../state/store';
import type { ViewState } from '../viewer/controller';
import { controllerAt, onControllersChanged } from '../viewer/registry';
import { presetsFor, type StlResult, type VrPreset } from '../viewer/volume3d';

const FULL_BOX: ClipBox = { min: [0, 0, 0], max: [1, 1, 1] };
/** Smallest box extent along an axis (fraction of the volume). */
const MIN_EXTENT = 0.02;

/** Live state of the viewport at `index` (re-subscribes when viewports are created or destroyed). */
export function useActiveState(index: number): ViewState | undefined {
  const [vs, setVs] = useState<{ index: number; state: ViewState }>();
  const [rev, setRev] = useState(0);
  useEffect(() => onControllersChanged(() => setRev((r) => r + 1)), []);
  useEffect(() => controllerAt(index)?.subscribe((state) => setVs({ index, state })), [index, rev]);
  return vs?.index === index && controllerAt(index) ? vs.state : undefined;
}

/** STL export of the iso-surface at a threshold (what the 3D view shows: after cuts, inside the clipping box). */
function StlExport(props: { index: number; modality?: string }): ReactNode {
  const { t } = useTranslation();
  const [threshold, setThreshold] = useState(props.modality === 'CT' ? 300 : 100);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<StlResult>();
  const run = async (): Promise<void> => {
    setBusy(true);
    setResult(undefined);
    try {
      setResult(await controllerAt(props.index)?.exportStl(threshold));
    } finally {
      setBusy(false);
    }
  };
  let message: string | undefined;
  if (busy) message = t('vr.stl.busy');
  else if (result?.ok) message = result.saved ? t('vr.stl.saved', { count: result.triangles }) : t('vr.stl.cancelled');
  else if (result) message = t(`vr.stl.${result.reason}`);
  return (
    <>
      <div className="vr-section">{t('vr.stl.title')}</div>
      <div className="field">
        <label htmlFor="vr-stl-threshold">{t('vr.stl.threshold')}</label>
        <input
          id="vr-stl-threshold"
          className="input"
          type="number"
          step={10}
          value={threshold}
          onChange={(e) => Number.isFinite(e.target.valueAsNumber) && setThreshold(e.target.valueAsNumber)}
          data-testid="vr-stl-threshold"
        />
      </div>
      <div className="vr-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void run()} data-testid="vr-stl-export">
          {t('vr.stl.export')}
        </button>
      </div>
      {message ? (
        <div className="menu-hint" data-testid="vr-stl-status">
          {message}
        </div>
      ) : null}
    </>
  );
}

export function VolumePanel(): ReactNode {
  const { t, i18n } = useTranslation();
  const index = useStore((s) => s.activeIndex);
  const vs = useActiveState(index);
  const ds = useStore((s) => (vs?.displaySetId ? s.displaySets[vs.displaySetId] : undefined));
  if (vs?.view !== '3d' || vs.status !== 'ready' || !vs.vr) {
    return (
      <div className="panel-pad muted" data-testid="vr-inactive">
        {t('vr.inactive')}
      </div>
    );
  }
  const c = controllerAt(index)!;
  const vr = vs.vr;
  const box = vr.clip ?? FULL_BOX;
  const locale = i18n.language === 'tr' ? 'tr-TR' : 'en-US';
  const setBox = (axis: number, end: 'min' | 'max', value: number): void => {
    const min = [...box.min] as [number, number, number];
    const max = [...box.max] as [number, number, number];
    if (end === 'min') min[axis] = Math.min(value, max[axis]! - MIN_EXTENT);
    else max[axis] = Math.max(value, min[axis]! + MIN_EXTENT);
    c.setClipBox({ min: min as Vec3, max: max as Vec3 });
  };
  return (
    <div className="panel-pad vr-panel" data-testid="vr-panel">
      <div className="field">
        <label htmlFor="vr-preset">{t('vr.preset')}</label>
        <select
          id="vr-preset"
          className="select"
          value={vr.preset}
          onChange={(e) => c.setVolumePreset(e.target.value as VrPreset)}
          data-testid="vr-preset"
        >
          {presetsFor(ds?.modality).map((p) => (
            <option key={p} value={p}>
              {t(`vr.presets.${p}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="vr-shift">{t('vr.shift', { value: new Intl.NumberFormat(locale).format(vr.shift) })}</label>
        <input
          id="vr-shift"
          type="range"
          min={-1000}
          max={1000}
          step={10}
          value={vr.shift}
          onChange={(e) => c.setVolumeCurves({ shift: Number(e.target.value) })}
          data-testid="vr-shift"
        />
      </div>
      <div className="field">
        <label htmlFor="vr-opacity">{t('vr.opacity', { value: Math.round(vr.opacity * 100) })}</label>
        <input
          id="vr-opacity"
          type="range"
          min={0}
          max={300}
          step={5}
          value={Math.round(vr.opacity * 100)}
          onChange={(e) => c.setVolumeCurves({ opacity: Number(e.target.value) / 100 })}
          data-testid="vr-opacity"
        />
      </div>
      <div className="vr-section">{t('vr.clip')}</div>
      <label className="check">
        <input
          type="checkbox"
          checked={Boolean(vr.clip)}
          onChange={(e) => c.setClipBox(e.target.checked ? FULL_BOX : undefined)}
          data-testid="vr-clip"
        />
        {t('vr.clipOn')}
      </label>
      {vr.clip
        ? vr.axes.map(([from, to], a) => (
            <div className="field" key={from + to}>
              <label>{t('vr.axis', { from, to })}</label>
              <div className="range-pair">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(box.min[a]! * 100)}
                  aria-label={t('vr.from', { side: from })}
                  onChange={(e) => setBox(a, 'min', Number(e.target.value) / 100)}
                  data-testid={`vr-clip-min-${a}`}
                />
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(box.max[a]! * 100)}
                  aria-label={t('vr.to', { side: to })}
                  onChange={(e) => setBox(a, 'max', Number(e.target.value) / 100)}
                  data-testid={`vr-clip-max-${a}`}
                />
              </div>
            </div>
          ))
        : null}
      <div className="vr-section">{t('vr.scalpel')}</div>
      <div className="vr-actions">
        {(['inside', 'outside'] as const).map((m) => (
          <button
            key={m}
            type="button"
            className={`btn${vr.scalpel === m ? ' primary' : ''}`}
            aria-pressed={vr.scalpel === m}
            onClick={() => c.armScalpel(vr.scalpel === m ? undefined : m)}
            data-testid={`vr-cut-${m}`}
          >
            {t(`vr.cut.${m}`)}
          </button>
        ))}
        <button type="button" className="btn" disabled={vr.cuts === 0} onClick={() => c.undoCut()} data-testid="vr-undo-cut">
          {t('vr.undoCut', { count: vr.cuts })}
        </button>
      </div>
      {vr.scalpel ? <div className="menu-hint">{t('vr.scalpelHint')}</div> : null}
      <StlExport index={index} modality={ds?.modality} />
      <div className="vr-actions">
        <button type="button" className="btn" onClick={() => c.reset()} data-testid="vr-reset">
          {t('vr.reset')}
        </button>
      </div>
      <div className="menu-hint">{t('vr.hint')}</div>
    </div>
  );
}
