import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { bundleManifest } from './build/bundle-manifest';
import { CSP_META } from './shared/csp';

/** Embeds the production CSP as a meta tag (the dev server uses a relaxed header CSP instead). */
const cspMeta: Plugin = {
  name: 'cdv-csp-meta',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<head>', `<head>
    <meta http-equiv="Content-Security-Policy" content="${CSP_META}" />`),
};

const out = resolve(__dirname, 'out');
// Manifests are rebuilt on every build.
rmSync(resolve(out, 'bundle-manifests'), { recursive: true, force: true });

export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      outDir: resolve(out, 'main'),
      rollupOptions: { input: { index: resolve(__dirname, 'main/index.ts') } },
    },
    plugins: [bundleManifest('main', out)],
  },
  preload: {
    build: {
      externalizeDeps: false,
      outDir: resolve(out, 'preload'),
      rollupOptions: {
        input: { index: resolve(__dirname, 'preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
    plugins: [bundleManifest('preload', out)],
  },
  renderer: {
    root: resolve(__dirname, 'renderer'),
    base: './',
    build: {
      outDir: resolve(out, 'renderer'),
      target: 'chrome140',
      chunkSizeWarningLimit: 8000,
      rollupOptions: { input: { index: resolve(__dirname, 'renderer/index.html') } },
    },
    plugins: [react(), cspMeta, bundleManifest('renderer', out)],
    worker: {
      format: 'es',
      plugins: () => [bundleManifest('renderer-worker', out)],
    },
    resolve: {
      alias: [{ find: /^(fs|path|url)$/, replacement: resolve(__dirname, 'renderer/src/node-stub.ts') }],
      // One dcmjs instance for our code and Cornerstone's metadata package (shared logger configuration).
      dedupe: ['dcmjs'],
    },
    optimizeDeps: {
      exclude: ['@cornerstonejs/dicom-image-loader'],
      include: ['dicom-parser'],
    },
  },
});
