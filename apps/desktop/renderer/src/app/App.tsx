import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialogs } from '../components/Dialogs';
import { RightPanel } from '../components/RightPanel';
import { SeriesBar } from '../components/SeriesBar';
import { Notices, Splash, StartScreen, StatusBar } from '../components/Shell';
import { Toolbar } from '../components/Toolbar';
import { ViewportGrid } from '../components/Viewport';
import { useStore } from '../state/store';
import { i18next } from '../i18n';
import { initCornerstone, usesCpuRendering } from '../viewer/cornerstone';
import { handleKey } from './commands';
import type { ScanSummary } from '../../../shared/api';

const SPLASH_MIN_MS = 900;

function useResolvedTheme(): void {
  const theme = useStore((s) => s.settings.theme);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (): void => {
      const resolved = theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme;
      document.documentElement.dataset.theme = resolved;
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}

function useApiEvents(): void {
  const { t } = useTranslation();
  useEffect(() => {
    const s = useStore.getState;
    const offs = [
      window.api.on('scan:progress', (p) => s().setScan(p)),
      window.api.on('scan:batch', (b) => s().addInstances(b.instances)),
      window.api.on('scan:done', (sum: ScanSummary) => {
        s().finishScan(sum);
        for (const code of new Set(sum.archiveErrors)) s().notify('error', t(`scanErrors.${code}`));
        const failed = Object.entries(sum.errors).reduce((a, [, n]) => a + (n ?? 0), 0);
        if (failed > 0) s().notify('warning', t('scanErrors.files', { count: failed }));
        if (!sum.cancelled && sum.instances === 0 && sum.archiveErrors.length === 0) s().notify('info', t('status.nothing'));
      }),
      window.api.on('zip:need-password', (r) => s().setZipRequest(r)),
      window.api.on('window:fullscreen-changed', (on) => s().setFullscreen(on)),
    ];
    return () => offs.forEach((off) => off());
  }, [t]);
}

export function App(): ReactNode {
  const { t } = useTranslation();
  const ready = useStore((s) => s.ready);
  const hasStudies = useStore((s) => s.studies.length > 0);
  const scanning = useStore((s) => Object.keys(s.scans).length > 0);
  const df = useStore((s) => s.distractionFree);
  const [splash, setSplash] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  useResolvedTheme();
  useApiEvents();

  useEffect(() => {
    const started = performance.now();
    initCornerstone(useStore.getState().settings.cacheSizeMB);
    useStore.getState().setReady(true);
    if (usesCpuRendering()) useStore.getState().notify('warning', i18next.t('app.cpuRendering'));
    const minMs = useStore.getState().appInfo?.splashMs ?? SPLASH_MIN_MS;
    const wait = Math.max(0, minMs - (performance.now() - started));
    const id = setTimeout(() => setSplash(false), wait);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (handleKey(e)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Drag & drop anywhere: files/folders from the OS.
  useEffect(() => {
    let depth = 0;
    const isFiles = (e: DragEvent): boolean => Boolean(e.dataTransfer?.types.includes('Files'));
    const onEnter = (e: DragEvent): void => {
      if (!isFiles(e)) return;
      depth++;
      setDragOver(true);
    };
    const onLeave = (e: DragEvent): void => {
      if (!isFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragOver(false);
    };
    const onOver = (e: DragEvent): void => {
      if (isFiles(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent): void => {
      if (!isFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragOver(false);
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      void window.api.openDropped(files).then((r) => {
        if (r.started) useStore.getState().setScan({ scanId: r.scanId, phase: 'listing', filesFound: 0, filesDone: 0, instances: 0, skipped: 0 });
      });
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  const showViewer = hasStudies || scanning;
  return (
    <div className={`app${df ? ' df' : ''}`} data-testid="app">
      <Toolbar />
      <div className="main">
        {showViewer ? <SeriesBar /> : <span />}
        <main className="view-area">{ready && showViewer ? <ViewportGrid /> : <StartScreen />}</main>
        {showViewer ? <RightPanel /> : <span />}
      </div>
      <StatusBar />
      <Dialogs />
      <Notices />
      {dragOver ? <div className="drop-veil">{t('start.dropHere')}</div> : null}
      {splash ? <Splash /> : null}
    </div>
  );
}
