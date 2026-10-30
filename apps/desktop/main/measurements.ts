/**
 * Measurement persistence: one JSON file per study in <userData>/measurements, named by a hash of the
 * Study Instance UID. Files are validated with zod on read; unreadable files are ignored, never trusted.
 * Original DICOM files are never modified.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MeasurementFileSchema, type MeasurementFile } from '../shared/schemas';

/** Largest measurement file read back (5000 items × 5000 points would exceed this; such files are refused). */
const MAX_FILE_BYTES = 16 * 1024 * 1024;

export class MeasurementStore {
  constructor(private readonly dir: string) {}

  private fileFor(studyInstanceUid: string): string {
    const name = createHash('sha256').update(studyInstanceUid).digest('hex').slice(0, 40);
    return path.join(this.dir, `${name}.json`);
  }

  async load(studyInstanceUid: string): Promise<MeasurementFile | null> {
    const file = this.fileFor(studyInstanceUid);
    try {
      const st = await stat(file);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
      const parsed = MeasurementFileSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
      if (!parsed.success || parsed.data.studyInstanceUid !== studyInstanceUid) {
        console.warn('Ignoring an invalid measurement file');
        return null;
      }
      return parsed.data;
    } catch {
      return null;
    }
  }

  async save(data: MeasurementFile): Promise<void> {
    const file = this.fileFor(data.studyInstanceUid);
    if (data.items.length === 0 && Object.keys(data.calibrations).length === 0) {
      await rm(file, { force: true });
      return;
    }
    const json = JSON.stringify(data);
    if (json.length > MAX_FILE_BYTES) throw new Error('measurement file too large');
    await mkdir(this.dir, { recursive: true });
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, json, 'utf8');
    await rename(tmp, file);
  }
}
