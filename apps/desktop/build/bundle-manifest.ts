/**
 * Rolldown/Vite plugin that records which npm packages end up in a bundle.
 * scripts/license-check.ts uses these manifests to check the licenses of what actually ships.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

function packageOf(id: string): { name: string; dir: string } | undefined {
  const norm = id.replace(/\\/g, '/').replace(/^\0/, '').split('?')[0]!;
  const idx = norm.lastIndexOf('/node_modules/');
  if (idx < 0) return undefined;
  const rest = norm.slice(idx + '/node_modules/'.length).split('/');
  const name = rest[0]!.startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]!;
  return { name, dir: norm.slice(0, idx + '/node_modules/'.length) + name };
}

export function bundleManifest(target: string, outRoot: string): Plugin {
  return {
    name: 'cdv-bundle-manifest',
    apply: 'build',
    generateBundle() {
      const pkgs = new Map<string, { name: string; version: string; license: string; dir: string }>();
      for (const id of this.getModuleIds()) {
        const p = packageOf(id);
        if (!p || pkgs.has(p.dir)) continue;
        try {
          const pj = JSON.parse(readFileSync(path.join(p.dir, 'package.json'), 'utf8')) as {
            name?: string;
            version?: string;
            license?: string | { type?: string };
          };
          const license = typeof pj.license === 'string' ? pj.license : (pj.license?.type ?? 'UNKNOWN');
          pkgs.set(p.dir, { name: pj.name ?? p.name, version: pj.version ?? '?', license, dir: p.dir });
        } catch {
          pkgs.set(p.dir, { name: p.name, version: '?', license: 'UNKNOWN', dir: p.dir });
        }
      }
      const dir = path.join(outRoot, 'bundle-manifests');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${target}.json`);
      let existing: { name: string; version: string; license: string; dir: string }[] = [];
      try {
        existing = JSON.parse(readFileSync(file, 'utf8')) as typeof existing;
      } catch {
        existing = [];
      }
      const all = new Map(existing.map((e) => [`${e.name}@${e.version}`, e]));
      for (const e of pkgs.values()) all.set(`${e.name}@${e.version}`, e);
      writeFileSync(file, JSON.stringify([...all.values()].sort((a, b) => a.name.localeCompare(b.name)), null, 2));
    },
  };
}
