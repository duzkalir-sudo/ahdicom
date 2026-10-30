import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';

interface Tip {
  text: string;
  /** Horizontal centre and edge (top or bottom) of the hovered element. */
  x: number;
  y: number;
  above: boolean;
}

/**
 * Instant tooltips for every element with a `data-tip` attribute (no hover delay). Rendered in a fixed layer so
 * containers with `overflow: hidden` (toolbar, panels) cannot clip them.
 */
export function TooltipLayer(): ReactNode {
  const [tip, setTip] = useState<Tip | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(0);

  useEffect(() => {
    let current: Element | null = null;
    const show = (e: MouseEvent): void => {
      const el = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
      if (el === current) return;
      current = el;
      const text = el?.getAttribute('data-tip');
      if (!el || !text) {
        setTip(null);
        return;
      }
      const r = el.getBoundingClientRect();
      const above = r.bottom + 44 > window.innerHeight;
      setTip({ text, x: r.left + r.width / 2, y: above ? r.top - 6 : r.bottom + 6, above });
    };
    const hide = (): void => {
      current = null;
      setTip(null);
    };
    document.addEventListener('mouseover', show);
    document.addEventListener('mousedown', hide, true);
    document.documentElement.addEventListener('mouseleave', hide);
    window.addEventListener('blur', hide);
    window.addEventListener('wheel', hide, { passive: true });
    return () => {
      document.removeEventListener('mouseover', show);
      document.removeEventListener('mousedown', hide, true);
      document.documentElement.removeEventListener('mouseleave', hide);
      window.removeEventListener('blur', hide);
      window.removeEventListener('wheel', hide);
    };
  }, []);

  // Keep the tooltip inside the window horizontally.
  useLayoutEffect(() => {
    if (!tip || !ref.current) return;
    const w = ref.current.offsetWidth;
    setLeft(Math.min(Math.max(4, tip.x - w / 2), window.innerWidth - w - 4));
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={ref}
      className="tooltip"
      role="tooltip"
      data-testid="tooltip"
      style={{ left, top: tip.above ? undefined : tip.y, bottom: tip.above ? window.innerHeight - tip.y : undefined }}
    >
      {tip.text}
    </div>
  );
}
