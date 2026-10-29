/** Status bar, start screen, splash and notices. */
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, Disc3, FileArchive, FilePlus2, FolderOpen, Info, Network, ShieldAlert, Trash2, X } from 'lucide-react';
import { formatDicomDate, formatPersonName } from '@ahdicom/dicom-core';
import { openKind } from '../app/commands';
import { useStore } from '../state/store';
import { cacheUsage, usesCpuRendering } from '../viewer/cornerstone';

export function StatusBar(): ReactNode {
  const { t } = useTranslation();
  const scans = useStore((s) => s.scans);
  const summary = useStore((s) => s.lastSummary);
  const ready = useStore((s) => s.ready);
  const [usage, setUsage] = useState({ used: 0, max: 0, heap: 0 });

  useEffect(() => {
    if (!ready) return;
    const tick = (): void => {
      const u = cacheUsage();
      const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
      setUsage({ used: u.used, max: u.max, heap: mem?.usedJSHeapSize ?? 0 });
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [ready]);

  const scan = Object.values(scans)[0];
  let text: string = t('status.ready');
  if (scan) {
    text =
      scan.phase === 'listing'
        ? t('status.listing', { found: scan.filesFound })
        : scan.phase === 'extracting'
          ? t('status.extracting')
          : t('status.parsing', { done: scan.filesDone, found: scan.filesFound });
  } else if (summary) {
    const errorCount = Object.values(summary.errors).reduce((a, b) => a + (b ?? 0), 0);
    if (summary.cancelled) text = t('status.cancelled');
    else if (summary.instances === 0) text = t('status.nothing');
    else text = errorCount + summary.notDicom > 0 ? t('status.doneSkipped', { count: summary.instances, skipped: errorCount + summary.notDicom }) : t('status.done', { count: summary.instances });
    if (summary.usedDicomdir) text += ` · ${t('status.dicomdir')}`;
  }
  const mb = (b: number): number => Math.round(b / (1024 * 1024));
  const pct = scan && scan.filesFound > 0 ? (100 * scan.filesDone) / scan.filesFound : 0;
  return (
    <footer className="statusbar" data-testid="statusbar">
      <span className="grow" data-testid="status-text">
        {text}
      </span>
      {scan ? (
        <>
          <span className="progress" aria-hidden>
            <span style={{ width: `${pct}%` }} />
          </span>
          <button type="button" className="link-btn" onClick={() => void window.api.cancelScan(scan.scanId)} data-testid="scan-cancel">
            {t('status.cancel')}
          </button>
        </>
      ) : null}
      {ready && usesCpuRendering() ? (
        <span className="badge-intended" data-testid="cpu-rendering" title={t('app.cpuRendering')}>
          {t('app.cpuRenderingShort')}
        </span>
      ) : null}
      <span className="num" data-testid="cache-usage">
        {t('status.cache', { used: mb(usage.used), max: mb(usage.max) })}
      </span>
      {usage.heap ? <span className="num">{t('status.memory', { value: mb(usage.heap) })}</span> : null}
      <button type="button" className="badge-intended" onClick={() => useStore.getState().setDialog('about')} data-testid="intended-badge">
        <ShieldAlert size={13} /> {t('app.intendedUseShort')}
      </button>
    </footer>
  );
}

/** Local calendar date (YYYYMMDD) of an ISO timestamp. */
function localDa(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

export function StartScreen(): ReactNode {
  const { t, i18n } = useTranslation();
  const locale = (i18n.language === 'en' ? 'en' : 'tr') as 'tr' | 'en';
  const recent = useStore((s) => s.recent);
  const hide = useStore((s) => s.settings.hidePatientData);
  const [over, setOver] = useState(false);

  useEffect(() => {
    void window.api.recentList().then((r) => useStore.getState().setRecent(r));
  }, []);

  return (
    <div className="start" data-testid="start-screen">
      <div className="start-inner">
        <div
          className={`dropzone${over ? ' over' : ''}`}
          onDragEnter={() => setOver(true)}
          onDragLeave={() => setOver(false)}
          onDrop={() => setOver(false)}
          data-testid="dropzone"
        >
          <FolderOpen size={40} strokeWidth={1.5} className="muted" />
          <h1>{t('start.title')}</h1>
          <p>{t('start.subtitle')}</p>
          <div className="start-actions">
            <button type="button" className="big-btn primary" onClick={() => void openKind('files')} data-testid="start-open-files">
              <FilePlus2 size={20} />
              <span>{t('start.openFiles')}</span>
            </button>
            <button type="button" className="big-btn" onClick={() => void openKind('folder')} data-testid="start-open-folder">
              <FolderOpen size={20} />
              <span>{t('start.openFolder')}</span>
            </button>
            <button type="button" className="big-btn" onClick={() => void openKind('dicomdir')} data-testid="start-open-dicomdir">
              <Disc3 size={20} />
              <span>{t('start.openDicomdir')}</span>
            </button>
            <button type="button" className="big-btn" onClick={() => void openKind('zip')} data-testid="start-open-zip">
              <FileArchive size={20} />
              <span>{t('start.openZip')}</span>
            </button>
            <button type="button" className="big-btn" disabled>
              <Archive size={20} />
              <span>
                {t('start.archive')}
                <span className="sub">{t('start.later')}</span>
              </span>
            </button>
            <button type="button" className="big-btn" disabled>
              <Network size={20} />
              <span>
                {t('start.pacs')}
                <span className="sub">{t('start.later')}</span>
              </span>
            </button>
          </div>
        </div>
        <div className="recent">
          <h2>{t('start.recent')}</h2>
          {recent.length === 0 ? (
            <div className="empty-note" data-testid="recent-empty">
              {t('start.recentEmpty')}
            </div>
          ) : (
            <div className="recent-list" data-testid="recent-list">
              {recent.map((r) => (
                <div key={r.id} style={{ display: 'flex', gap: 4 }}>
                  <button
                    type="button"
                    className="recent-item"
                    onClick={() => {
                      void window.api.recentOpen(r.id).then((res) => {
                        if (res.started) useStore.getState().setScan({ scanId: res.scanId, phase: 'listing', filesFound: 0, filesDone: 0, instances: 0, skipped: 0 });
                      });
                    }}
                  >
                    <span style={{ minWidth: 0 }}>
                      <span className="name" style={{ display: 'block' }}>
                        {hide ? t('viewport.hidden') : formatPersonName(r.patientName, locale) || '—'}
                      </span>
                      <span className="meta" style={{ display: 'block' }}>
                        {[formatDicomDate(r.studyDate, locale), r.modalities.join('/'), r.studyDescription].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span className="meta num">{t('start.images', { count: r.instanceCount })}</span>
                    <span className="meta">{formatDicomDate(localDa(r.openedAt), locale)}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    data-tip={t('start.remove')}
                    data-tip-pos="left"
                    aria-label={t('start.remove')}
                    onClick={() => void window.api.recentRemove(r.id).then((list) => useStore.getState().setRecent(list))}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function Splash(): ReactNode {
  const { t } = useTranslation();
  return (
    <div className="splash" data-testid="splash">
      <div className="splash-card">
        <div className="brand-mark">A</div>
        <h1>{t('app.name')}</h1>
        <div className="intended-box" style={{ textAlign: 'left' }}>
          <p>
            <strong>{t('app.intendedUseFull')}</strong>
          </p>
          <p>{t('app.intendedUseOther')}</p>
        </div>
        <div className="muted">{t('app.loading')}</div>
      </div>
    </div>
  );
}

export function Notices(): ReactNode {
  const notices = useStore((s) => s.notices);
  return (
    <div className="notices" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className={`notice ${n.kind}`} data-testid={`notice-${n.kind}`}>
          <Info size={14} />
          <span className="text">{n.text}</span>
          <button type="button" className="link-btn" aria-label="×" onClick={() => useStore.getState().dismissNotice(n.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
