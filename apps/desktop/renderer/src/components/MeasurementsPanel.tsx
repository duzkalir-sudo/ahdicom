import { type ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Redo2, Ruler, Trash2, Undo2 } from 'lucide-react';
import { bulletVolume, ellipsoidVolume, formatNumber } from '@ahdicom/dicom-core';
import { commandById, formatShortcut } from '../app/commands';
import { useStore } from '../state/store';
import { listMeasurements, type MeasurementEntry } from '../viewer/annotations';
import { canRedo, canUndo, commit, redo, removeMeasurement, renameMeasurement, renderAll, undo } from '../viewer/measureDoc';
import { imageRef } from '../viewer/measurements';
import { jumpToMeasurement } from '../viewer/jump';
import { MEASURE_ICONS } from './Toolbar';
import { IconButton } from './ui';

interface Row extends MeasurementEntry {
  seriesLabel: string;
  imageIndex: number;
  imageTotal: number;
  sortKey: string;
}

function rowsFrom(entries: MeasurementEntry[]): Row[] {
  const out: Row[] = [];
  for (const e of entries) {
    const ref = imageRef(e.imageId);
    if (!ref) continue;
    const index = ref.ds.images.indexOf(ref.image);
    out.push({
      ...e,
      seriesLabel: [ref.ds.seriesNumber, ref.ds.seriesDescription].filter((v) => v !== undefined && v !== '').join(' · '),
      imageIndex: index + 1,
      imageTotal: ref.ds.images.length,
      sortKey: `${ref.ds.studyInstanceUid}|${String(ref.ds.seriesNumber ?? 0).padStart(6, '0')}|${ref.ds.id}|${String(index).padStart(6, '0')}`,
    });
  }
  // Stable within an image: creation order (Cornerstone keeps insertion order per tool).
  return out.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
}

function VolumeBox(props: { lengths: number[] }): ReactNode {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === 'en' ? 'en' : 'tr';
  const [a, b, c] = props.lengths as [number, number, number];
  // 1 cm³ = 1000 mm³ = 1 ml
  const ml = (mm3: number): string => `${formatNumber(mm3 / 1000, 2, locale)} cm³`;
  return (
    <div className="volume-box" data-testid="volume-box">
      <div className="section-title" style={{ marginTop: 0 }}>
        {t('measurements.volumeTitle')}
      </div>
      <div className="num muted">{props.lengths.map((v) => `${formatNumber(v, 1, locale)} mm`).join(' × ')}</div>
      <div className="kv-row">
        <span>{t('measurements.ellipsoid')}</span>
        <strong className="num" data-testid="volume-ellipsoid">
          {ml(ellipsoidVolume(a, b, c).value)}
        </strong>
      </div>
      <div className="kv-row">
        <span>{t('measurements.bullet')}</span>
        <strong className="num" data-testid="volume-bullet">
          {ml(bulletVolume(a, b, c).value)}
        </strong>
      </div>
    </div>
  );
}

function CalibrationList(): ReactNode {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === 'en' ? 'en' : 'tr';
  const calibrations = useStore((s) => s.calibrations);
  const displaySets = useStore((s) => s.displaySets);
  const series = new Map<string, string>();
  for (const ds of Object.values(displaySets)) {
    series.set(ds.seriesInstanceUid, [ds.seriesNumber, ds.seriesDescription].filter((v) => v !== undefined && v !== '').join(' · '));
  }
  const entries = Object.entries(calibrations).filter(([uid]) => series.has(uid));
  if (entries.length === 0) return null;
  return (
    <div data-testid="calibration-list">
      <div className="section-title">{t('measurements.calibrations')}</div>
      {entries.map(([uid, c]) => (
        <div className="measure-row compact" key={uid}>
          <div className="measure-main">
            <div className="measure-title">{series.get(uid)}</div>
            <div className="muted num">{`${formatNumber(c.rowMm, 4, locale)} × ${formatNumber(c.columnMm, 4, locale)} mm`}</div>
          </div>
          <IconButton
            tip={t('measurements.removeCalibration')}
            tipPos="left"
            onClick={() => {
              useStore.getState().setCalibration(uid, undefined);
              renderAll();
              commit();
            }}
            testId="calibration-remove"
          >
            <Trash2 size={15} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}

export function MeasurementsPanel(): ReactNode {
  const { t } = useTranslation();
  const rev = useStore((s) => s.measureRev);
  // The language changes value formatting; re-read on change as well.
  const lang = useStore((s) => s.settings.language);
  const rows = useMemo(() => rowsFrom(listMeasurements()), [rev, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const [editing, setEditing] = useState<{ uid: string; value: string } | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const counters = new Map<string, number>();
  const lengths = checked.map((uid) => rows.find((r) => r.uid === uid)?.lengthMm).filter((v): v is number => v !== undefined);
  const shortcut = (id: string): string => formatShortcut(commandById(id)?.shortcut);

  const header = (
    <div className="measure-toolbar">
      <IconButton tip={`${t('measurements.undo')} (${shortcut('undo')})`} onClick={undo} disabled={!canUndo()} testId="measure-undo">
        <Undo2 size={16} />
      </IconButton>
      <IconButton tip={`${t('measurements.redo')} (${shortcut('redo')})`} onClick={redo} disabled={!canRedo()} testId="measure-redo">
        <Redo2 size={16} />
      </IconButton>
      <span className="muted measure-count" data-testid="measure-count">
        {t('measurements.count', { count: rows.length })}
      </span>
    </div>
  );

  if (rows.length === 0) {
    return (
      <div className="panel-pad" data-testid="measurements-panel">
        {header}
        <div style={{ textAlign: 'center', paddingTop: 24 }}>
          <Ruler size={28} className="muted" />
          <div style={{ fontWeight: 600, marginTop: 8 }}>{t('measurements.empty')}</div>
          <div className="muted" style={{ marginTop: 4 }}>
            {t('measurements.emptyDetail')}
          </div>
        </div>
        <CalibrationList />
      </div>
    );
  }

  return (
    <div className="panel-pad" data-testid="measurements-panel">
      {header}
      <div className="measure-list">
        {rows.map((r) => {
          const n = (counters.get(r.tool) ?? 0) + 1;
          counters.set(r.tool, n);
          const Icon = MEASURE_ICONS[r.tool];
          const title = r.name ?? `${t(`measure.tool.${r.tool}`)} ${n}`;
          const value = r.tool === 'arrow' || r.tool === 'text' ? (r.label ?? '') : (r.lines[0] ?? '—');
          const isLength = r.tool === 'length' && r.lengthMm !== undefined;
          return (
            <div
              className="measure-row"
              key={r.uid}
              data-testid="measure-row"
              data-tool={r.tool}
              role="button"
              tabIndex={0}
              onClick={() => void jumpToMeasurement(r.uid, r.imageId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.target === e.currentTarget) void jumpToMeasurement(r.uid, r.imageId);
              }}
            >
              {isLength ? (
                <input
                  type="checkbox"
                  className="measure-check"
                  aria-label={t('measurements.selectForVolume')}
                  data-tip={t('measurements.selectForVolume')}
                  checked={checked.includes(r.uid)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) =>
                    setChecked((c) =>
                      e.target.checked ? [...c.filter((u) => u !== r.uid), r.uid].slice(-3) : c.filter((u) => u !== r.uid),
                    )
                  }
                  data-testid="measure-check"
                />
              ) : (
                <Icon size={16} className="measure-icon" aria-hidden />
              )}
              <div className="measure-main">
                {editing?.uid === r.uid ? (
                  <input
                    className="input measure-rename"
                    value={editing.value}
                    autoFocus
                    maxLength={100}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setEditing({ uid: r.uid, value: e.target.value })}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') {
                        renameMeasurement(r.uid, editing.value);
                        setEditing(null);
                      } else if (e.key === 'Escape') setEditing(null);
                    }}
                    onBlur={() => {
                      renameMeasurement(r.uid, editing.value);
                      setEditing(null);
                    }}
                    data-testid="measure-rename-input"
                  />
                ) : (
                  <div className="measure-title" title={title}>
                    {title}
                  </div>
                )}
                <div className="measure-value num" data-testid="measure-value">
                  {value}
                </div>
                <div className="muted measure-where">
                  {t('measurements.where', { series: r.seriesLabel, index: r.imageIndex, total: r.imageTotal })}
                </div>
              </div>
              {/* Buttons act on the row without also jumping to its image. */}
              <div className="measure-actions" onClick={(e) => e.stopPropagation()}>
                <IconButton
                  tip={t('measurements.rename')}
                  tipPos="left"
                  onClick={() => setEditing({ uid: r.uid, value: r.name ?? '' })}
                  testId="measure-rename"
                >
                  <Pencil size={14} />
                </IconButton>
                <IconButton tip={t('measurements.delete')} tipPos="left" onClick={() => removeMeasurement(r.uid)} testId="measure-delete">
                  <Trash2 size={14} />
                </IconButton>
              </div>
            </div>
          );
        })}
      </div>
      {lengths.length === 3 ? <VolumeBox lengths={lengths} /> : <div className="muted measure-hint">{t('measurements.volumeHint')}</div>}
      <CalibrationList />
    </div>
  );
}
