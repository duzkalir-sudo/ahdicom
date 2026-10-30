/**
 * Read-only inspection hooks for the E2E suite. Installed only when the main process reports e2e mode
 * (CDV_E2E=1 in an unpackaged build); never available in packaged builds.
 */
import { getShouldUseCPURendering } from '@cornerstonejs/core';
import { useStore } from './state/store';
import { cacheUsage } from './viewer/cornerstone';
import { controllerAt } from './viewer/registry';
import { listMeasurements } from './viewer/annotations';

export function installTestHooks(): void {
  (window as unknown as { __cdv: unknown }).__cdv = {
    state: () => {
      const s = useStore.getState();
      return {
        ready: s.ready,
        studies: s.studies.map((st) => ({
          patientName: st.patientName,
          series: st.series.map((se) => ({
            description: se.seriesDescription,
            displaySets: se.displaySets.map((d) => ({
              id: d.id,
              images: d.images.length,
              kind: d.kind,
              warnings: d.warnings.map((w) => w.code),
            })),
          })),
        })),
        slots: s.slots.slice(0, 25),
        activeIndex: s.activeIndex,
        layout: s.layout,
        scans: Object.keys(s.scans).length,
        lastSummary: s.lastSummary,
      };
    },
    viewport: (i: number) => {
      const c = controllerAt(i);
      if (!c) return undefined;
      const { probe, ...rest } = c.getState();
      return { ...rest, probe };
    },
    /** Client (page) coordinates of an image pixel centre in viewport i. */
    pixelToClient: (i: number, column: number, row: number) => {
      const c = controllerAt(i);
      const el = document.querySelector(`[data-testid="viewport-element-${i}"]`);
      const p = c?.pixelToCanvas(column, row);
      if (!p || !el) return undefined;
      const r = el.getBoundingClientRect();
      return { x: r.left + p[0], y: r.top + p[1] };
    },
    cpuRendering: () => getShouldUseCPURendering(),
    /** Measurements with their displayed value lines. */
    measurements: () => listMeasurements(),
    calibrations: () => useStore.getState().calibrations,
    /** Image cache + raw-bytes usage in bytes. */
    cacheBytes: () => cacheUsage().used,
    /**
     * Scroll benchmark: advances viewport i one image at a time, waiting for each image to be rendered,
     * and returns rendered images per second (what a user sees while scrolling a loaded series).
     */
    scrollBenchmark: async (i: number, n: number): Promise<number> => {
      const c = controllerAt(i);
      const el = document.querySelector(`[data-testid="viewport-element-${i}"]`);
      if (!c || !el) return 0;
      const rendered = (): Promise<void> =>
        new Promise((resolve) => {
          const done = (): void => {
            el.removeEventListener('CORNERSTONE_IMAGE_RENDERED', done);
            resolve();
          };
          el.addEventListener('CORNERSTONE_IMAGE_RENDERED', done);
          setTimeout(done, 1000);
        });
      c.scrollTo(0);
      await rendered();
      const start = performance.now();
      for (let k = 0; k < n; k++) {
        const r = rendered();
        c.scrollBy(1);
        await r;
      }
      return n / ((performance.now() - start) / 1000);
    },
  };
}
