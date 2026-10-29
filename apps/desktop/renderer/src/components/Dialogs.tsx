import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rangeToWindow, windowToRange } from '@clinic/dicom-core';
import { COMMANDS, formatShortcut } from '../app/commands';
import { setLanguage } from '../i18n';
import { useStore } from '../state/store';
import { setCacheSize } from '../viewer/cornerstone';
import { controllerAt } from '../viewer/registry';
import type { Settings, SettingsPatch } from '../../../shared/schemas';
import { Modal, Segmented } from './ui';

async function patchSettings(p: SettingsPatch): Promise<void> {
  const next = await window.api.setSettings(p);
  useStore.getState().setSettings(next);
}

function AboutDialog(): ReactNode {
  const { t } = useTranslation();
  const info = useStore((s) => s.appInfo);
  const close = (): void => useStore.getState().setDialog(null);
  return (
    <Modal title={t('dialogs.aboutTitle')} onClose={close} testId="about-dialog" footer={<button type="button" className="btn primary" onClick={close}>{t('dialogs.close')}</button>}>
      <div style={{ fontSize: 16, fontWeight: 600 }}>{t('app.name')}</div>
      <div className="muted">{info ? t('dialogs.version', { version: info.version }) : ''}</div>
      <div className="intended-box">
        <p>
          <strong>{t('app.intendedUseFull')}</strong>
        </p>
        <p>{t('app.intendedUseOther')}</p>
      </div>
      <p className="muted">{t('dialogs.privacy')}</p>
      <p className="muted">{t('dialogs.licenses')}</p>
      {info ? <p className="muted num">{t('dialogs.components', { electron: info.electron, chrome: info.chrome, node: info.node })}</p> : null}
    </Modal>
  );
}

function ShortcutsDialog(): ReactNode {
  const { t } = useTranslation();
  const close = (): void => useStore.getState().setDialog(null);
  const groups = ['navigation', 'tools', 'view', 'window', 'general'] as const;
  // Merge commands that share a label (e.g. next/previous) into one row.
  const rows = (g: (typeof groups)[number]): { label: string; keys: string[] }[] => {
    const map = new Map<string, string[]>();
    for (const c of COMMANDS.filter((x) => x.group === g && x.shortcut)) {
      const label = t(c.labelKey);
      map.set(label, [...(map.get(label) ?? []), formatShortcut(c.shortcut)]);
    }
    return [...map].map(([label, keys]) => ({ label, keys }));
  };
  return (
    <Modal title={t('dialogs.shortcutsTitle')} onClose={close} wide testId="shortcuts-dialog">
      <div className="shortcut-grid">
        {groups.map((g) => (
          <div key={g}>
            <div className="section-title" style={{ marginTop: 0 }}>
              {t(`shortcuts.${g}`)}
            </div>
            {[...rows(g), ...(g === 'general' ? [{ label: t('shortcuts.escape'), keys: ['Esc'] }] : [])].map((r) => (
              <div className="shortcut-row" key={r.label}>
                <span>{r.label}</span>
                <span>
                  {r.keys.map((k) => (
                    <kbd key={k} style={{ marginLeft: 4 }}>
                      {k}
                    </kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}

function SettingsDialog(): ReactNode {
  const { t } = useTranslation();
  const s = useStore((st) => st.settings);
  const close = (): void => useStore.getState().setDialog(null);
  const overlayKeys: (keyof Settings['overlay'])[] = ['patient', 'study', 'series', 'image', 'windowLevel', 'zoom', 'orientation', 'scaleBar', 'probe'];
  const cap = (k: string): string => k.charAt(0).toUpperCase() + k.slice(1);
  return (
    <Modal title={t('dialogs.settingsTitle')} onClose={close} wide testId="settings-dialog" footer={<button type="button" className="btn primary" onClick={close}>{t('dialogs.close')}</button>}>
      <div className="row2">
        <div>
          <div className="section-title" style={{ marginTop: 0 }}>
            {t('settings.appearance')}
          </div>
          <div className="field">
            <label>{t('settings.theme')}</label>
            <Segmented
              value={s.theme}
              options={[
                { value: 'dark', label: t('settings.themeDark') },
                { value: 'light', label: t('settings.themeLight') },
                { value: 'system', label: t('settings.themeSystem') },
              ]}
              onChange={(theme) => void patchSettings({ theme })}
            />
          </div>
          <div className="field">
            <label>{t('settings.language')}</label>
            <Segmented
              value={s.language}
              options={[
                { value: 'tr', label: t('languageNames.tr') },
                { value: 'en', label: t('languageNames.en') },
              ]}
              onChange={(language) => {
                void patchSettings({ language });
                void setLanguage(language);
              }}
            />
          </div>
          <label className="check">
            <input type="checkbox" checked={s.hidePatientData} onChange={(e) => void patchSettings({ hidePatientData: e.target.checked })} />
            {t('settings.hidePatient')}
          </label>
          <label className="check">
            <input type="checkbox" checked={s.showMouseLegend} onChange={(e) => void patchSettings({ showMouseLegend: e.target.checked })} />
            {t('settings.mouseLegend')}
          </label>
          <div className="section-title">{t('settings.performance')}</div>
          <div className="field">
            <label htmlFor="cache-size">{t('settings.cacheSize')}</label>
            <input
              id="cache-size"
              className="input num"
              type="number"
              min={256}
              max={32768}
              step={256}
              defaultValue={s.cacheSizeMB}
              onBlur={(e) => {
                const v = Math.min(32768, Math.max(256, Math.round(Number(e.target.value) / 256) * 256));
                if (Number.isFinite(v)) {
                  void patchSettings({ cacheSizeMB: v });
                  setCacheSize(v);
                }
              }}
            />
          </div>
          <div className="section-title">{t('settings.cine')}</div>
          <div className="row2">
            <div className="field">
              <label htmlFor="cine-fps">{t('settings.cineFps')}</label>
              <input
                id="cine-fps"
                className="input num"
                type="number"
                min={1}
                max={120}
                defaultValue={s.cineFps}
                onBlur={(e) => {
                  const v = Math.min(120, Math.max(1, Number(e.target.value)));
                  if (Number.isFinite(v)) void patchSettings({ cineFps: v });
                }}
              />
            </div>
            <div className="field">
              <label>{t('settings.cineMode')}</label>
              <Segmented
                value={s.cineMode}
                options={[
                  { value: 'loop', label: t('settings.loop') },
                  { value: 'bounce', label: t('settings.bounce') },
                ]}
                onChange={(cineMode) => void patchSettings({ cineMode })}
              />
            </div>
          </div>
        </div>
        <div>
          <div className="section-title" style={{ marginTop: 0 }}>
            {t('settings.overlay')}
          </div>
          {overlayKeys.map((k) => (
            <label className="check" key={k}>
              <input type="checkbox" checked={s.overlay[k]} onChange={(e) => void patchSettings({ overlay: { [k]: e.target.checked } })} />
              {t(`settings.overlay${cap(k)}`)}
            </label>
          ))}
          <div className="section-title">{t('settings.userPresets')}</div>
          {s.userPresets.length === 0 ? <div className="muted">{t('settings.noUserPresets')}</div> : null}
          {s.userPresets.map((p) => (
            <div key={p.id} className="shortcut-row">
              <span>
                {p.name} <span className="muted num">{`${p.width} / ${p.center}`}</span>
              </span>
              <button type="button" className="link-btn" onClick={() => void patchSettings({ userPresets: s.userPresets.filter((x) => x.id !== p.id) })}>
                {t('settings.delete')}
              </button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function WindowLevelDialog(): ReactNode {
  const { t } = useTranslation();
  const activeIndex = useStore((s) => s.activeIndex);
  const settings = useStore((s) => s.settings);
  const c = controllerAt(activeIndex);
  const vs = c?.getState();
  const fn = vs?.voiFn === 'LINEAR_EXACT' ? 'LINEAR_EXACT' : 'LINEAR';
  const valuesFor = (m: 'window' | 'range'): [string, string] => {
    if (!vs?.voi) return ['', ''];
    const r2 = (v: number): string => String(Math.round(v * 100) / 100);
    if (m === 'range') return [r2(vs.voi.lower), r2(vs.voi.upper)];
    const wl = rangeToWindow(vs.voi, fn);
    return [r2(wl.width), r2(wl.center)];
  };
  const [mode, setModeState] = useState<'window' | 'range'>('window');
  const [a, setA] = useState(() => valuesFor('window')[0]);
  const [b, setB] = useState(() => valuesFor('window')[1]);
  const [name, setName] = useState('');
  const setMode = (m: 'window' | 'range'): void => {
    setModeState(m);
    const [na0, nb0] = valuesFor(m);
    setA(na0);
    setB(nb0);
  };
  const close = (): void => useStore.getState().setDialog(null);
  const na = Number(a.replace(',', '.'));
  const nb = Number(b.replace(',', '.'));
  const valid = Number.isFinite(na) && Number.isFinite(nb) && (mode === 'window' ? na >= 1 : nb > na);
  const apply = (): void => {
    if (!valid || !c) return;
    if (mode === 'window') c.setWindow({ width: na, center: nb });
    else c.setRange({ lower: na, upper: nb });
    close();
  };
  const save = (): void => {
    if (!valid || !name.trim()) return;
    const wl = mode === 'window' ? { width: na, center: nb } : rangeToWindow({ lower: na, upper: nb }, fn);
    void patchSettings({
      userPresets: [...settings.userPresets, { id: `u${Date.now()}`, name: name.trim().slice(0, 64), width: wl.width, center: wl.center }].slice(-50),
    });
    apply();
  };
  return (
    <Modal
      title={t('dialogs.wlTitle')}
      onClose={close}
      testId="wl-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            {t('dialogs.cancel')}
          </button>
          <button type="button" className="btn primary" onClick={apply} disabled={!valid} data-testid="wl-apply">
            {t('dialogs.apply')}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <div className="field">
          <Segmented
            value={mode}
            options={[
              { value: 'window', label: t('dialogs.wlByWindow') },
              { value: 'range', label: t('dialogs.wlByRange') },
            ]}
            onChange={setMode}
          />
        </div>
        <div className="row2">
          <div className="field">
            <label htmlFor="wl-a">{mode === 'window' ? t('dialogs.width') : t('dialogs.lower')}</label>
            <input id="wl-a" className="input num" value={a} onChange={(e) => setA(e.target.value)} inputMode="decimal" data-testid="wl-a" />
          </div>
          <div className="field">
            <label htmlFor="wl-b">{mode === 'window' ? t('dialogs.center') : t('dialogs.upper')}</label>
            <input id="wl-b" className="input num" value={b} onChange={(e) => setB(e.target.value)} inputMode="decimal" data-testid="wl-b" />
          </div>
        </div>
        {valid && mode === 'window' ? (
          <div className="muted num" style={{ marginBottom: 10 }}>
            {(() => {
              const r = windowToRange({ width: na, center: nb }, fn);
              return t('viewport.range', { lower: Math.round(r.lower * 100) / 100, upper: Math.round(r.upper * 100) / 100 });
            })()}
          </div>
        ) : null}
        <div className="row2">
          <div className="field">
            <label htmlFor="wl-name">{t('dialogs.presetName')}</label>
            <input id="wl-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
          </div>
          <div className="field" style={{ alignSelf: 'end' }}>
            <button type="button" className="btn" onClick={save} disabled={!valid || !name.trim()}>
              {t('dialogs.savePreset')}
            </button>
          </div>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function PasswordDialog(): ReactNode {
  const { t } = useTranslation();
  const req = useStore((s) => s.zipRequest);
  const [pw, setPw] = useState('');
  if (!req) return null;
  const answer = (value: string | null): void => {
    void window.api.answerZipPassword(req.requestId, value);
    useStore.getState().setZipRequest(undefined);
    setPw('');
  };
  return (
    <Modal
      title={t('dialogs.passwordTitle')}
      onClose={() => answer(null)}
      testId="password-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={() => answer(null)}>
            {t('dialogs.cancel')}
          </button>
          <button type="button" className="btn primary" onClick={() => answer(pw)} disabled={!pw} data-testid="password-ok">
            {t('dialogs.ok')}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (pw) answer(pw);
        }}
      >
        <p style={{ marginTop: 0 }}>{t('dialogs.passwordPrompt', { name: req.archiveName })}</p>
        {req.retry ? <p style={{ color: 'var(--danger)' }}>{t('dialogs.passwordRetry')}</p> : null}
        <div className="field">
          <label htmlFor="zip-pw">{t('dialogs.password')}</label>
          <input id="zip-pw" className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="off" data-testid="password-input" />
        </div>
      </form>
    </Modal>
  );
}

export function Dialogs(): ReactNode {
  const dialog = useStore((s) => s.dialog);
  return (
    <>
      {dialog === 'about' ? <AboutDialog /> : null}
      {dialog === 'shortcuts' ? <ShortcutsDialog /> : null}
      {dialog === 'settings' ? <SettingsDialog /> : null}
      {dialog === 'windowLevel' ? <WindowLevelDialog /> : null}
      <PasswordDialog />
    </>
  );
}
