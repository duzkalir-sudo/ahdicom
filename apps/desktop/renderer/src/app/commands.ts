/**
 * Command table: every user action with its default keyboard shortcut.
 * Used by the keyboard handler, toolbar tooltips, the context menu and the cheat sheet.
 */
import { CT_PRESETS } from '@ahdicom/dicom-core';
import { i18next } from '../i18n';
import { displaySetAt, useStore } from '../state/store';
import { purgeAll, setLeftTool, type LeftTool } from '../viewer/cornerstone';
import { allControllers, controllerAt } from '../viewer/registry';
import type { OpenKind } from '../../../shared/schemas';

export const isMac = navigator.userAgent.includes('Mac');
export const MOD = isMac ? '⌘' : 'Ctrl';

export interface Shortcut {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export function formatShortcut(s: Shortcut | undefined): string {
  if (!s) return '';
  const parts: string[] = [];
  if (s.mod) parts.push(MOD);
  if (s.shift) parts.push('Shift');
  if (s.alt) parts.push(isMac ? '⌥' : 'Alt');
  const names: Record<string, string> = {
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    PageUp: 'PgUp',
    PageDown: 'PgDn',
    ' ': 'Space',
    Escape: 'Esc',
  };
  parts.push(names[s.key] ?? (s.key.length === 1 ? s.key.toUpperCase() : s.key));
  return parts.join('+');
}

const active = () => controllerAt(useStore.getState().activeIndex);

export async function openKind(kind: OpenKind): Promise<void> {
  const r = await window.api.open(kind);
  if (r.started) useStore.getState().setScan({ scanId: r.scanId, phase: 'listing', filesFound: 0, filesDone: 0, instances: 0, skipped: 0 });
}

export function selectTool(tool: LeftTool): void {
  setLeftTool(tool);
  useStore.getState().setTool(tool);
}

export function applyPreset(id: string): void {
  const c = active();
  const ds = displaySetAt(useStore.getState().activeIndex);
  if (!c || !ds) return;
  const ct = CT_PRESETS.find((p) => p.id === id);
  if (ct) {
    c.setWindow({ center: ct.center, width: ct.width });
    return;
  }
  const user = useStore.getState().settings.userPresets.find((p) => p.id === id);
  if (user) c.setWindow({ center: user.center, width: user.width });
}

export function toggleCine(): void {
  const s = useStore.getState();
  const c = active();
  if (!c) return;
  const on = c.toggleCine(c.getState().fps || s.settings.cineFps, s.settings.cineMode);
  s.setCine(s.activeIndex, on);
}

export async function toggleFullscreen(): Promise<void> {
  await window.api.setFullscreen('toggle');
}

export async function closeAll(): Promise<void> {
  for (const c of allControllers()) c.stopCine();
  await window.api.clearSession();
  useStore.getState().clearAll();
  // Viewports unmount with the start screen; release cached pixels afterwards.
  setTimeout(purgeAll, 0);
}

export interface Command {
  id: string;
  labelKey: string;
  group: 'navigation' | 'view' | 'tools' | 'window' | 'general';
  shortcut?: Shortcut;
  /** Extra shortcuts that trigger the same action (not shown in tooltips). */
  alt?: Shortcut[];
  run(): void;
}

export const COMMANDS: Command[] = [
  {
    id: 'next',
    labelKey: 'shortcuts.nextImage',
    group: 'navigation',
    shortcut: { key: 'ArrowDown' },
    alt: [{ key: 'ArrowRight' }],
    run: () => active()?.scrollBy(1),
  },
  {
    id: 'prev',
    labelKey: 'shortcuts.nextImage',
    group: 'navigation',
    shortcut: { key: 'ArrowUp' },
    alt: [{ key: 'ArrowLeft' }],
    run: () => active()?.scrollBy(-1),
  },
  {
    id: 'pageDown',
    labelKey: 'shortcuts.pageImage',
    group: 'navigation',
    shortcut: { key: 'PageDown' },
    run: () => active()?.scrollBy(10),
  },
  { id: 'pageUp', labelKey: 'shortcuts.pageImage', group: 'navigation', shortcut: { key: 'PageUp' }, run: () => active()?.scrollBy(-10) },
  { id: 'first', labelKey: 'shortcuts.firstLast', group: 'navigation', shortcut: { key: 'Home' }, run: () => active()?.scrollTo(0) },
  {
    id: 'last',
    labelKey: 'shortcuts.firstLast',
    group: 'navigation',
    shortcut: { key: 'End' },
    run: () => active()?.scrollTo(Number.MAX_SAFE_INTEGER),
  },
  { id: 'cine', labelKey: 'toolbar.cine', group: 'navigation', shortcut: { key: ' ' }, run: toggleCine },
  {
    id: 'nextViewport',
    labelKey: 'shortcuts.activeViewport',
    group: 'navigation',
    shortcut: { key: 'Tab' },
    run: () => {
      const s = useStore.getState();
      const n = s.layout.kind === 'grid' ? s.layout.rows * s.layout.cols : 3;
      s.setActive((s.activeIndex + 1) % n);
    },
  },
  { id: 'toolWL', labelKey: 'toolbar.windowLevel', group: 'tools', shortcut: { key: 'w' }, run: () => selectTool('windowLevel') },
  { id: 'toolPan', labelKey: 'toolbar.pan', group: 'tools', shortcut: { key: 'p' }, run: () => selectTool('pan') },
  { id: 'toolZoom', labelKey: 'toolbar.zoom', group: 'tools', shortcut: { key: 'z' }, run: () => selectTool('zoom') },
  { id: 'toolScroll', labelKey: 'toolbar.scroll', group: 'tools', shortcut: { key: 's' }, run: () => selectTool('scroll') },
  { id: 'rotateCw', labelKey: 'toolbar.rotateCw', group: 'view', shortcut: { key: 'r' }, run: () => active()?.rotate(90) },
  { id: 'rotateCcw', labelKey: 'toolbar.rotateCcw', group: 'view', shortcut: { key: 'r', shift: true }, run: () => active()?.rotate(-90) },
  { id: 'flipH', labelKey: 'toolbar.flipH', group: 'view', shortcut: { key: 'h' }, run: () => active()?.flip('h') },
  { id: 'flipV', labelKey: 'toolbar.flipV', group: 'view', shortcut: { key: 'v' }, run: () => active()?.flip('v') },
  { id: 'invert', labelKey: 'toolbar.invert', group: 'view', shortcut: { key: 'i' }, run: () => active()?.invert() },
  { id: 'fit', labelKey: 'toolbar.fit', group: 'view', shortcut: { key: 'f' }, run: () => active()?.fit() },
  { id: 'oneToOne', labelKey: 'toolbar.oneToOne', group: 'view', shortcut: { key: '1', alt: true }, run: () => active()?.oneToOne() },
  { id: 'reset', labelKey: 'toolbar.reset', group: 'view', shortcut: { key: 'Backspace' }, run: () => active()?.reset() },
  { id: 'zoomIn', labelKey: 'toolbar.zoom', group: 'view', shortcut: { key: '+' }, alt: [{ key: '=' }], run: () => active()?.zoomBy(1.25) },
  { id: 'zoomOut', labelKey: 'toolbar.zoom', group: 'view', shortcut: { key: '-' }, run: () => active()?.zoomBy(0.8) },
  {
    id: 'overlay',
    labelKey: 'toolbar.overlays',
    group: 'view',
    shortcut: { key: 'o' },
    run: () => useStore.getState().toggleInfoOverlay(),
  },
  {
    id: 'dicomOverlay',
    labelKey: 'toolbar.dicomOverlays',
    group: 'view',
    shortcut: { key: 'o', shift: true },
    run: () => useStore.getState().toggleDicomOverlays(),
  },
  {
    id: 'hidePatient',
    labelKey: 'toolbar.hidePatient',
    group: 'view',
    shortcut: { key: 'a' },
    run: () =>
      void window.api
        .setSettings({ hidePatientData: !useStore.getState().settings.hidePatientData })
        .then((s) => useStore.getState().setSettings(s)),
  },
  {
    id: 'defaultWindow',
    labelKey: 'shortcuts.defaultWindow',
    group: 'window',
    shortcut: { key: '0' },
    run: () => active()?.defaultWindow(),
  },
  ...CT_PRESETS.map((p): Command => ({
    id: `preset:${p.id}`,
    labelKey: p.labelKey,
    group: 'window',
    shortcut: p.key ? { key: p.key } : undefined,
    run: () => applyPreset(p.id),
  })),
  {
    id: 'windowDialog',
    labelKey: 'toolbar.windowDialog',
    group: 'window',
    shortcut: { key: 'l' },
    run: () => useStore.getState().setDialog('windowLevel'),
  },
  {
    id: 'openFiles',
    labelKey: 'shortcuts.openFiles',
    group: 'general',
    shortcut: { key: 'o', mod: true },
    run: () => void openKind('files'),
  },
  {
    id: 'openFolder',
    labelKey: 'shortcuts.openFolder',
    group: 'general',
    shortcut: { key: 'o', mod: true, shift: true },
    run: () => void openKind('folder'),
  },
  { id: 'fullscreen', labelKey: 'toolbar.fullscreen', group: 'general', shortcut: { key: 'F11' }, run: () => void toggleFullscreen() },
  {
    id: 'distractionFree',
    labelKey: 'toolbar.distractionFree',
    group: 'general',
    shortcut: { key: 'F10' },
    run: () => useStore.getState().setDistractionFree(!useStore.getState().distractionFree),
  },
  {
    id: 'help',
    labelKey: 'toolbar.help',
    group: 'general',
    shortcut: { key: 'F1' },
    alt: [{ key: '?', shift: true }, { key: '?' }],
    run: () => useStore.getState().setDialog('shortcuts'),
  },
  {
    id: 'settings',
    labelKey: 'toolbar.settings',
    group: 'general',
    shortcut: { key: ',', mod: true },
    run: () => useStore.getState().setDialog('settings'),
  },
];

export function commandById(id: string): Command | undefined {
  return COMMANDS.find((c) => c.id === id);
}

export function tooltip(labelKey: string, commandId?: string): string {
  const label = i18next.t(labelKey);
  const sc = commandId ? formatShortcut(commandById(commandId)?.shortcut) : '';
  return sc ? `${label} (${sc})` : label;
}

function matches(s: Shortcut, e: KeyboardEvent): boolean {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (Boolean(s.mod) !== mod) return false;
  if (Boolean(s.alt) !== e.altKey) return false;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  // For printable keys shift changes the character itself (e.g. '?'), so only enforce shift for letters/named keys.
  if (s.key.length === 1 && !/[a-z0-9]/.test(s.key)) return key === s.key;
  if (Boolean(s.shift) !== e.shiftKey) return false;
  return key === s.key;
}

/** Handles a keydown; returns true when a command ran. */
export function handleKey(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return false;
  if (e.key === 'Escape') {
    const s = useStore.getState();
    if (s.dialog) s.setDialog(null);
    else if (s.distractionFree) s.setDistractionFree(false);
    else if (s.fullscreen) void window.api.setFullscreen(false);
    return true;
  }
  if (useStore.getState().dialog) return false;
  for (const c of COMMANDS) {
    if ((c.shortcut && matches(c.shortcut, e)) || c.alt?.some((a) => matches(a, e))) {
      c.run();
      return true;
    }
  }
  return false;
}
