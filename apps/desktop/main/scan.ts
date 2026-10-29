/** Starts scan workers, registers indexed files and forwards progress to the renderer. */
import { randomBytes } from 'node:crypto';
import type { Worker } from 'node:worker_threads';
import type { WebContents } from 'electron';
import type { InstanceRecord } from '@clinic/dicom-core';
import createScanWorker from './scan-worker?nodeWorker';
import type { ScanWorkerInput, ScanWorkerMessage } from './scan-worker';
import type { FileRegistry } from './files';
import type { RecentStore } from './store';
import { EVENTS } from '../shared/channels';
import type { ScanSummary } from '../shared/api';
import type { RecentEntry } from '../shared/schemas';

interface ActiveScan {
  worker: Worker;
  target: WebContents;
  first?: InstanceRecord;
  modalities: Set<string>;
  roots: string[];
  kind: RecentEntry['kind'];
  recordRecent: boolean;
}

export class ScanManager {
  private readonly scans = new Map<string, ActiveScan>();
  private readonly passwordRequests = new Map<string, string>(); // requestId → scanId
  readonly tempDirs = new Set<string>();

  constructor(
    private readonly registry: FileRegistry,
    private readonly recent: RecentStore,
    private readonly tempRoot: string,
  ) {}

  start(target: WebContents, roots: string[], kind: RecentEntry['kind'], recordRecent = true): string {
    const scanId = randomBytes(8).toString('hex');
    const input: ScanWorkerInput = { scanId, roots, tempRoot: this.tempRoot };
    const worker = createScanWorker({ workerData: input });
    const scan: ActiveScan = { worker, target, modalities: new Set(), roots, kind, recordRecent };
    this.scans.set(scanId, scan);
    worker.on('message', (m: ScanWorkerMessage) => this.onMessage(scanId, scan, m));
    worker.on('error', () => this.finish(scanId, scan, undefined));
    worker.on('exit', () => {
      if (this.scans.has(scanId)) this.finish(scanId, scan, undefined);
    });
    return scanId;
  }

  private send(target: WebContents, channel: string, payload: unknown): void {
    if (!target.isDestroyed()) target.send(channel, payload);
  }

  private onMessage(scanId: string, scan: ActiveScan, m: ScanWorkerMessage): void {
    switch (m.type) {
      case 'progress':
        this.send(scan.target, EVENTS.scanProgress, { scanId, ...m, type: undefined });
        break;
      case 'tempDir':
        this.tempDirs.add(m.path);
        break;
      case 'batch': {
        const instances: InstanceRecord[] = [];
        for (const { path, instance } of m.items) {
          this.registry.register(instance.fileId, path);
          instances.push(instance);
          scan.first ??= instance;
          if (instance.modality) scan.modalities.add(instance.modality);
        }
        this.send(scan.target, EVENTS.scanBatch, { scanId, instances });
        break;
      }
      case 'needPassword':
        this.passwordRequests.set(m.requestId, scanId);
        this.send(scan.target, EVENTS.zipNeedPassword, { requestId: m.requestId, archiveName: m.archiveName, retry: m.retry });
        break;
      case 'done':
        this.finish(scanId, scan, { scanId, ...m.summary });
        break;
    }
  }

  private finish(scanId: string, scan: ActiveScan, summary: ScanSummary | undefined): void {
    if (!this.scans.delete(scanId)) return;
    const s: ScanSummary = summary ?? {
      scanId,
      instances: 0,
      notDicom: 0,
      errors: { readError: 1 },
      archiveErrors: [],
      cancelled: false,
      usedDicomdir: false,
      durationMs: 0,
    };
    this.send(scan.target, EVENTS.scanDone, s);
    void scan.worker.terminate();
    if (scan.recordRecent && scan.first && !s.cancelled) {
      const f = scan.first;
      void this.recent
        .add({
          kind: scan.kind,
          roots: scan.roots,
          patientName: f.patientName,
          patientId: f.patientId,
          studyDescription: f.studyDescription,
          studyDate: f.studyDate,
          modalities: [...scan.modalities].sort(),
          instanceCount: s.instances,
        })
        .catch(() => undefined);
    }
  }

  answerPassword(requestId: string, password: string | null): void {
    const scanId = this.passwordRequests.get(requestId);
    if (!scanId) return;
    this.passwordRequests.delete(requestId);
    this.scans.get(scanId)?.worker.postMessage({ type: 'password', requestId, password });
  }

  cancel(scanId: string): void {
    const scan = this.scans.get(scanId);
    if (!scan) return;
    void scan.worker.terminate();
    this.finish(scanId, scan, {
      scanId,
      instances: 0,
      notDicom: 0,
      errors: {},
      archiveErrors: [],
      cancelled: true,
      usedDicomdir: false,
      durationMs: 0,
    });
  }

  cancelAll(): void {
    for (const id of [...this.scans.keys()]) this.cancel(id);
  }
}
