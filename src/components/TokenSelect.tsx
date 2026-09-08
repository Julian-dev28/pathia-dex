'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Token } from '@/lib/chain';

/**
 * Token picker with search.
 *
 * A native `<select>` was fine at four tokens and stops being fine at twelve —
 * and the list is meant to grow. This is a listbox rather than a combobox: the
 * filter narrows, arrow keys move, Enter commits, Escape closes, and focus
 * returns to the trigger so keyboard use does not dead-end.
 *
 * The token already on the other side of the trade is shown but disabled,
 * rather than hidden, so the list does not reshuffle as the pair changes.
 */
export function TokenSelect({
  value,
  onChange,
  tokens,
  exclude,
  label,
}: {
  value: string;
  onChange: (symbol: string) => void;
  tokens: Token[];
  exclude?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tokens;
    return tokens.filter(
      (t) => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q),
    );
  }, [tokens, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    // Focus after paint; focusing during the click that opened it is swallowed.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const commit = (t: Token) => {
    if (t.symbol === exclude) return;
    onChange(t.symbol);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const t = filtered[cursor];
      if (t) commit(t);
    }
  };

  return (
    <div className="tsel" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="tsel-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label ?? `Token: ${value}`}
      >
        {value}
        <span className="tsel-caret" aria-hidden="true" />
      </button>

      {open && (
        <div className="tsel-pop" role="dialog">
          <input
            ref={inputRef}
            className="tsel-search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search name or symbol"
            aria-label="Search tokens"
          />
          <ul className="tsel-list" role="listbox" aria-label="Tokens">
            {filtered.length === 0 && <li className="tsel-empty">No match</li>}
            {filtered.map((t, i) => {
              const disabled = t.symbol === exclude;
              return (
                <li key={t.symbol}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={t.symbol === value}
                    disabled={disabled}
                    className={`tsel-opt${i === cursor ? ' on' : ''}${t.symbol === value ? ' sel' : ''}`}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => commit(t)}
                  >
                    <span className="tsel-sym">{t.symbol}</span>
                    <span className="tsel-name">{disabled ? 'on the other side' : t.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
