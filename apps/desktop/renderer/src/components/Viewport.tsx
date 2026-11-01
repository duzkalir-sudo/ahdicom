import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, ImageOff, Loader2, Trash2 } from 'lucide-react';
import { removeMeasurement } from '../viewer/measureDoc';
import {
  CT_PRESETS,
  type DisplaySet,
  formatDicomDate,
  formatDicomTime,
  formatNumber,
  formatPersonName,
  niceScaleLength,
  sliceLocation,
} from '@ahdicom/dicom-core';
import { applyPreset, commandById, formatShortcut, MOD } from '../app/commands';
import { MAX_VIEWPORTS, useStore, viewportCount } from '../state/store';
import { ViewportController, type ViewState } from '../viewer/controller';
import { getEngine, imageIdsFor, isMeasureTool, purgeImages } from '../viewer/cornerstone';
import { allControllers, controllerAt, registerController, unregisterController } from '../viewer/registry';
import { MenuItem, PointMenu } from './ui';

const DS_MIME = 'application/x-cdv-displayset';

function fmtValue(v: number, locale: 'tr' | 'en'): string {
  if (Number.isInteger(v)) return String(v);
  return formatNumber(v, Math.abs(v) >= 100 ? 1 : 2, locale);
}

function Corners(props: { ds: DisplaySet; vs: ViewState }): ReactNode {
  const { t, i18n } = useTranslation();
  const locale = (i18n.language === 'en' ? 'en' : 'tr') as 'tr' | 'en';
  const settings = useStore((s) => s.settings);
  const o = settings.overlay;
  const hide = settings.hidePatientData;
  const inst = props.ds.firstInstance;
  const img = props.ds.images[props.vs.index];
  const vs = props.vs;
  const hidden = t('viewport.hidden');
  const location = sliceLocation(img?.geometry.imagePositionPatient, props.ds.geometry.normal);
  const thickness = img?.geometry.sliceThickness ?? inst.geometry.sliceThickness;
  const isFrame = props.ds.kind === 'multiframe';
  const firstWarning = props.ds.warnings.find((w) => w.code !== 'charsetUncertain' && w.code !== 'nonImage');
  const probe = vs.probe;
  let probeText: string | undefined;
  if (probe) {
    if (probe.value === undefined) probeText = t('viewport.probeOutside');
    else {
      const val = Array.isArray(probe.value)
        ? probe.value.join(' ')
        : `${fmtValue(probe.value, locale)}${probe.unit === 'raw' ? '' : ` ${t(`units.${probe.unit}`)}`}`;
      probeText = t('viewport.probe', { x: probe.column, y: probe.row, value: probe.padding ? `${val} (${t('viewport.padding')})` : val });
    }
  }
  const sex = inst.patientSex ? ` · ${inst.patientSex}` : '';
  const age = inst.patientAge ? ` · ${inst.patientAge}` : '';
  return (
    <>
      {o.patient ? (
        <div className="corner tl" data-testid="corner-tl">
          <div className="strong">{hide ? hidden : formatPersonName(inst.patientName, locale) || '—'}</div>
          <div>{hide ? hidden : (inst.patientId ?? '')}</div>
          <div>{hide ? '' : `${formatDicomDate(inst.patientBirthDate, locale)}${sex}${age}`}</div>
          {inst.charsetUncertain ? <div className="warn">⚠ {t('warnings.charsetUncertain')}</div> : null}
        </div>
      ) : null}
      {o.study ? (
        <div className="corner tr" data-testid="corner-tr">
          <div className="strong">{inst.studyDescription ?? ''}</div>
          <div>{`${formatDicomDate(inst.studyDate, locale)} ${formatDicomTime(inst.studyTime)}`}</div>
          {o.series ? (
            <div>
              {[
                inst.modality,
                inst.seriesNumber !== undefined ? t('viewport.series', { number: inst.seriesNumber }) : undefined,
                inst.seriesDescription,
                props.ds.splitBy ? t(`split.${props.ds.splitBy.key}`, { value: props.ds.splitBy.value }) : undefined,
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          ) : null}
          {hide || !inst.institutionName ? null : <div>{inst.institutionName}</div>}
          {firstWarning ? (
            <div className="warn" data-testid="viewport-warning">
              ⚠ {t(`warnings.${firstWarning.code}`, { value: firstWarning.value })}
            </div>
          ) : null}
        </div>
      ) : null}
      {o.image ? (
        <div className="corner bl" data-testid="corner-bl">
          <div className="strong" data-testid="image-index">
            {t(isFrame ? 'viewport.frame' : 'viewport.image', { index: vs.index + 1, total: vs.total })}
          </div>
          {location ? (
            <div>{t('viewport.location', { value: `${formatNumber(location.mm, 2, locale)} (${location.towards})` })}</div>
          ) : null}
          {thickness !== undefined ? <div>{t('viewport.thickness', { value: formatNumber(thickness, 2, locale) })}</div> : null}
          {props.ds.geometry.sliceSpacing !== undefined ? (
            <div>{t('viewport.spacing', { value: formatNumber(props.ds.geometry.sliceSpacing, 2, locale) })}</div>
          ) : null}
          {o.probe && probeText ? <div data-testid="probe">{probeText}</div> : null}
        </div>
      ) : null}
      <div className="corner br" data-testid="corner-br">
        {vs.cine ? <div className="strong">{t('viewport.cine', { fps: vs.fps })}</div> : null}
        {o.windowLevel && vs.voiLutName !== undefined ? (
          <div data-testid="wl-text">{t('viewport.voiLut', { name: vs.voiLutName })}</div>
        ) : null}
        {o.windowLevel && vs.voiLutName === undefined && vs.wl ? (
          <div data-testid="wl-text">
            {t('viewport.wl', { width: fmtValue(round(vs.wl.width), locale), center: fmtValue(round(vs.wl.center), locale) })}
          </div>
        ) : null}
        {o.zoom && vs.zoomPercent ? (
          <div data-testid="zoom-text">{t('viewport.zoom', { value: `${Math.round(vs.zoomPercent)}%` })}</div>
        ) : null}
        {vs.rotation ? <div>{t('viewport.rotated', { deg: vs.rotation })}</div> : null}
        {vs.flipH || vs.flipV || vs.inverted ? (
          <div>
            {[vs.flipH ? t('viewport.flippedH') : '', vs.flipV ? t('viewport.flippedV') : '', vs.inverted ? t('viewport.inverted') : '']
              .filter(Boolean)
              .join(' · ')}
          </div>
        ) : null}
      </div>
    </>
  );
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

function ScaleBar(props: { vs: ViewState; height: number }): ReactNode {
  const { t } = useTranslation();
  const mm = props.vs.mmPerCssPx;
  if (!mm || props.height < 120) return null;
  const maxMm = props.height * 0.3 * mm;
  const len = niceScaleLength(maxMm);
  if (!len) return null;
  const px = len / mm;
  const label = len >= 10 ? `${len / 10} cm` : `${len} mm`;
  const basis = props.vs.basis.kind;
  return (
    <div
      className="scalebar"
      data-testid="scale-bar"
      title={t(`basis.${basis === 'imagerMagnified' ? 'imagerMagnified' : basis}`, {
        mag: basis === 'imagerMagnified' ? props.vs.basis.magnification : '',
      })}
    >
      <span className="label">{label}</span>
      <div className="bar" style={{ height: px }} />
    </div>
  );
}

function SliceSlider(props: { vs: ViewState; index: number }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const { total, index } = props.vs;
  if (total < 2) return null;
  const go = (clientY: number): void => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const f = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
    controllerAt(props.index)?.scrollTo(Math.round(f * (total - 1)));
  };
  const h = Math.max(4, 100 / total);
  return (
    <div
      ref={ref}
      className="slice-slider"
      data-testid="slice-slider"
      onPointerDown={(e) => {
        e.stopPropagation();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        go(e.clientY);
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1) go(e.clientY);
      }}
    >
      <span className="thumb-pos" style={{ top: `${(index / (total - 1)) * (100 - h)}%`, height: `${h}%` }} />
    </div>
  );
}

/**
 * Small delete button for the measurement under the cursor. It stays for a moment after the cursor leaves the
 * outline so that it can be reached, and while the cursor is on it.
 */
function HoverDelete(props: { index: number; hover: ViewState['hover'] }): ReactNode {
  const { t } = useTranslation();
  // The last hovered measurement, kept briefly after the cursor leaves it (state derived during render).
  const [last, setLast] = useState<ViewState['hover']>();
  if (props.hover && props.hover !== last) setLast(props.hover);
  const onButton = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (props.hover) return;
    timer.current = setTimeout(() => {
      if (!onButton.current) setLast(undefined);
    }, 600);
    return () => clearTimeout(timer.current);
  }, [props.hover]);
  const shown = props.hover ?? last;
  const setShown = setLast;
  if (!shown) return null;
  return (
    <button
      type="button"
      className="vp-delete"
      style={{ left: shown.x, top: shown.y }}
      data-tip={t('measurements.delete')}
      aria-label={t('measurements.delete')}
      onMouseEnter={() => {
        onButton.current = true;
        clearTimeout(timer.current);
      }}
      onMouseLeave={() => {
        onButton.current = false;
        timer.current = setTimeout(() => setShown(undefined), 300);
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onButton.current = false;
        removeMeasurement(shown.uid);
        setShown(undefined);
      }}
      data-testid={`vp-delete-${props.index}`}
    >
      <Trash2 size={14} />
    </button>
  );
}

function ViewportCell(props: { index: number; style?: CSSProperties }): ReactNode {
  const { t } = useTranslation();
  const ready = useStore((s) => s.ready);
  const dsId = useStore((s) => s.slots[props.index]);
  const ds = useStore((s) => (dsId ? s.displaySets[dsId] : undefined));
  const activeIndex = useStore((s) => s.activeIndex);
  const showInfo = useStore((s) => s.showInfoOverlay);
  const showDicomOverlays = useStore((s) => s.showDicomOverlays);
  const orientationOn = useStore((s) => s.settings.overlay.orientation);
  const scaleOn = useStore((s) => s.settings.overlay.scaleBar);
  const elRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const guideRef = useRef<HTMLCanvasElement>(null);
  const cellRef = useRef<HTMLDivElement>(null);
  const [vs, setVs] = useState<ViewState | undefined>();
  const [ctrl, setCtrl] = useState<ViewportController | undefined>();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [dropOver, setDropOver] = useState(false);
  const [height, setHeight] = useState(0);
  const [width, setWidth] = useState(0);
  const rightDown = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!ready || !elRef.current || !canvasRef.current) return;
    const c = new ViewportController(props.index, elRef.current, canvasRef.current, guideRef.current ?? undefined);
    registerController(props.index, c);
    setCtrl(c);
    const unsub = c.subscribe(setVs);
    return () => {
      unsub();
      unregisterController(props.index, c);
      c.destroy();
      setCtrl(undefined);
    };
  }, [ready, props.index]);

  useEffect(() => {
    void ctrl?.setDisplaySet(ds);
  }, [ctrl, ds]);

  useEffect(() => {
    ctrl?.setShowOverlays(showDicomOverlays);
  }, [ctrl, showDicomOverlays]);

  useEffect(() => {
    const el = cellRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setHeight(el.clientHeight);
      setWidth(el.clientWidth);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Ctrl/Cmd + wheel zooms (captured before the stack-scroll tool sees the event).
  useEffect(() => {
    const el = cellRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();
      controllerAt(props.index)?.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
    };
    el.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => el.removeEventListener('wheel', onWheel, { capture: true });
  }, [props.index]);

  const isActive = activeIndex === props.index;
  const status = vs?.status ?? 'empty';
  const run = (fn: () => void): void => {
    fn();
    setMenu(null);
  };

  return (
    <div
      ref={cellRef}
      className={`vp-cell${isActive ? ' active' : ''}${dropOver ? ' drop' : ''}${width > 0 && (width < 300 || height < 220) ? ' compact' : ''}`}
      style={props.style}
      data-testid={`viewport-${props.index}`}
      data-status={status}
      onPointerDownCapture={(e) => {
        useStore.getState().setActive(props.index);
        if (e.button === 2) rightDown.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerUpCapture={(e) => {
        const d = rightDown.current;
        rightDown.current = null;
        if (e.button === 2 && d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4 && status === 'ready')
          setMenu({ x: e.clientX, y: e.clientY });
      }}
      onContextMenu={(e) => e.preventDefault()}
      // With a measurement tool selected, double-click finishes polygons instead of maximizing the viewport.
      onDoubleClick={() => !isMeasureTool(useStore.getState().tool) && useStore.getState().toggleMaximize(props.index)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DS_MIME)) {
          e.preventDefault();
          setDropOver(true);
        }
      }}
      onDragLeave={() => setDropOver(false)}
      onDrop={(e) => {
        setDropOver(false);
        const id = e.dataTransfer.getData(DS_MIME);
        if (id) {
          e.preventDefault();
          e.stopPropagation();
          useStore.getState().assign(props.index, id);
        }
      }}
    >
      <div ref={elRef} className="vp-element" data-testid={`viewport-element-${props.index}`} />
      <canvas ref={canvasRef} className="vp-overlay-canvas" />
      <canvas ref={guideRef} className="vp-overlay-canvas" data-testid={`viewport-guides-${props.index}`} />
      {status === 'ready' ? <HoverDelete index={props.index} hover={vs?.hover} /> : null}
      {status === 'ready' && ds && vs ? (
        <div className="vp-info">
          {showInfo ? <Corners ds={ds} vs={vs} /> : null}
          {showInfo && orientationOn && vs.labels ? (
            <>
              <span className="orient top" data-testid="orient-top">
                {vs.labels.top}
              </span>
              <span className="orient bottom" data-testid="orient-bottom">
                {vs.labels.bottom}
              </span>
              <span className="orient left" data-testid="orient-left">
                {vs.labels.left}
              </span>
              <span className="orient right" data-testid="orient-right">
                {vs.labels.right}
              </span>
            </>
          ) : null}
          {showInfo && scaleOn ? <ScaleBar vs={vs} height={height} /> : null}
          <SliceSlider vs={vs} index={props.index} />
        </div>
      ) : null}
      {status === 'loading' ? (
        <div className="vp-loading">
          <Loader2 size={16} className="spin" /> {t('viewport.loading')}
        </div>
      ) : null}
      {status === 'empty' ? (
        <div className="vp-message" data-testid="viewport-empty">
          <div>
            <div className="detail">{t('viewport.empty')}</div>
          </div>
        </div>
      ) : null}
      {status === 'error' ? (
        <div className="vp-message error" data-testid="viewport-error">
          <div>
            <ImageOff size={28} className="icon" />
            <div className="title">{t('viewport.failed')}</div>
            <div className="detail">{t('viewport.failedDetail')}</div>
          </div>
        </div>
      ) : null}
      {status === 'nonImage' ? (
        <div className="vp-message" data-testid="viewport-nonimage">
          <div>
            <FileText size={28} />
            <div className="title">{t('viewport.nonImage')}</div>
            <div className="detail">{t('viewport.nonImageDetail')}</div>
          </div>
        </div>
      ) : null}
      {menu ? (
        <PointMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <MenuItem onClick={() => run(() => ctrl?.defaultWindow())} kbd={formatShortcut(commandById('defaultWindow')?.shortcut)}>
            {t('presets.default')}
          </MenuItem>
          {ds?.firstInstance.modality === 'CT'
            ? CT_PRESETS.map((p) => (
                <MenuItem key={p.id} onClick={() => run(() => applyPreset(p.id))} kbd={p.key}>
                  {t(p.labelKey)}
                </MenuItem>
              ))
            : null}
          <div className="menu-sep" />
          <MenuItem onClick={() => run(() => ctrl?.rotate(90))} kbd={formatShortcut(commandById('rotateCw')?.shortcut)}>
            {t('toolbar.rotateCw')}
          </MenuItem>
          <MenuItem onClick={() => run(() => ctrl?.flip('h'))} kbd={formatShortcut(commandById('flipH')?.shortcut)}>
            {t('toolbar.flipH')}
          </MenuItem>
          <MenuItem onClick={() => run(() => ctrl?.flip('v'))} kbd={formatShortcut(commandById('flipV')?.shortcut)}>
            {t('toolbar.flipV')}
          </MenuItem>
          <MenuItem onClick={() => run(() => ctrl?.invert())} kbd={formatShortcut(commandById('invert')?.shortcut)}>
            {t('toolbar.invert')}
          </MenuItem>
          <div className="menu-sep" />
          <MenuItem onClick={() => run(() => ctrl?.fit())} kbd={formatShortcut(commandById('fit')?.shortcut)}>
            {t('toolbar.fit')}
          </MenuItem>
          <MenuItem onClick={() => run(() => ctrl?.oneToOne())} kbd={formatShortcut(commandById('oneToOne')?.shortcut)}>
            {t('toolbar.oneToOne')}
          </MenuItem>
          <MenuItem onClick={() => run(() => ctrl?.reset())} kbd={formatShortcut(commandById('reset')?.shortcut)}>
            {t('toolbar.reset')}
          </MenuItem>
        </PointMenu>
      ) : null}
    </div>
  );
}

/** Purges images of display sets that left all viewports for longer than PURGE_DELAY_MS. */
const PURGE_DELAY_MS = 30000;

export function ViewportGrid(): ReactNode {
  const { t } = useTranslation();
  const layout = useStore((s) => s.layout);
  const maximized = useStore((s) => s.maximizedIndex);
  const slots = useStore((s) => s.slots);
  const tool = useStore((s) => s.tool);
  const showLegend = useStore((s) => s.settings.showMouseLegend);
  const ref = useRef<HTMLDivElement>(null);
  const purgeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const n = viewportCount(layout);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        try {
          getEngine().resize(true, true);
        } catch {
          return;
        }
        for (const c of allControllers()) c.resizeOverlay();
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => {
    requestAnimationFrame(() => {
      try {
        getEngine().resize(true, true);
      } catch {
        return;
      }
      for (const c of allControllers()) c.resizeOverlay();
    });
  }, [layout, maximized]);

  const laidOut = useRef(false);
  useEffect(() => {
    // A new layout changes every viewport's size: fit the images again (side-by-side comparison starts fitted).
    // Not on mount (images are fitted when they load) and not on maximize/restore (keeps the user's zoom).
    if (!laidOut.current) {
      laidOut.current = true;
      return;
    }
    requestAnimationFrame(() => {
      for (const c of allControllers()) c.fit();
    });
  }, [layout]);

  useEffect(() => {
    const shown = new Set(slots.slice(0, n).filter((s): s is string => Boolean(s)));
    const timers = purgeTimers.current;
    for (const id of shown) {
      const tm = timers.get(id);
      if (tm) {
        clearTimeout(tm);
        timers.delete(id);
      }
    }
    for (const id of Object.keys(useStore.getState().displaySets)) {
      if (shown.has(id) || timers.has(id)) continue;
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          const st = useStore.getState();
          const nn = viewportCount(st.layout);
          if (st.slots.slice(0, nn).includes(id)) return;
          const ds = st.displaySets[id];
          if (ds) purgeImages(imageIdsFor(ds).slice(1)); // keep the first image (thumbnail)
        }, PURGE_DELAY_MS),
      );
    }
  }, [slots, n]);

  let style: CSSProperties;
  const cellStyle = (i: number): CSSProperties | undefined => {
    if (maximized !== null) return i === maximized ? { gridArea: '1 / 1 / -1 / -1' } : { display: 'none' };
    if (layout.kind === '1+2' && i === 0) return { gridRow: '1 / span 2' };
    if (layout.kind === '2+1' && i === 2) return { gridRow: '1 / span 2', gridColumn: '2' };
    if (layout.kind === '2+1') return { gridColumn: '1' };
    return undefined;
  };
  if (maximized !== null) style = { gridTemplateColumns: '1fr', gridTemplateRows: '1fr' };
  else if (layout.kind === 'grid')
    style = { gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))` };
  else style = { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gridTemplateRows: 'repeat(2, minmax(0, 1fr))' };

  return (
    <>
      <div ref={ref} className="viewport-grid" style={style} data-testid="viewport-grid">
        {Array.from({ length: Math.min(n, MAX_VIEWPORTS) }, (_, i) => (
          <ViewportCell key={i} index={i} style={cellStyle(i)} />
        ))}
      </div>
      {showLegend ? (
        <div className="mouse-legend" data-testid="mouse-legend">
          {t('mouse.legend', { left: isMeasureTool(tool) ? t(`measure.tool.${tool}`) : t(`tools.${tool}`), mod: MOD })}
        </div>
      ) : null}
    </>
  );
}

export { DS_MIME };
