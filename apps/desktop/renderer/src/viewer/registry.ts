/** Live viewport controllers by viewport index (kept outside React state to avoid render loops). */
import type { ViewportController } from './controller';

const controllers = new Map<number, ViewportController>();
const changeListeners = new Set<() => void>();

export function registerController(index: number, c: ViewportController): void {
  controllers.set(index, c);
  for (const l of changeListeners) l();
}

export function unregisterController(index: number, c: ViewportController): void {
  if (controllers.get(index) === c) controllers.delete(index);
  for (const l of changeListeners) l();
}

export function controllerAt(index: number): ViewportController | undefined {
  return controllers.get(index);
}

export function allControllers(): ViewportController[] {
  return [...controllers.values()];
}

export function onControllersChanged(l: () => void): () => void {
  changeListeners.add(l);
  return () => changeListeners.delete(l);
}
