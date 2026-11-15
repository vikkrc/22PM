import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { hexToLinear, kelvinToLinear, linearToHex } from '../core/color';
import { formatBBT, formatLength, parseBBT, parseLength, type TempoMap } from '../core/tempo';
import { commit } from '../state/store';

const decimals = (step: number) => (step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3);

export function fmt(v: number, step = 0.01): string {
  if (!Number.isFinite(v)) return '–';
  return v.toFixed(decimals(step));
}

interface NumProps {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  /** Range for the fill bar; no bar without it. */
  soft?: [number, number];
  unit?: string;
  label?: string;
  title?: string;
  className?: string;
  style?: CSSProperties;
  /** A second value shown as a tick (e.g. the live modulated value). */
  live?: number;
  disabled?: boolean;
}

/**
 * Number field for precise editing: drag to scrub (Shift = fine, Alt = coarse), click to type,
 * arrow keys to step. Typed expressions like "2*3" or "+0.5" (relative) are accepted.
 */
export function Num({ value, onChange, step = 0.01, min = -Infinity, max = Infinity, soft, unit, label, title, className, style, live, disabled }: NumProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const drag = useRef<{ x: number; v: number; moved: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const clampV = (v: number) => Math.min(max, Math.max(min, v));
  useEffect(() => { if (editing != null) inputRef.current?.select(); }, [editing != null]);

  const finish = (text: string) => {
    setEditing(null);
    const t = text.trim();
    if (!t) return;
    let v: number | null = null;
    try {
      if (/^[+\-*/]=?\s*[\d.]+$/.test(t) && /^[+*/]/.test(t)) v = Function(`"use strict";return (${value})${t.replace('=', '')}`)();
      else if (/^[\d\s+\-*/().e]+$/i.test(t)) v = Function(`"use strict";return (${t})`)();
    } catch { v = null; }
    if (v != null && Number.isFinite(v)) { onChange(clampV(v)); commit(); }
  };

  if (editing != null) {
    return (
      <span className={`num editing ${className ?? ''}`} style={style}>
        {label && <span className="num-label">{label}</span>}
        <input ref={inputRef} defaultValue={editing} spellCheck={false}
          onBlur={(e) => finish(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') finish(e.currentTarget.value); else if (e.key === 'Escape') setEditing(null); e.stopPropagation(); }} />
      </span>
    );
  }
  const fill = soft ? Math.min(1, Math.max(0, (value - soft[0]) / (soft[1] - soft[0] || 1))) : null;
  const liveX = soft && live != null ? Math.min(1, Math.max(0, (live - soft[0]) / (soft[1] - soft[0] || 1))) : null;
  return (
    <span className={`num ${disabled ? 'disabled' : ''} ${className ?? ''}`} style={style} title={title ?? 'Drag to change · Shift fine · Alt coarse · click to type'} tabIndex={disabled ? -1 : 0}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return;
        drag.current = { x: e.clientX, v: value, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        if (!d.moved && Math.abs(dx) < 3) return;
        d.moved = true;
        const range = soft ? soft[1] - soft[0] : 0;
        const perPx = soft ? Math.max(step, range / 200) : step;
        const k = e.shiftKey ? 0.1 : e.altKey ? 10 : 1;
        const raw = d.v + dx * perPx * k;
        const q = step * (e.shiftKey ? 0.1 : 1);
        onChange(clampV(Math.round(raw / q) * q));
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        if (!d) return;
        if (!d.moved) setEditing(fmt(value, step / 10));
        else commit();
      }}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          onChange(clampV(value + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1)));
        } else if (e.key === 'Enter') setEditing(fmt(value, step / 10));
      }}
      onKeyUp={(e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') commit(); }}>
      {fill != null && <span className="num-fill" style={{ width: `${fill * 100}%` }} />}
      {liveX != null && <span className="num-live" style={{ left: `${liveX * 100}%` }} />}
      {label && <span className="num-label">{label}</span>}
      <span className="num-value">{fmt(value, step)}</span>
      {unit && <span className="num-unit">{unit}</span>}
    </span>
  );
}

export function ColorField({ rgb, onChange }: { rgb: [number, number, number]; onChange: (rgb: [number, number, number]) => void }) {
  const [kelvin, setKelvin] = useState(false);
  const [k, setK] = useState(5600);
  const hex = linearToHex(rgb[0], rgb[1], rgb[2]);
  return (
    <span className="color-field">
      <label className="swatch" style={{ background: hex }} title="Pick colour">
        <input type="color" value={hex} onChange={(e) => onChange(hexToLinear(e.target.value))} onBlur={() => commit()} />
      </label>
      {kelvin ? (
        <Num value={k} step={50} min={1000} max={20000} soft={[1500, 12000]} unit="K" onChange={(v) => { setK(v); onChange(kelvinToLinear(v)); }} style={{ flex: 1 }} />
      ) : (
        <input className="text hex" value={hex} spellCheck={false} onChange={(e) => { if (/^#[0-9a-f]{6}$/i.test(e.target.value)) onChange(hexToLinear(e.target.value)); }} />
      )}
      <button className={`mini ${kelvin ? 'on' : ''}`} title="Set colour by temperature (Kelvin)" onClick={() => setKelvin(!kelvin)}>K</button>
    </span>
  );
}

export function Select<T extends string | number>({ value, options, onChange, title, className }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; title?: string; className?: string }) {
  return (
    <select className={`select ${className ?? ''}`} title={title} value={String(value)}
      onChange={(e) => { const o = options.find((x) => String(x.value) === e.target.value); if (o) onChange(o.value); }}>
      {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
    </select>
  );
}

export function Toggle({ value, onChange, label, title }: { value: boolean; onChange: (v: boolean) => void; label?: string; title?: string }) {
  return (
    <button className={`toggle ${value ? 'on' : ''}`} role="switch" aria-checked={value} title={title} onClick={() => onChange(!value)}>
      <span className="toggle-knob" />{label && <span className="toggle-label">{label}</span>}
    </button>
  );
}

export function Text({ value, onChange, placeholder, className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input className={`text ${className ?? ''}`} value={draft ?? value} placeholder={placeholder} spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft != null && draft !== value) onChange(draft); setDraft(null); }}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur(); } }} />
  );
}

/** Musical position (bar.beat.tick) or length field. */
export function BBT({ tempo, beat, onChange, length, title }: { tempo: TempoMap; beat: number; onChange: (beat: number) => void; length?: boolean; title?: string }) {
  const text = length ? formatLength(tempo, beat) : formatBBT(tempo, beat);
  return (
    <span title={title ?? (length ? 'Length: bars.beats.ticks' : 'Position: bar.beat.tick')}>
      <Text className="mono bbt" value={text} onChange={(s) => { const v = length ? parseLength(tempo, s) : parseBBT(tempo, s); if (v != null) onChange(v); }} />
    </span>
  );
}

export function Row({ label, children, title, actions, dim }: { label: ReactNode; children: ReactNode; title?: string; actions?: ReactNode; dim?: boolean }) {
  return (
    <div className={`row ${dim ? 'dim' : ''}`}>
      <div className="row-label" title={title}>{label}</div>
      <div className="row-body">{children}</div>
      {actions !== undefined && <div className="row-actions">{actions}</div>}
    </div>
  );
}

export function Section({ title, children, right, defaultOpen = true }: { title: string; children: ReactNode; right?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="section">
      <header className="section-head" onClick={() => setOpen(!open)}>
        <span className={`chev ${open ? 'open' : ''}`}>›</span><span className="section-title">{title}</span>
        <span className="section-right" onClick={(e) => e.stopPropagation()}>{right}</span>
      </header>
      {open && <div className="section-body">{children}</div>}
    </section>
  );
}

export type MenuItem = { label: string; onClick: () => void; danger?: boolean; disabled?: boolean } | 'sep' | { heading: string };

/**
 * A menu floating above the whole app. It is rendered at the end of <body> with fixed positioning, so
 * no panel, scroll area or neighbouring row can clip or cover it. It opens below its anchor point and
 * flips up or left when it would run off the window.
 */
export function FloatingMenu({ at, items, onClose }: { at: { x: number; y: number; flipY?: number; alignRight?: boolean }; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight, m = 6;
    let left = Math.min(at.alignRight ? at.x - w : at.x, window.innerWidth - w - m);
    let top = at.y;
    if (top + h > window.innerHeight - m) top = Math.max(m, (at.flipY ?? at.y) - h);
    left = Math.max(m, left);
    setPos({ left, top });
    el.querySelector<HTMLButtonElement>('.menu-item:not(:disabled)')?.focus({ preventScroll: true });
  }, [at.x, at.y, at.flipY, at.alignRight]);
  useEffect(() => {
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>('.menu-item:not(:disabled)') ?? [])];
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.focus();
    };
    const away = () => onClose();
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('resize', away);
    window.addEventListener('blur', away);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', away);
      window.removeEventListener('blur', away);
    };
  }, [onClose]);
  return createPortal(
    <div ref={ref} className="menu floating" role="menu" style={pos ? pos : { left: at.x, top: at.y, visibility: 'hidden' }}
      onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {items.map((it, i) => it === 'sep' ? <div key={i} className="menu-sep" /> : 'heading' in it ? <div key={i} className="menu-head">{it.heading}</div> : (
        <button key={i} role="menuitem" className={`menu-item ${it.danger ? 'danger' : ''}`} disabled={it.disabled} onClick={() => { onClose(); it.onClick(); }}>{it.label}</button>
      ))}
    </div>,
    document.body,
  );
}

/** Button that opens a FloatingMenu below itself (right-aligned when `className` includes "right"). */
export function Menu({ trigger, items, className, title }: { trigger: ReactNode; items: MenuItem[]; className?: string; title?: string }) {
  const [at, setAt] = useState<{ x: number; y: number; flipY: number; alignRight: boolean } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setAt(null), []);
  const toggle = () => {
    if (at) { setAt(null); return; }
    const r = btn.current!.getBoundingClientRect();
    const right = !!className?.includes('right');
    setAt({ x: right ? r.right : r.left, y: r.bottom + 4, flipY: r.top - 4, alignRight: right });
  };
  return (
    <span className={`menu-wrap ${className ?? ''}`}>
      <button ref={btn} className={`btn ${at ? 'on' : ''}`} title={title} aria-haspopup="menu" aria-expanded={!!at}
        onPointerDown={(e) => { if (at) e.stopPropagation(); }} onClick={toggle}>{trigger}</button>
      {at && <FloatingMenu at={at} items={items} onClose={close} />}
    </span>
  );
}
