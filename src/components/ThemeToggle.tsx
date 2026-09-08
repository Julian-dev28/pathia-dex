'use client';

import { useEffect, useState } from 'react';

type Theme = 'dark' | 'light';
const KEY = 'pathia-theme';

/**
 * Dark by default, light on request.
 *
 * Not tied to `prefers-color-scheme`: the OS preference is about documents, and
 * this is an instrument that is mostly read at night against a venue that is
 * itself dark. The choice persists per browser, and is applied by
 * `ThemeScript` before first paint so the page never flashes the wrong palette.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    const stored = (localStorage.getItem(KEY) as Theme | null) ?? 'dark';
    setTheme(stored);
  }, []);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Private browsing can refuse storage; the toggle should still work for
      // this session rather than throwing on the click.
    }
  };

  return (
    <button
      className="icon-btn"
      onClick={toggle}
      type="button"
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
    >
      {theme === 'dark' ? '☾' : '☀'}
    </button>
  );
}

/**
 * Applies the stored theme before React hydrates.
 *
 * Without this the server renders dark, the client reads localStorage, and a
 * light-theme user watches the page flash black for a frame on every load.
 */
export function ThemeScript() {
  const js = `try{var t=localStorage.getItem('${KEY}')||'dark';document.documentElement.setAttribute('data-theme',t)}catch(e){}`;
  return <script dangerouslySetInnerHTML={{ __html: js }} />;
}
