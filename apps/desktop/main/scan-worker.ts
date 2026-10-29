/**
 * Scan worker (Node worker thread). Lists files, expands DICOMDIR and ZIP archives, parses DICOM headers.
 * Runs off the Electron main thread so large folders never block the UI. Messages: see ScanWorkerMessage.
 */
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, open, opendir, readdir, readFile, stat } from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { inflateRawSync } from 'node:zlib';
import { BlobReader, ZipReader, configure, type Entry, type FileEntry } from '@zip.js/zip.js';
import { hasDicmPrefix, parseInstance, readDicomdir, type InstanceRecord } from '@clinic/dicom-core';
import type { ScanErrorCode, ScanSummary } from '../shared/api';
import { safeZipPath } from './zip-path';

configure({ useWebWorkers: false });

export interface ScanWorkerInput {
  scanId: string;
  roots: string[];
  /** Directory under which ZIP archives are extracted. */
  tempRoot: string;
}

export type ScanWorkerMessage =
  | { type: 'progress'; phase: 'listing' | 'extracting' | 'parsing'; filesFound: number; filesDone: number; instances: number; skipped: number }
  | { type: 'batch'; items: { path: string; instance: InstanceRecord }[] }
  | { type: 'needPassword'; requestId: string; archiveName: string; retry: boolean }
  | { type: 'tempDir'; path: string }
  | { type: 'done'; summary: Omit<ScanSummary, 'scanId'> };

type MainToWorker = { type: 'password'; requestId: string; password: string | null };

/** Limits for untrusted input (docs/RISK_REGISTER.md R-003, R-004). */
export const SCAN_LIMITS = {
  maxFiles: 500_000,
  maxDepth: 64,
  headerPrefixBytes: 256 * 1024,
  /** Largest header we are willing to read fully (enhanced multi-frame headers can be large). */
  maxHeaderBytes: 512 * 1024 * 1024,
  maxFileBytes: 4 * 1024 * 1024 * 1024,
  zipMaxEntries: 50_000,
  zipMaxTotalBytes: 16 * 1024 * 1024 * 1024,
  zipMaxEntryBytes: 4 * 1024 * 1024 * 1024,
  /** Entries larger than this with a compression ratio above zipMaxRatio are rejected as bombs. */
  zipBombMinBytes: 32 * 1024 * 1024,
  zipMaxRatio: 200,
  parallelReads: 8,
  batchSize: 200,
  batchIntervalMs: 150,
} as const;

const input = workerData as ScanWorkerInput;
const port = parentPort!;
const post = (m: ScanWorkerMessage): void => port.postMessage(m);

const files: string[] = [];
const seenFiles = new Set<string>();
const errors: Partial<Record<ScanErrorCode, number>> = {};
const archiveErrors: ScanSummary['archiveErrors'] = [];
let notDicom = 0;
let instancesCount = 0;
let filesDone = 0;
let usedDicomdir = false;
let phase: 'listing' | 'extracting' | 'parsing' = 'listing';
let lastProgress = 0;

function progress(force = false): void {
  const now = Date.now();
  if (!force && now - lastProgress < 100) return;
  lastProgress = now;
  post({ type: 'progress', phase, filesFound: files.length, filesDone, instances: instancesCount, skipped: notDicom + Object.values(errors).reduce((a, b) => a + b, 0) });
}

function addFile(p: string): void {
  if (files.length >= SCAN_LIMITS.maxFiles || seenFiles.has(p)) return;
  seenFiles.add(p);
  files.push(p);
}

async function walk(dir: string, depth: number): Promise<void> {
  if (depth > SCAN_LIMITS.maxDepth || files.length >= SCAN_LIMITS.maxFiles) return;
  let handle;
  try {
    handle = await opendir(dir);
  } catch {
    errors.readError = (errors.readError ?? 0) + 1;
    return;
  }
  for await (const ent of handle) {
    const p = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) continue; // never follow links out of the selected tree
    if (ent.isDirectory()) await walk(p, depth + 1);
    else if (ent.isFile()) {
      if (await isZip(p)) await expandZip(p);
      else addFile(p);
    }
    progress();
  }
}

/** Resolves DICOMDIR file IDs case-insensitively (CD/DVD file systems vary). */
async function resolveCaseInsensitive(base: string, parts: string[], cache: Map<string, Map<string, string>>): Promise<string | undefined> {
  let current = base;
  for (const part of parts) {
    let listing = cache.get(current);
    if (!listing) {
      listing = new Map();
      try {
        for (const name of await readdir(current)) listing.set(name.toUpperCase(), name);
      } catch {
        return undefined;
      }
      cache.set(current, listing);
    }
    const actual = listing.get(part.toUpperCase());
    if (!actual) return undefined;
    current = path.join(current, actual);
  }
  return current;
}

/** Returns true when the DICOMDIR resolved to at least one existing referenced file. */
async function useDicomdir(dicomdirPath: string): Promise<boolean> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(dicomdirPath));
  } catch {
    return false;
  }
  const r = readDicomdir(bytes);
  if (!r.ok || r.files.length === 0) return false;
  const base = path.dirname(dicomdirPath);
  const cache = new Map<string, Map<string, string>>();
  let found = 0;
  for (const parts of r.files) {
    const p = await resolveCaseInsensitive(base, parts, cache);
    if (p) {
      addFile(p);
      found++;
    }
  }
  if (found > 0) usedDicomdir = true;
  return found > 0;
}

async function isZip(p: string): Promise<boolean> {
  if (!/\.zip$/i.test(p)) return false;
  try {
    const fh = await open(p, 'r');
    const buf = Buffer.alloc(4);
    await fh.read(buf, 0, 4, 0);
    await fh.close();
    return buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  } catch {
    return false;
  }
}

const passwordWaiters = new Map<string, (pw: string | null) => void>();
port.on('message', (m: MainToWorker) => {
  if (m.type === 'password') {
    passwordWaiters.get(m.requestId)?.(m.password);
    passwordWaiters.delete(m.requestId);
  }
});

function askPassword(archiveName: string, retry: boolean): Promise<string | null> {
  const requestId = randomBytes(8).toString('hex');
  return new Promise((resolve) => {
    passwordWaiters.set(requestId, resolve);
    post({ type: 'needPassword', requestId, archiveName, retry });
  });
}

class LimitExceeded extends Error {}

async function writeEntry(entry: FileEntry, target: string, password: string | undefined, limit: number): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const out = createWriteStream(target);
  let written = 0;
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      written += chunk.length;
      if (written > limit) throw new LimitExceeded('entry too large');
      return new Promise<void>((resolve, reject) => out.write(chunk, (err) => (err ? reject(err) : resolve())));
    },
    close() {
      return new Promise<void>((resolve) => out.end(resolve));
    },
    abort() {
      out.destroy();
    },
  });
  await entry.getData(writable, password !== undefined ? { password } : {});
}

async function expandZip(zipPath: string): Promise<void> {
  phase = 'extracting';
  progress(true);
  const archiveName = path.basename(zipPath);
  const dest = path.join(input.tempRoot, `zip-${randomBytes(6).toString('hex')}`);
  await mkdir(dest, { recursive: true });
  post({ type: 'tempDir', path: dest });
  let reader: ZipReader<unknown> | undefined;
  try {
    reader = new ZipReader(new BlobReader(await openAsBlob(zipPath)));
    const entries: Entry[] = await reader.getEntries();
    if (entries.length > SCAN_LIMITS.zipMaxEntries) {
      archiveErrors.push('zipTooManyEntries');
      return;
    }
    const fileEntries = entries.filter((e): e is FileEntry => !e.directory);
    const total = fileEntries.reduce((s, e) => s + e.uncompressedSize, 0);
    const bomb = fileEntries.some(
      (e) => e.uncompressedSize > SCAN_LIMITS.zipBombMinBytes && e.uncompressedSize / Math.max(1, e.compressedSize) > SCAN_LIMITS.zipMaxRatio,
    );
    if (bomb || total > SCAN_LIMITS.zipMaxTotalBytes) {
      archiveErrors.push('zipBomb');
      return;
    }
    let password: string | undefined;
    let traversal = false;
    for (const e of fileEntries) {
      const parts = safeZipPath(e.filename);
      if (!parts) {
        traversal = true;
        continue;
      }
      const target = path.join(dest, ...parts);
      if (!path.resolve(target).startsWith(path.resolve(dest) + path.sep)) {
        traversal = true;
        continue;
      }
      const limit = Math.min(SCAN_LIMITS.zipMaxEntryBytes, e.uncompressedSize + 1024);
      for (let attempt = 0; ; attempt++) {
        if (e.encrypted && password === undefined) {
          const pw = await askPassword(archiveName, attempt > 0);
          if (pw === null) {
            archiveErrors.push('zipPasswordCancelled');
            return;
          }
          password = pw;
        }
        try {
          await writeEntry(e, target, e.encrypted ? password : undefined, limit);
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (e.encrypted && /password/i.test(msg) && attempt < 4) {
            password = undefined;
            continue;
          }
          if (e.encrypted && /password/i.test(msg)) {
            archiveErrors.push('zipPasswordWrong');
            return;
          }
          if (err instanceof LimitExceeded) {
            archiveErrors.push('zipBomb');
            return;
          }
          errors.readError = (errors.readError ?? 0) + 1;
          break;
        }
      }
      addFile(target);
      progress();
    }
    if (traversal) archiveErrors.push('zipTraversal');
  } catch (err) {
    // zip.js refuses archives with absolute or "../" entry names ("Unsafe filename"): reject the whole archive.
    archiveErrors.push(err instanceof Error && /unsafe/i.test(err.message) ? 'zipTraversal' : 'zipInvalid');
  } finally {
    await reader?.close().catch(() => undefined);
    phase = 'listing';
  }
}

const inflater = (bytes: Uint8Array, position: number): Uint8Array => {
  const head = bytes.subarray(0, position);
  const body = inflateRawSync(bytes.subarray(position), { maxOutputLength: SCAN_LIMITS.maxHeaderBytes * 2 });
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
};

async function readPrefix(p: string, size: number, max: number): Promise<Uint8Array> {
  const fh = await open(p, 'r');
  try {
    const len = Math.min(size, max);
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fh.read(buf, 0, len, 0);
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  } finally {
    await fh.close();
  }
}

function fileId(): string {
  return randomBytes(12).toString('base64url');
}

const batch: { path: string; instance: InstanceRecord }[] = [];
let lastBatch = Date.now();
function flush(force = false): void {
  if (batch.length === 0) return;
  if (!force && batch.length < SCAN_LIMITS.batchSize && Date.now() - lastBatch < SCAN_LIMITS.batchIntervalMs) return;
  post({ type: 'batch', items: batch.splice(0, batch.length) });
  lastBatch = Date.now();
}

async function parseOne(p: string): Promise<void> {
  try {
    const st = await stat(p);
    if (st.size < 132) {
      notDicom++;
      return;
    }
    if (st.size > SCAN_LIMITS.maxFileBytes) {
      errors.tooLarge = (errors.tooLarge ?? 0) + 1;
      return;
    }
    let bytes = await readPrefix(p, SCAN_LIMITS.headerPrefixBytes, st.size);
    if (!hasDicmPrefix(bytes)) {
      notDicom++;
      return;
    }
    const opts = { fileId: fileId(), fileName: path.basename(p), fileSize: st.size, inflater };
    let r = parseInstance(bytes, opts);
    if (!r.ok && r.error === 'truncated' && st.size > bytes.length) {
      bytes = await readPrefix(p, st.size, SCAN_LIMITS.maxHeaderBytes);
      r = parseInstance(bytes, opts);
    }
    if (r.ok) {
      instancesCount++;
      batch.push({ path: p, instance: r.instance });
      flush();
    } else {
      const code: ScanErrorCode = r.error === 'notDicom' ? 'notDicom' : r.error;
      if (code === 'notDicom') notDicom++;
      else errors[code] = (errors[code] ?? 0) + 1;
    }
  } catch {
    errors.readError = (errors.readError ?? 0) + 1;
  } finally {
    filesDone++;
    progress();
  }
}

async function main(): Promise<void> {
  const start = Date.now();
  for (const root of input.roots) {
    let st;
    try {
      st = await lstat(root);
    } catch {
      errors.readError = (errors.readError ?? 0) + 1;
      continue;
    }
    if (st.isDirectory()) {
      const names = await readdir(root).catch(() => [] as string[]);
      const dd = names.find((n) => n.toUpperCase() === 'DICOMDIR');
      if (!(dd && (await useDicomdir(path.join(root, dd))))) await walk(root, 0);
    } else if (st.isFile()) {
      if (path.basename(root).toUpperCase() === 'DICOMDIR') {
        if (!(await useDicomdir(root))) await walk(path.dirname(root), 0);
      } else if (await isZip(root)) await expandZip(root);
      else addFile(root);
    }
  }
  phase = 'parsing';
  progress(true);
  let next = 0;
  const workers = Array.from({ length: SCAN_LIMITS.parallelReads }, async () => {
    while (next < files.length) await parseOne(files[next++]!);
  });
  await Promise.all(workers);
  flush(true);
  progress(true);
  post({
    type: 'done',
    summary: { instances: instancesCount, notDicom, errors, archiveErrors, cancelled: false, usedDicomdir, durationMs: Date.now() - start },
  });
}

main().catch(() => {
  post({
    type: 'done',
    summary: { instances: instancesCount, notDicom, errors: { ...errors, readError: (errors.readError ?? 0) + 1 }, archiveErrors, cancelled: false, usedDicomdir, durationMs: 0 },
  });
});
