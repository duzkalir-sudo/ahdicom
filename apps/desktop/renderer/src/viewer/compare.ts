/**
 * Prior/current comparison: the current series next to the matching series of the patient's previous study, linked.
 */
import { type DisplaySet, type StudyNode, planeKind } from '@ahdicom/dicom-core';
import { displaySetAt, useStore } from '../state/store';
import { controllerAt } from './registry';
import { setLinked } from './sync';

const studyKey = (s: StudyNode): string => `${s.studyDate ?? ''}${s.studyTime ?? ''}`;

/** The most recent earlier study of the same patient (same Patient ID), or undefined. */
export function priorStudy(studies: readonly StudyNode[], current: StudyNode): StudyNode | undefined {
  if (!current.patientId || !current.studyDate) return undefined;
  const samePatient = (s: StudyNode): boolean =>
    s.patientId === current.patientId && (!s.patientName || !current.patientName || s.patientName === current.patientName);
  const older = studies.filter((s) => s !== current && samePatient(s) && Boolean(s.studyDate) && studyKey(s) < studyKey(current));
  return older.sort((a, b) => (studyKey(a) < studyKey(b) ? 1 : -1))[0];
}

function imageSets(study: StudyNode): DisplaySet[] {
  return study.series.flatMap((se) => se.displaySets).filter((d) => d.kind !== 'nonImage');
}

/** Series of the prior study that best matches: same modality and plane, then the same description. */
export function bestMatch(current: DisplaySet, prior: StudyNode): DisplaySet | undefined {
  const sets = imageSets(prior);
  const score = (d: DisplaySet): number =>
    (d.modality === current.modality ? 4 : 0) +
    (planeKind(d.firstInstance) === planeKind(current.firstInstance) ? 2 : 0) +
    ((d.seriesDescription ?? '').trim().toUpperCase() === (current.seriesDescription ?? '').trim().toUpperCase() ? 1 : 0);
  return [...sets].sort((a, b) => score(b) - score(a))[0];
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function untilReady(index: number, dsId: string): Promise<boolean> {
  const deadline = performance.now() + 15000;
  while (performance.now() < deadline) {
    const c = controllerAt(index);
    if (c?.displaySet?.id === dsId && c.hasImage()) return true;
    await nextFrame();
  }
  return false;
}

/**
 * Shows the current series (the active one if it belongs to the study) and the best-matching prior series side by
 * side at the same relative slice position, then links them so that scrolling keeps that offset.
 */
export async function compareWithPrior(studyInstanceUid: string): Promise<void> {
  const s = useStore.getState();
  const study = s.studies.find((x) => x.studyInstanceUid === studyInstanceUid);
  if (!study) return;
  const prior = priorStudy(s.studies, study);
  if (!prior) return;
  const active = displaySetAt(s.activeIndex);
  const current = active && active.studyInstanceUid === studyInstanceUid ? active : imageSets(study)[0];
  const match = current ? bestMatch(current, prior) : undefined;
  if (!current || !match) return;
  setLinked(false);
  s.setLayout({ kind: 'grid', rows: 1, cols: 2 });
  s.assign(0, current.id);
  s.assign(1, match.id);
  s.setActive(0);
  if (!(await untilReady(0, current.id)) || !(await untilReady(1, match.id))) return;
  const a = controllerAt(0)!;
  const b = controllerAt(1)!;
  // The layout changed: fit both images to their (now narrower) viewports.
  await nextFrame();
  a.fit();
  b.fit();
  const fraction = a.getState().total > 1 ? a.getState().index / (a.getState().total - 1) : 0.5;
  b.scrollTo(Math.round(fraction * Math.max(0, b.getState().total - 1)));
  await nextFrame();
  await nextFrame();
  setLinked(true);
}
