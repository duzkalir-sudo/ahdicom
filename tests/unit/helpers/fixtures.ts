import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseInstance, type ParseResult } from '@clinic/dicom-core';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'generated');

export interface ManifestEntry {
  id: string;
  dir: string;
  description: string;
  kind: 'valid' | 'malformed' | 'nonDicom' | 'archive';
  files: number;
  expect?: Record<string, unknown>;
}

export function manifest(): ManifestEntry[] {
  return (JSON.parse(readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8')) as { fixtures: ManifestEntry[] }).fixtures;
}

export function filesIn(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(path.join(FIXTURES, dir));
  return out.sort();
}

export const inflater = (bytes: Uint8Array, position: number): Uint8Array => {
  const head = bytes.subarray(0, position);
  const body = inflateRawSync(bytes.subarray(position));
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
};

export function parseFile(file: string): ParseResult {
  const bytes = new Uint8Array(readFileSync(file));
  return parseInstance(bytes, { fileId: path.basename(file), fileName: path.basename(file), fileSize: bytes.length, inflater });
}
