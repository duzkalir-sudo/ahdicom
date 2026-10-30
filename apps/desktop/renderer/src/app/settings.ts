import { setLanguage } from '../i18n';
import { useStore } from '../state/store';
import type { Settings, SettingsPatch } from '../../../shared/schemas';

/** Applies a settings change immediately (no snap-back of controlled inputs) and persists it through main. */
export async function patchSettings(p: SettingsPatch): Promise<void> {
  const cur = useStore.getState().settings;
  useStore.getState().setSettings({ ...cur, ...p, overlay: { ...cur.overlay, ...(p.overlay ?? {}) } } as Settings);
  try {
    useStore.getState().setSettings(await window.api.setSettings(p));
  } catch {
    useStore.getState().setSettings(cur);
  }
}

/** Switches the UI language between English and Turkish. */
export async function changeLanguage(language: Settings['language']): Promise<void> {
  await setLanguage(language);
  await patchSettings({ language });
}
