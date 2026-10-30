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

  /**
   * Null when the study has no file, or when its content is invalid (that file is set aside). Throws when an existing
   * file cannot be read (locked, permissions): the renderer then leaves it untouched instead of overwriting it.
   */
  async load(studyInstanceUid: string): Promise<MeasurementFile | null> {
    const file = this.fileFor(studyInstanceUid);
    let text: string;
    try {
      const st = await stat(file);
      if (!st.isFile()) return null;
      if (st.size > MAX_FILE_BYTES) {
        await this.setAside(file);
        return null;
      }
      text = await readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('measurement file unreadable', { cause: e });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = undefined;
    }
    const parsed = MeasurementFileSchema.safeParse(raw);
    if (!parsed.success || parsed.data.studyInstanceUid !== studyInstanceUid) {
      await this.setAside(file);
      return null;
    }
    return parsed.data;
  }

  /**
   * Keeps an unreadable file (corrupt, or written by a newer version) under another name so the next save does not
   * overwrite it.
   */
  private async setAside(file: string): Promise<void> {
    console.warn('An unreadable measurement file was set aside');
    await rename(file, `${file}.unreadable-${Date.now()}`).catch(() => undefined);
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
