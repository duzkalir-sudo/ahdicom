/**
 * Fails when a shipped runtime dependency has a license outside the CLAUDE.md allow-list.
 *
 * "Shipped" = every npm package whose code ends up in the main, preload, renderer or worker bundles. The build
 * records them in apps/desktop/out/bundle-manifests/*.json (see apps/desktop/build/bundle-manifest.ts), because the
 * app ships no node_modules (D-005). User-approved exceptions live in license-exceptions.json.
 *
 * Usage: npm run license:check   (requires a prior `npm run build`)
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ALLOWED = new Set(['MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'ISC', '0BSD', 'Zlib', 'BlueOak-1.0.0']);

interface ManifestEntry {
  name: string;
  version: string;
  license: string;
  dir: string;
}

interface Exception {
  name: string;
  license: string;
  approved: string;
}

const root = path.resolve(import.meta.dirname, '..');
const manifestDir = path.join(root, 'apps', 'desktop', 'out', 'bundle-manifests');

/** Evaluates an SPDX expression: OR needs one allowed operand, AND needs all; parentheses supported. */
export function spdxAllowed(expr: string): boolean {
  const tokens = expr.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').split(/\s+/).filter(Boolean);
  let pos = 0;
  const parseAtom = (): boolean => {
    const t = tokens[pos++];
    if (t === '(') {
      const v = parseOr();
      pos++;
      return v;
    }
    return t !== undefined && ALLOWED.has(t.replace(/\+$/, ''));
  };
  const parseAnd = (): boolean => {
    let v = parseAtom();
    while (tokens[pos] === 'AND') {
      pos++;
      const r = parseAtom();
      v = v && r;
    }
    return v;
  };
  const parseOr = (): boolean => {
    let v = parseAnd();
    while (tokens[pos] === 'OR') {
      pos++;
      const r = parseAnd();
      v = v || r;
    }
    return v;
  };
  const result = parseOr();
  return result && pos === tokens.length;
}

function main(): void {
  if (!existsSync(manifestDir)) {
    console.error(`No bundle manifests in ${path.relative(root, manifestDir)} — run "npm run build" first.`);
    process.exit(2);
  }
  const exceptions = (JSON.parse(readFileSync(path.join(root, 'license-exceptions.json'), 'utf8')) as { exceptions: Exception[] }).exceptions;
  const shipped = new Map<string, ManifestEntry & { bundles: string[] }>();
  for (const file of readdirSync(manifestDir).filter((f) => f.endsWith('.json'))) {
    const bundle = path.basename(file, '.json');
    for (const e of JSON.parse(readFileSync(path.join(manifestDir, file), 'utf8')) as ManifestEntry[]) {
      if (e.name.startsWith('@ahdicom/')) continue;
      const key = `${e.name}@${e.version}`;
      const cur = shipped.get(key);
      if (cur) cur.bundles.push(bundle);
      else shipped.set(key, { ...e, bundles: [bundle] });
    }
  }
  if (shipped.size === 0) {
    console.error('Bundle manifests are empty — the build did not record any packages.');
    process.exit(2);
  }

  const violations: string[] = [];
  const excepted: string[] = [];
  const counts = new Map<string, number>();
  for (const [key, e] of shipped) {
    counts.set(e.license, (counts.get(e.license) ?? 0) + 1);
    if (spdxAllowed(e.license)) continue;
    const ex = exceptions.find((x) => x.name === e.name && x.license === e.license);
    if (ex) excepted.push(`${key} (${e.license}) [${e.bundles.join(', ')}] — approved: ${ex.approved}`);
    else violations.push(`${key} (${e.license}) in ${e.bundles.join(', ')}`);
  }

  console.log(`Shipped packages checked: ${shipped.size}`);
  for (const [lic, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${lic}: ${n}`);
  if (excepted.length) console.log(`Approved exceptions:\n  ${excepted.join('\n  ')}`);
  if (violations.length) {
    console.error(`License violations (${violations.length}):\n  ${violations.join('\n  ')}`);
    process.exit(1);
  }
  writeNotices([...shipped.values()]);
  console.log('license:check OK');
}

/** Writes THIRD_PARTY_NOTICES.txt (packaged with the app) from the shipped packages' license files. */
function writeNotices(entries: ManifestEntry[]): void {
  const parts: string[] = ['Third-party software included in AHDicom', ''];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    let text = '';
    try {
      const file = readdirSync(e.dir).find((f) => /^(licen[sc]e|copying)(\.|$)/i.test(f));
      if (file) text = readFileSync(path.join(e.dir, file), 'utf8').trim();
    } catch {
      text = '';
    }
    parts.push('='.repeat(78), `${e.name} ${e.version} — ${e.license}`, '='.repeat(78), text || `License: ${e.license}`, '');
  }
  writeFileSync(path.join(root, 'apps', 'desktop', 'out', 'THIRD_PARTY_NOTICES.txt'), parts.join('\n'));
}

main();
