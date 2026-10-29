/**
 * Production Content-Security-Policy (sent as a response header by the app:// protocol and embedded as a
 * <meta> tag in the built index.html). 'wasm-unsafe-eval' is required only to instantiate the WebAssembly image
 * codecs (JPEG-LS, JPEG 2000, HTJ2K, JPEG baseline); data: images are used by the loader for colour JPEG decoding.
 */
const DIRECTIVES = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
];

/** Header form (includes frame-ancestors, which browsers ignore in <meta>). */
export const CSP = [...DIRECTIVES, "frame-ancestors 'none'"].join('; ');
/** <meta> form embedded in index.html. */
export const CSP_META = DIRECTIVES.join('; ');
