/** Shows the image a measurement belongs to in the active viewport and selects the measurement. */
import { annotation as csAnnotation } from '@cornerstonejs/tools';
import { useStore } from '../state/store';
import { imageRef } from './measurements';
import { controllerAt } from './registry';
import { renderAll } from './measureDoc';

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export async function jumpToMeasurement(uid: string, imageId: string): Promise<void> {
  const ref = imageRef(imageId);
  if (!ref) return;
  const index = ref.ds.images.indexOf(ref.image);
  const s = useStore.getState();
  // Prefer a viewport that already shows the series; otherwise load it into the active one.
  let vp = s.slots.findIndex((id, i) => id === ref.ds.id && controllerAt(i) !== undefined);
  if (vp < 0) {
    vp = s.activeIndex;
    s.assign(vp, ref.ds.id);
  }
  s.setActive(vp);
  const deadline = performance.now() + 15000;
  for (;;) {
    const c = controllerAt(vp);
    if (c?.displaySet?.id === ref.ds.id && c.hasImage()) {
      c.scrollTo(index);
      break;
    }
    if (performance.now() > deadline) return;
    await nextFrame();
  }
  csAnnotation.selection.setAnnotationSelected(uid, true, false);
  renderAll();
}
