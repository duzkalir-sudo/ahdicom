/**
 * Opaque file-id registry. The renderer only ever sees ids; paths stay in the main process.
 * Only files that were indexed as DICOM by a scan the user started are registered.
 */
export class FileRegistry {
  private readonly byId = new Map<string, string>();

  register(id: string, filePath: string): void {
    this.byId.set(id, filePath);
  }

  path(id: string): string | undefined {
    return this.byId.get(id);
  }

  clear(): void {
    this.byId.clear();
  }

  get size(): number {
    return this.byId.size;
  }
}
