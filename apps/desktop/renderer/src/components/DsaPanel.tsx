/** DSA controls of the active viewport: mask frame, mask shift (manual and automatic). */
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react';
import { useStore } from '../state/store';
import { controllerAt } from '../viewer/registry';
import { useActiveState } from './VolumePanel';

export function DsaPanel(): ReactNode {
  const { t, i18n } = useTranslation();
  const index = useStore((s) => s.activeIndex);
  const vs = useActiveState(index);
  const [busy, setBusy] = useState(false);
  const c = controllerAt(index);
  const dsa = vs?.dsa;
  if (!c || !vs || !dsa) {
    return (
      <div className="panel-pad muted" data-testid="dsa-inactive">
        {t('dsa.inactive')}
      </div>
    );
  }
  const nf = new Intl.NumberFormat(i18n.language === 'tr' ? 'tr-TR' : 'en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const step = (dx: number, dy: number): void => c.shiftDsa(dx, dy);
  const arrows: [ReactNode, number, number, string][] = [
    [<ArrowLeft key="l" size={16} />, -1, 0, 'left'],
    [<ArrowRight key="r" size={16} />, 1, 0, 'right'],
    [<ArrowUp key="u" size={16} />, 0, -1, 'up'],
    [<ArrowDown key="d" size={16} />, 0, 1, 'down'],
  ];
  return (
    <div className="panel-pad vr-panel" data-testid="dsa-panel">
      <div className="field">
        <label htmlFor="dsa-mask">{t('dsa.mask')}</label>
        <input
          id="dsa-mask"
          className="input"
          type="number"
          min={1}
          max={vs.total}
          value={dsa.mask + 1}
          onChange={(e) => Number.isFinite(e.target.valueAsNumber) && void c.setDsa({ mask: e.target.valueAsNumber - 1, shift: dsa.shift })}
          data-testid="dsa-mask"
        />
      </div>
      <div className="vr-actions">
        <button
          type="button"
          className="btn"
          onClick={() => void c.setDsa({ mask: vs.index, shift: dsa.shift })}
          data-testid="dsa-mask-current"
        >
          {t('dsa.maskCurrent')}
        </button>
      </div>
      <div className="vr-section">{t('dsa.shift')}</div>
      <div className="muted" data-testid="dsa-shift">
        {t('dsa.shiftValue', { x: nf.format(dsa.shift[0]), y: nf.format(dsa.shift[1]) })}
      </div>
      {[1, 0.1].map((size) => (
        <div className="vr-actions" key={size}>
          {arrows.map(([icon, dx, dy, name]) => (
            <button
              key={name}
              type="button"
              className="btn"
              aria-label={t(`dsa.move.${name}`, { size: nf.format(size) })}
              data-tip={t(`dsa.move.${name}`, { size: nf.format(size) })}
              onClick={() => step(dx * size, dy * size)}
              data-testid={`dsa-${name}-${size === 1 ? '1' : '01'}`}
            >
              {icon}
              {size === 1 ? null : <span className="small">{nf.format(size)}</span>}
            </button>
          ))}
        </div>
      ))}
      <div className="vr-actions">
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void c.autoDsaShift().finally(() => setBusy(false));
          }}
          data-testid="dsa-auto"
        >
          {t('dsa.auto')}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void c.setDsa({ mask: dsa.mask, shift: [0, 0] })}
          data-testid="dsa-reset-shift"
        >
          {t('dsa.resetShift')}
        </button>
      </div>
      <div className="vr-actions">
        <button type="button" className="btn" onClick={() => void c.setDsa(undefined)} data-testid="dsa-off">
          {t('dsa.off')}
        </button>
      </div>
      <div className="menu-hint">{t(dsa.mode === 'log' ? 'dsa.modeLog' : 'dsa.modeLinear')}</div>
      <div className="menu-hint">{t('dsa.hint')}</div>
    </div>
  );
}
