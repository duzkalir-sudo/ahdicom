import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function IconButton(props: {
  tip: string;
  onClick?: () => void;
  pressed?: boolean;
  disabled?: boolean;
  children: ReactNode;
  tipPos?: 'top' | 'left';
  testId?: string;
  label?: string;
}): ReactNode {
  return (
    <button
      type="button"
      className="icon-btn"
      data-tip={props.tip}
      data-tip-pos={props.tipPos}
      aria-label={props.label ?? props.tip}
      aria-pressed={props.pressed === undefined ? undefined : props.pressed}
      // aria-disabled instead of disabled: disabled buttons receive no mouse events, so their tooltip would never show.
      aria-disabled={props.disabled ? true : undefined}
      onClick={props.disabled ? undefined : props.onClick}
      data-testid={props.testId}
    >
      {props.children}
    </button>
  );
}

/** A popover anchored below an element; closes on outside click or Escape. */
export function Popover(props: { anchor: HTMLElement | null; onClose: () => void; children: ReactNode; testId?: string }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });
  useLayoutEffect(() => {
    if (!props.anchor || !ref.current) return;
    const a = props.anchor.getBoundingClientRect();
    const w = ref.current.offsetWidth;
    const h = ref.current.offsetHeight;
    const left = Math.min(Math.max(4, a.left), window.innerWidth - w - 4);
    const top = a.bottom + h + 4 > window.innerHeight ? Math.max(4, a.top - h - 4) : a.bottom + 4;
    setPos({ left, top });
  }, [props.anchor]);
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node) && !props.anchor?.contains(e.target as Node)) props.onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [props]);
  return (
    <div ref={ref} className="popover" style={{ left: pos.left, top: pos.top }} role="menu" data-testid={props.testId}>
      {props.children}
    </div>
  );
}

/** Context menu at a screen point. */
export function PointMenu(props: { x: number; y: number; onClose: () => void; children: ReactNode }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: props.x, top: props.y });
  useLayoutEffect(() => {
    if (!ref.current) return;
    const w = ref.current.offsetWidth;
    const h = ref.current.offsetHeight;
    setPos({ left: Math.min(props.x, window.innerWidth - w - 4), top: Math.min(props.y, window.innerHeight - h - 4) });
  }, [props.x, props.y]);
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) props.onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [props]);
  return (
    <div ref={ref} className="popover" style={pos} role="menu" data-testid="context-menu">
      {props.children}
    </div>
  );
}

export function MenuItem(props: {
  onClick: () => void;
  children: ReactNode;
  kbd?: string;
  disabled?: boolean;
  testId?: string;
}): ReactNode {
  return (
    <button
      type="button"
      className="menu-item"
      role="menuitem"
      onClick={props.onClick}
      disabled={props.disabled}
      data-testid={props.testId}
    >
      <span>{props.children}</span>
      {props.kbd ? <span className="kbd">{props.kbd}</span> : null}
    </button>
  );
}

export function Modal(props: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  testId?: string;
}): ReactNode {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Focus the first field of the body so typing works at once; the close button in the header comes first in the
    // document, so a plain "first focusable" query would land on it.
    const el = ref.current;
    const first =
      el?.querySelector<HTMLElement>('.modal-body input, .modal-body select, .modal-body textarea') ??
      el?.querySelector<HTMLElement>('.modal-foot button.primary, .modal-body button');
    first?.focus();
    if (first instanceof HTMLInputElement) first.select();
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div
        ref={ref}
        className={`modal${props.wide ? ' wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        data-testid={props.testId}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            props.onClose();
          }
        }}
      >
        <div className="modal-head">
          <span className="title">{props.title}</span>
          <IconButton tip={t('dialogs.close')} tipPos="left" onClick={props.onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer ? <div className="modal-foot">{props.footer}</div> : null}
      </div>
    </div>
  );
}

export function Segmented<T extends string>(props: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}): ReactNode {
  return (
    <div className="segmented" role="group">
      {props.options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === props.value} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
