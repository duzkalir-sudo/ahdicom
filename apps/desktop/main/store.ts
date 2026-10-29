/** Settings and recent-studies persistence (JSON in userData, zod-validated, versioned). */
import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_SETTINGS,
  RecentFileSchema,
  SETTINGS_VERSION,
  SettingsSchema,
  type RecentEntry,
  type RecentEntryPublic,
  type Settings,
  type SettingsPatch,
} from '../shared/schemas';

async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, file);
}

/**
 * Migrations from older settings versions. Each step takes the previous object and returns the next version.
 * Version 1 is the first released schema, so the table is empty; unknown/invalid data falls back to defaults.
 */
const MIGRATIONS: Record<number, (s: Record<string, unknown>) => Record<string, unknown>> = {};

export function migrateSettings(raw: unknown): Settings {
  if (!raw || typeof raw !== 'object') return structuredClone(DEFAULT_SETTINGS);
  let obj = raw as Record<string, unknown>;
  let v = typeof obj.version === 'number' ? obj.version : 0;
  while (v < SETTINGS_VERSION && MIGRATIONS[v]) {
    obj = MIGRATIONS[v]!(obj);
    v++;
  }
  // Merge onto defaults so newly added fields get default values.
  const merged = {
    ...DEFAULT_SETTINGS,
    ...obj,
    version: SETTINGS_VERSION,
    overlay: { ...DEFAULT_SETTINGS.overlay, ...((obj.overlay as object | undefined) ?? {}) },
  };
  const parsed = SettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : structuredClone(DEFAULT_SETTINGS);
}

export class SettingsStore {
  private current: Settings = structuredClone(DEFAULT_SETTINGS);
  constructor(
    private readonly file: string,
    private readonly onChange?: (s: Settings) => void,
  ) {}

  async load(): Promise<Settings> {
    try {
      this.current = migrateSettings(JSON.parse(await readFile(this.file, 'utf8')));
    } catch {
      this.current = structuredClone(DEFAULT_SETTINGS);
    }
    return this.current;
  }

  get(): Settings {
    return this.current;
  }

  async patch(p: SettingsPatch): Promise<Settings> {
    const next = SettingsSchema.parse({
      ...this.current,
      ...p,
      version: SETTINGS_VERSION,
      overlay: { ...this.current.overlay, ...(p.overlay ?? {}) },
    });
    this.current = next;
    await atomicWrite(this.file, JSON.stringify(next, null, 2));
    this.onChange?.(next);
    return next;
  }
}

export const MAX_RECENT = 20;

export class RecentStore {
  private entries: RecentEntry[] = [];
  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const parsed = RecentFileSchema.safeParse(JSON.parse(await readFile(this.file, 'utf8')));
      this.entries = parsed.success ? parsed.data.entries : [];
    } catch {
      this.entries = [];
    }
  }

  list(): RecentEntryPublic[] {
    return this.entries.map(({ roots: _roots, ...rest }) => rest);
  }

  get(id: string): RecentEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  async add(entry: Omit<RecentEntry, 'id' | 'openedAt'>): Promise<void> {
    const key = (e: Pick<RecentEntry, 'roots'>): string => e.roots.map((r) => path.resolve(r)).sort().join('|');
    const k = key(entry);
    this.entries = this.entries.filter((e) => key(e) !== k);
    this.entries.unshift({ ...entry, id: randomBytes(8).toString('hex'), openedAt: new Date().toISOString() });
    this.entries = this.entries.slice(0, MAX_RECENT);
    await this.save();
  }

  async remove(id: string): Promise<void> {
    this.entries = this.entries.filter((e) => e.id !== id);
    await this.save();
  }

  private async save(): Promise<void> {
    await atomicWrite(this.file, JSON.stringify({ version: 1, entries: this.entries }, null, 2));
  }
}
