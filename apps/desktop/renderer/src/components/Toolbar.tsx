import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  ChevronDown,
  Contrast,
  Disc3,
  EyeOff,
  FileArchive,
  FilePlus2,
  FlipHorizontal2,
  FlipVertical2,
  FolderOpen,
  Focus,
  Hand,
  HelpCircle,
  Info,
  Layers,
  LayoutGrid,
  Link2,
  Maximize,
  Monitor,
  Minimize2,
  MoveVertical,
  Play,
  RotateCcw,
  RotateCw,
  Ruler,
  Settings,
  Share,
  SlidersHorizontal,
  Square,
  SunMedium,
  Type,
  Undo2,
  X,
  ZoomIn,
} from 'lucide-react';
import { CT_PRESETS, PET_PERCENT_PRESETS, percentRange } from '@ahdicom/dicom-core';
import { applyPreset, closeAll, commandById, formatShortcut, openKind, selectTool, toggleCine, toggleFullscreen, tooltip } from '../app/commands';
import { displaySetAt, useStore, type LayoutSpec } from '../state/store';
import { controllerAt } from '../viewer/registry';
import { IconButton, MenuItem, Popover } from './ui';

function LayoutMenu(props: { anchor: HTMLElement | null; onClose: () => void }): ReactNode {
  const { t } = useTranslation();
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  const set = (l: LayoutSpec): void => {
    useStore.getState().setLayout(l);
    props.onClose();
  };
  const presets: [number, number][] = [
    [1, 1],
    [1, 2],
    [2, 1],
    [2, 2],
    [2, 3],
    [3, 3],
    [4, 4],
    [5, 5],
  ];
  return (
    <Popover anchor={props.anchor} onClose={props.onClose} testId="layout-menu">
      <div className="menu-label">{t('toolbar.layout')}</div>
      {presets.map(([r, c]) => (
        <MenuItem key={`${r}x${c}`} onClick={() => set({ kind: 'grid', rows: r, cols: c })} testId={`layout-${r}x${c}`}>
          {t('layout.grid', { rows: r, cols: c })}
        </MenuItem>
      ))}
      <MenuItem onClick={() => set({ kind: '1+2' })} testId="layout-1+2">
        {t('layout.preset12')}
      </MenuItem>
      <MenuItem onClick={() => set({ kind: '2+1' })} testId="layout-2+1">
        {t('layout.preset21')}
      </MenuItem>
      <div className="menu-sep" />
      <div className="menu-label">{t('layout.custom')}</div>
      <div className="grid-picker" onMouseLeave={() => setHover(null)}>
        {Array.from({ length: 25 }, (_, i) => {
          const r = Math.floor(i / 5) + 1;
          const c = (i % 5) + 1;
          const on = hover !== null && r <= hover.r && c <= hover.c;
          return (
            <button
              key={i}
              type="button"
              className={on ? 'on' : ''}
              aria-label={t('layout.grid', { rows: r, cols: c })}
              onMouseEnter={() => setHover({ r, c })}
              onClick={() => set({ kind: 'grid', rows: r, cols: c })}
            />
          );
        })}
      </div>
      <div className="grid-picker-label num">{hover ? t('layout.grid', { rows: hover.r, cols: hover.c }) : ' '}</div>
    </Popover>
  );
}

function PresetMenu(props: { anchor: HTMLElement | null; onClose: () => void }): ReactNode {
  const { t } = useTranslation();
  const s = useStore();
  const ds = displaySetAt(s.activeIndex);
  const c = controllerAt(s.activeIndex);
  const modality = ds?.firstInstance.modality;
  const run = (fn: () => void): void => {
    fn();
    props.onClose();
  };
  const fileWindows = (ds?.firstInstance.geometry.windowCenter ?? []).map((center, i) => ({
    center,
    width: ds?.firstInstance.geometry.windowWidth?.[i] ?? 0,
    name: ds?.firstInstance.windowExplanation?.[i] ?? `${i + 1}`,
  }));
  return (
    <Popover anchor={props.anchor} onClose={props.onClose} testId="preset-menu">
      <MenuItem onClick={() => run(() => c?.defaultWindow())} kbd={formatShortcut(commandById('defaultWindow')?.shortcut)} testId="preset-default">
        {t('presets.default')}
      </MenuItem>
      {fileWindows.length > 1
        ? fileWindows.map((w, i) => (
            <MenuItem key={`fw${i}`} onClick={() => run(() => c?.setWindow({ center: w.center, width: w.width }))} testId={`preset-file-${i}`}>
              {t('presets.fromFile', { name: w.name })}
            </MenuItem>
          ))
        : null}
      <MenuItem
        onClick={() =>
          run(() => {
            const r = c?.imageRange();
            if (r) c?.setRange({ lower: r.min, upper: r.max > r.min ? r.max : r.min + 1 });
          })
        }
        testId="preset-full"
      >
        {t('presets.fullRange')}
      </MenuItem>
      <div className="menu-sep" />
      {modality === 'PT' ? (
        <>
          {PET_PERCENT_PRESETS.map((p) => (
            <MenuItem
              key={p.id}
              testId={`preset-${p.id}`}
              onClick={() =>
                run(() => {
                  const r = c?.imageRange();
                  if (r) c?.setRange(percentRange(Math.min(0, r.min), r.max, p.upperPercent));
                })
              }
            >
              {t(p.labelKey, { value: p.upperPercent })}
            </MenuItem>
          ))}
          <MenuItem disabled onClick={() => undefined}>
            {t('presets.suvRange', { value: 5 })}
          </MenuItem>
        </>
      ) : (
        CT_PRESETS.map((p) => (
          <MenuItem key={p.id} onClick={() => run(() => applyPreset(p.id))} kbd={p.key} disabled={modality !== 'CT'} testId={`preset-${p.id}`}>
            {t(p.labelKey)} <span className="muted num">{` ${p.width} / ${p.center}`}</span>
          </MenuItem>
        ))
      )}
      {s.settings.userPresets.length > 0 ? (
        <>
          <div className="menu-sep" />
          <div className="menu-label">{t('presets.user')}</div>
          {s.settings.userPresets.map((p) => (
            <MenuItem key={p.id} onClick={() => run(() => applyPreset(p.id))} testId="preset-user">
              {p.name} <span className="muted num">{` ${p.width} / ${p.center}`}</span>
            </MenuItem>
          ))}
        </>
      ) : null}
      <div className="menu-sep" />
      <MenuItem onClick={() => run(() => useStore.getState().setDialog('windowLevel'))} kbd={formatShortcut(commandById('windowDialog')?.shortcut)} testId="preset-dialog">
        {t('toolbar.windowDialog')}
      </MenuItem>
    </Popover>
  );
}

export function Toolbar(): ReactNode {
  const { t } = useTranslation();
  const s = useStore();
  const [menu, setMenu] = useState<null | 'layout' | 'presets'>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const toggleMenu = (m: 'layout' | 'presets', el: HTMLElement): void => {
    setAnchor(el);
    setMenu(menu === m ? null : m);
  };
  const hasImages = Object.keys(s.displaySets).length > 0;
  const active = () => controllerAt(useStore.getState().activeIndex);

  return (
    <header className="toolbar" data-testid="toolbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden>
          A
        </span>
        <span className="brand-name">{t('app.name')}</span>
      </div>

      <div className="tb-group" aria-label={t('groups.open')}>
        <IconButton tip={tooltip('toolbar.openFiles', 'openFiles')} onClick={() => void openKind('files')} testId="tb-open-files">
          <FilePlus2 size={18} />
        </IconButton>
        <IconButton tip={tooltip('toolbar.openFolder', 'openFolder')} onClick={() => void openKind('folder')} testId="tb-open-folder">
          <FolderOpen size={18} />
        </IconButton>
        <IconButton tip={t('toolbar.openDicomdir')} onClick={() => void openKind('dicomdir')} testId="tb-open-dicomdir">
          <Disc3 size={18} />
        </IconButton>
        <IconButton tip={t('toolbar.openZip')} onClick={() => void openKind('zip')} testId="tb-open-zip">
          <FileArchive size={18} />
        </IconButton>
        <IconButton tip={t('toolbar.closeAll')} onClick={() => void closeAll()} disabled={!hasImages} testId="tb-close-all">
          <X size={18} />
        </IconButton>
      </div>

      <div className="tb-group" aria-label={t('groups.layout')}>
        <button
          type="button"
          className="icon-btn"
          data-tip={t('toolbar.layout')}
          aria-label={t('toolbar.layout')}
          onClick={(e) => toggleMenu('layout', e.currentTarget)}
          data-testid="tb-layout"
        >
          <LayoutGrid size={18} />
          <ChevronDown size={12} className="caret" />
        </button>
      </div>

      <div className="tb-group" aria-label={t('groups.navigate')}>
        <IconButton tip={tooltip('toolbar.windowLevel', 'toolWL')} pressed={s.tool === 'windowLevel'} onClick={() => selectTool('windowLevel')} testId="tb-tool-wl">
          <SunMedium size={18} />
        </IconButton>
        <IconButton tip={tooltip('toolbar.pan', 'toolPan')} pressed={s.tool === 'pan'} onClick={() => selectTool('pan')} testId="tb-tool-pan">
          <Hand size={18} />
        </IconButton>
        <IconButton tip={tooltip('toolbar.zoom', 'toolZoom')} pressed={s.tool === 'zoom'} onClick={() => selectTool('zoom')} testId="tb-tool-zoom">
          <ZoomIn size={18} />
        </IconButton>
        <IconButton tip={tooltip('toolbar.scroll', 'toolScroll')} pressed={s.tool === 'scroll'} onClick={() => selectTool('scroll')} testId="tb-tool-scroll">
          <MoveVertical size={18} />
        </IconButton>
        <button
          type="button"
          className="icon-btn"
          data-tip={t('toolbar.presets')}
          aria-label={t('toolbar.presets')}
          onClick={(e) => toggleMenu('presets', e.currentTarget)}
          disabled={!hasImages}
          data-testid="tb-presets"
        >
          <SlidersHorizontal size={18} />
          <ChevronDown size={12} className="caret" />
        </button>
        <IconButton tip={tooltip('toolbar.rotateCcw', 'rotateCcw')} onClick={() => active()?.rotate(-90)} disabled={!hasImages} testId="tb-rotate-ccw">
          <RotateCcw size={18} />
        </IconButton>
        <IconButton tip={tooltip('toolbar.rotateCw', 'rotateCw')} onClick={() => active()?.rotate(90)} disabled={!hasImages} testId="tb-rotate-cw">
          <RotateCw size={18} />
        </IconButton>
        <IconButton tip={tooltip('toolbar.flipH', 'flipH')} onClick={() => active()?.flip('h')} disabled={!hasImages} testId="tb-flip-h">
          <FlipHorizontal2 size={18} />
        </IconButton>
        <IconButton tip={tooltip('toolbar.flipV', 'flipV')} onClick={() => active()?.flip('v')} disabled={!hasImages} testId="tb-flip-v">
          <FlipVertical2 size={18} />
        </IconButton>
        <IconButton tip={tooltip('toolbar.invert', 'invert')} onClick={() => active()?.invert()} disabled={!hasImages} testId="tb-invert">
          <Contrast size={18} />
        </IconButton>
        <IconButton tip={tooltip('toolbar.fit', 'fit')} onClick={() => active()?.fit()} disabled={!hasImages} testId="tb-fit">
          <Focus size={18} />
        </IconButton>
        <IconButton tip={tooltip('toolbar.oneToOne', 'oneToOne')} onClick={() => active()?.oneToOne()} disabled={!hasImages} testId="tb-1to1">
          <Square size={18} />
        </IconButton>
        <IconButton tip={tooltip('toolbar.reset', 'reset')} onClick={() => active()?.reset()} disabled={!hasImages} testId="tb-reset">
          <Undo2 size={18} />
        </IconButton>
        <IconButton tip={tooltip('toolbar.cine', 'cine')} pressed={Boolean(s.cine[s.activeIndex])} onClick={toggleCine} disabled={!hasImages} testId="tb-cine">
          <Play size={18} />
        </IconButton>
      </div>

      <div className="tb-group" aria-label={t('groups.measure')}>
        <IconButton tip={t('toolbar.measureSoon')} disabled>
          <Ruler size={18} />
        </IconButton>
        <IconButton tip={t('toolbar.syncSoon')} disabled>
          <Link2 size={18} />
        </IconButton>
        <IconButton tip={t('toolbar.mprSoon')} disabled>
          <Box size={18} />
        </IconButton>
        <IconButton tip={t('toolbar.exportSoon')} disabled>
          <Share size={18} />
        </IconButton>
      </div>

      <div className="tb-group" aria-label={t('groups.settings')}>
        <IconButton tip={tooltip('toolbar.overlays', 'overlay')} pressed={s.showInfoOverlay} onClick={() => s.toggleInfoOverlay()} testId="tb-overlay">
          <Type size={18} />
        </IconButton>
        <IconButton tip={tooltip('toolbar.dicomOverlays', 'dicomOverlay')} pressed={s.showDicomOverlays} onClick={() => s.toggleDicomOverlays()} testId="tb-dicom-overlay">
          <Layers size={18} />
        </IconButton>
        <IconButton tip={tooltip('toolbar.hidePatient', 'hidePatient')} pressed={s.settings.hidePatientData} onClick={() => commandById('hidePatient')?.run()} testId="tb-hide-patient">
          <EyeOff size={18} />
        </IconButton>
      </div>

      <div className="tb-spacer" />

      <div className="tb-group" aria-label={t('groups.settings')}>
        <IconButton tip={tooltip('toolbar.distractionFree', 'distractionFree')} onClick={() => s.setDistractionFree(true)} testId="tb-df">
          <Monitor size={18} />
        </IconButton>
        <IconButton tip={tooltip('toolbar.fullscreen', 'fullscreen')} pressed={s.fullscreen} onClick={() => void toggleFullscreen()} testId="tb-fullscreen">
          {s.fullscreen ? <Minimize2 size={18} /> : <Maximize size={18} />}
        </IconButton>
        <IconButton tip={tooltip('toolbar.help', 'help')} tipPos="left" onClick={() => s.setDialog('shortcuts')} testId="tb-help">
          <HelpCircle size={18} />
        </IconButton>
        <IconButton tip={tooltip('toolbar.settings', 'settings')} tipPos="left" onClick={() => s.setDialog('settings')} testId="tb-settings">
          <Settings size={18} />
        </IconButton>
        <IconButton tip={t('toolbar.about')} tipPos="left" onClick={() => s.setDialog('about')} testId="tb-about">
          <Info size={18} />
        </IconButton>
      </div>

      {menu === 'layout' ? <LayoutMenu anchor={anchor} onClose={() => setMenu(null)} /> : null}
      {menu === 'presets' ? <PresetMenu anchor={anchor} onClose={() => setMenu(null)} /> : null}
    </header>
  );
}
