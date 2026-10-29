/**
 * Electron hardening: custom app:// scheme, CSP, navigation/window/webview/permission blocking and
 * network blocking. See docs/DECISIONS.md D-008 and the Electron security checklist.
 */
import { app, protocol, session, type WebContents } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { RENDERER_ORIGIN } from '../shared/channels';
import { CSP } from '../shared/csp';

export { CSP };

export const DEV_SERVER_URL = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;

const DEV_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' http://localhost:*",
  "worker-src 'self' blob: http://localhost:*",
  "style-src 'self' 'unsafe-inline' http://localhost:*",
  "img-src 'self' data: blob: http://localhost:*",
  "font-src 'self' http://localhost:*",
  "connect-src 'self' http://localhost:* ws://localhost:*",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  ]);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Serves the built renderer from out/renderer via app://bundle/… (read-only, no traversal). */
export function registerAppProtocol(rendererDir: string): void {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    if (url.host !== 'bundle' || req.method !== 'GET') return new Response('Not found', { status: 404 });
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const target = path.resolve(rendererDir, `.${rel}`);
    const relative = path.relative(rendererDir, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return new Response('Bad request', { status: 400 });
    // Read directly from disk: net.fetch(file://) would go through the session, whose request filter blocks file://.
    const body = await readFile(target).catch(() => undefined);
    if (!body) return new Response('Not found', { status: 404 });
    const headers = new Headers({
      'Content-Type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    return new Response(new Uint8Array(body), { status: 200, headers });
  });
}

function isAllowedUrl(url: string): boolean {
  if (url.startsWith(`${RENDERER_ORIGIN}/`) || url === RENDERER_ORIGIN) return true;
  if (DEV_SERVER_URL && url.startsWith(new URL(DEV_SERVER_URL).origin)) return true;
  return false;
}

/** Session-wide policies: deny permissions, block all network requests, add CSP in dev. */
export function hardenSession(): void {
  const ses = session.defaultSession;
  // All web permissions are denied (clipboard writes go through the validated clipboard:write IPC instead).
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  // No network traffic: only the app bundle (and the dev server in development) may be requested.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const u = details.url;
    const ok = isAllowedUrl(u) || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('devtools://') || u.startsWith('chrome-extension://');
    callback({ cancel: !ok });
  });
  if (DEV_SERVER_URL) {
    ses.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [DEV_CSP] } });
    });
  }
}

/** Per-WebContents restrictions: no navigation, no new windows, no webviews. */
export function hardenWebContents(): void {
  app.on('web-contents-created', (_e, contents: WebContents) => {
    contents.on('will-navigate', (event, url) => {
      if (!isAllowedUrl(url)) event.preventDefault();
    });
    contents.on('will-redirect', (event, url) => {
      if (!isAllowedUrl(url)) event.preventDefault();
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

/** IPC sender validation: only our top-level renderer frame may call the API. */
export function isTrustedSender(frame: Electron.WebFrameMain | null | undefined): boolean {
  if (!frame) return false;
  if (frame.parent) return false;
  if (frame.origin === RENDERER_ORIGIN) return true;
  return Boolean(DEV_SERVER_URL && frame.origin === new URL(DEV_SERVER_URL).origin);
}
