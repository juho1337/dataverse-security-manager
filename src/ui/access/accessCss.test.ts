import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The stylesheet is checked as text: the narrow-width single column must come AFTER the desktop grid (equal specificity, the later rule wins), and
// the sticky action bar must use a colour that exists (an undefined custom property leaves it transparent over the picker).
const css = readFileSync('src/ui/access/access.css', 'utf8');

describe('access.css', () => {
  it('declares the single-column layout after the last desktop grid declaration', () => {
    const desktop = [...css.matchAll(/^\.access-layout \{[^}]*grid-template-columns:[^}]*\}/gm)].map((m) => m.index ?? 0);
    const narrow = [...css.matchAll(/@media \(max-width: 48rem\) \{[^@]*\.access-layout \{ grid-template-columns: 1fr; \}/g)].map((m) => m.index ?? 0);
    expect(desktop.length).toBeGreaterThan(0);
    expect(Math.max(...narrow)).toBeGreaterThan(Math.max(...desktop));
  });

  it('gives the sticky assignment bar an opaque background token that exists or has a fallback', () => {
    const bar = /\.assign-bar \{[^}]*position: sticky[^}]*background: ([^;]+);/.exec(css)?.[1] ?? '';
    expect(bar).toMatch(/var\(--page, var\(--bg\)\)|var\(--bg\)|var\(--surface\)/);
  });
});
