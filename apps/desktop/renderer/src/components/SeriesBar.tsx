import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, FileText, GitCompare, ImageOff, Loader2, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { compareWithPrior, priorStudy } from '../viewer/compare';
import { utilities as csUtils } from '@cornerstonejs/core';
import { type DisplaySet, type StudyNode, formatDicomDate, formatPersonName } from '@ahdicom/dicom-core';
import { useStore, viewportCount } from '../state/store';
import { imageIdFor } from '../viewer/cornerstone';
import { IconButton } from './ui';
import { DS_MIME } from './Viewport';

/** Limits concurrent thumbnail renders so the first viewport image is never starved. */
const queue: (() => Promise<void>)[] = [];
let running = 0;
function enqueue(job: () => Promise<void>): void {
  queue.push(job);
  pump();
}
function pump(): void {
  while (running < 2 && queue.length > 0) {
    const job = queue.shift()!;
    running++;
    void job().finally(() => {
      running--;
      pump();
    });
  }
}

function Thumbnail(props: { ds: DisplaySet }): ReactNode {
  const ready = useStore((s) => s.ready);
  const ref = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const ds = props.ds;
  const mid = ds.images[Math.floor(ds.images.length / 2)];
  const imageId = mid ? imageIdFor(mid) : undefined;

  useEffect(() => {
    if (!ready || !imageId || !ref.current) return;
    let cancelled = false;
    setState('loading');
    enqueue(async () => {
      if (cancelled || !ref.current) return;
      try {
        await csUtils.loadImageToCanvas({ canvas: ref.current, imageId, thumbnail: true });
        // Cornerstone sizes thumbnail canvases to 256 CSS px; scale the bitmap into the 72 px tile.
        if (ref.current) {
          ref.current.style.width = '72px';
          ref.current.style.height = '72px';
        }
        if (!cancelled) setState('ok');
      } catch {
        if (!cancelled) setState('error');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [ready, imageId]);

  if (ds.kind === 'nonImage') {
    return (
      <div className="thumb">
        <FileText size={28} />
      </div>
    );
  }
  return (
    <div className="thumb">
      <canvas ref={ref} width={144} height={144} style={{ visibility: state === 'ok' ? 'visible' : 'hidden' }} />
      {state === 'loading' ? <Loader2 size={18} className="spin" style={{ position: 'absolute' }} /> : null}
      {state === 'error' ? <ImageOff size={22} style={{ position: 'absolute' }} /> : null}
      <span className="badge num">{ds.images.length}</span>
    </div>
  );
}

function SeriesItem(props: { ds: DisplaySet; splitCount: number }): ReactNode {
  const { t } = useTranslation();
  const ds = props.ds;
  const activeId = useStore((s) => s.slots[s.activeIndex]);
  const shown = useStore((s) => s.slots.slice(0, viewportCount(s.layout)).includes(ds.id));
  const warn = ds.warnings.find((w) => w.code !== 'nonImage');
  const count =
    ds.kind === 'nonImage'
      ? t('series.nonImage')
      : ds.kind === 'multiframe'
        ? t('series.frames', { count: ds.images.length })
        : t('series.images', { count: ds.images.length });
  const part = ds.splitBy ? t(`split.${ds.splitBy.key}`, { value: ds.splitBy.value }) : undefined;
  const desc = [ds.seriesDescription || t('series.noDescription'), part].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      className={`series-item${shown ? ' shown' : ''}${activeId === ds.id ? ' active' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DS_MIME, ds.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => {
        const s = useStore.getState();
        s.assign(s.activeIndex, ds.id);
      }}
      data-testid="series-item"
      data-ds-id={ds.id}
      title={warn ? t(`warnings.${warn.code}`, { value: warn.value }) : desc}
    >
      <Thumbnail ds={ds} />
      <span className="series-text">
        <span className="desc" style={{ display: 'block' }}>
          {desc}
          {props.splitCount > 1 && !ds.splitBy ? ` · ${t('series.split', { n: ds.splitIndex + 1 })}` : ''}
        </span>
        <span className="sub">
          <span>{[ds.modality, ds.seriesNumber !== undefined ? `#${ds.seriesNumber}` : undefined].filter(Boolean).join(' ')}</span>
          <span className="num">{count}</span>
          {warn ? (
            <span className="warn" aria-label={t('series.warning')}>
              <AlertTriangle size={13} />
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

function StudyBlock(props: { study: StudyNode }): ReactNode {
  const { t, i18n } = useTranslation();
  const locale = (i18n.language === 'en' ? 'en' : 'tr') as 'tr' | 'en';
  const hide = useStore((s) => s.settings.hidePatientData);
  const combinedSeries = useStore((s) => s.combinedSeries);
  const studies = useStore((s) => s.studies);
  const st = props.study;
  const prior = priorStudy(studies, st);
  return (
    <section className="study" data-testid="study">
      <div className="study-head">
        <div className="patient" data-testid="study-patient">
          {hide ? t('viewport.hidden') : formatPersonName(st.patientName, locale) || '—'}
        </div>
        <div className="meta">
          {[formatDicomDate(st.studyDate, locale), st.modalities.join('/'), st.studyDescription].filter(Boolean).join(' · ')}
        </div>
        <div className="meta">
          {[hide ? undefined : st.patientId, t('series.studyCount', { count: st.series.length })].filter(Boolean).join(' · ')}
        </div>
      </div>
      {prior ? (
        <button
          type="button"
          className="study-action"
          onClick={() => void compareWithPrior(st.studyInstanceUid)}
          data-testid="compare-prior"
        >
          <GitCompare size={14} />
          {t('compare.withPrior', { date: formatDicomDate(prior.studyDate, locale) })}
        </button>
      ) : null}
      <div className="series-list">
        {st.series.map((se) => {
          const split = se.displaySets.some((d) => d.splitBy);
          const combined = combinedSeries.includes(se.seriesInstanceUid);
          return (
            <div key={se.seriesInstanceUid}>
              {se.displaySets.map((ds) => (
                <SeriesItem key={ds.id} ds={ds} splitCount={se.displaySets.length} />
              ))}
              {split || combined ? (
                <button
                  type="button"
                  className="series-volumes"
                  onClick={() => useStore.getState().toggleCombined(se.seriesInstanceUid)}
                  data-testid="series-volumes"
                >
                  {t(combined ? 'compare.splitVolumes' : 'compare.combineVolumes')}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function SeriesBar(): ReactNode {
  const { t } = useTranslation();
  const studies = useStore((s) => s.studies);
  const open = useStore((s) => s.leftOpen);
  if (!open) {
    return (
      <aside className="side collapsed" data-testid="series-bar">
        <div className="side-header">
          <IconButton tip={t('panel.expand')} onClick={() => useStore.getState().toggleLeft()}>
            <PanelLeftOpen size={16} />
          </IconButton>
        </div>
      </aside>
    );
  }
  return (
    <aside className="side series-bar" data-testid="series-bar">
      <div className="side-header">
        <span className="title">{t('series.title')}</span>
        <IconButton tip={t('panel.collapse')} tipPos="left" onClick={() => useStore.getState().toggleLeft()}>
          <PanelLeftClose size={16} />
        </IconButton>
      </div>
      <div className="side-body">
        {studies.map((st) => (
          <StudyBlock key={st.studyInstanceUid} study={st} />
        ))}
      </div>
    </aside>
  );
}
