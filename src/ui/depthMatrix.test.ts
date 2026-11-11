import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CellValue, DepthId } from '../domain/privileges';
import { describeLetter, grantedDepth } from './depthMatrix';
import { DEPTH_COLUMNS } from './labels';

const depth = (d: DepthId): CellValue => ({ kind: 'depth', depth: d });
const states = (cell: CellValue, staged?: DepthId) => DEPTH_COLUMNS.map((c) => describeLetter('Create', cell, c, staged).state);

describe('Depth Matrix letter states: one grant per privilege, lower depths are only implied', () => {
  it.each([
    ['Basic', ['granted', 'inactive', 'inactive', 'inactive']],
    ['Local', ['covered', 'granted', 'inactive', 'inactive']],
    ['Deep', ['covered', 'covered', 'granted', 'inactive']],
    ['Global', ['covered', 'covered', 'covered', 'granted']],
  ] as const)('a %s grant is granted in exactly one column and covered below it', (d, expected) => {
    const s = states(depth(d));
    expect(s).toEqual(expected);
    expect(s.filter((x) => x === 'granted')).toHaveLength(1);
  });

  it('None and "no entry" are not grants and not coverage', () => {
    expect(states(depth('None'))).toEqual(['inactive', 'inactive', 'inactive', 'inactive']);
    expect(states({ kind: 'noGrant' })).toEqual(['inactive', 'inactive', 'inactive', 'inactive']);
    expect(grantedDepth(depth('None'))).toBeNull();
    expect(grantedDepth({ kind: 'noGrant' })).toBeNull();
  });

  it('unknown is never shown as not granted; not applicable is distinct', () => {
    expect(states({ kind: 'unknown' })).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
    expect(states({ kind: 'notApplicable' })).toEqual(['notApplicable', 'notApplicable', 'notApplicable', 'notApplicable']);
    expect(describeLetter('Read', { kind: 'unknown' }, 'Local').shown).toBe('?');
  });

  it('names say granted, implied (not a separate grant), not granted or unknown in words', () => {
    expect(describeLetter('Create', depth('Local'), 'Local').name).toBe('Create: granted at Business Unit');
    expect(describeLetter('Create', depth('Global'), 'Local').name).toBe('Create: covered by the Organization grant (implied, not a separate grant)');
    expect(describeLetter('Create', depth('Local'), 'Global').name).toBe('Create: not granted');
    expect(describeLetter('Create', { kind: 'unknown' }, 'Local').name).toBe('Create: unknown, could not be read');
    expect(describeLetter('AppendTo', depth('Basic'), 'Basic').name).toBe('Append To: granted at User');
  });

  it('staged change: marks the target depth (grant) or the current grant (removal), with before/after in words', () => {
    const grant = states(depth('Deep'), 'Global');
    expect(grant).toEqual(['covered', 'covered', 'covered', 'staged']); // Parent: Child BU is now covered by the new Organization grant (and pending)
    expect(DEPTH_COLUMNS.map((c) => describeLetter('Create', depth('Deep'), c, 'Global').pending)).toEqual([false, false, true, true]);
    expect(describeLetter('Read', depth('Deep'), 'Global', 'Global').name).toBe('Read: staged change, will be granted at Organization (currently granted at Parent: Child BU)');
    expect(states(depth('Deep'), 'None')).toEqual(['inactive', 'inactive', 'inactive', 'inactive']);
    expect(DEPTH_COLUMNS.map((c) => describeLetter('Create', depth('Deep'), c, 'None').pending)).toEqual([true, true, true, false]);
    expect(describeLetter('Read', depth('Deep'), 'Deep', 'None').name).toBe('Read: staged change, will be removed (currently granted at Parent: Child BU)');
    expect(describeLetter('Read', { kind: 'noGrant' }, 'Local', 'Local').name).toBe('Read: staged change, will be granted at Business Unit (currently not granted)');
  });
});

// ---- palette contrast (values are read from the shipped stylesheet, light and dark) ----
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (ch[0] ?? 0) + 0.7152 * (ch[1] ?? 0) + 0.0722 * (ch[2] ?? 0);
}
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
};

const css = readFileSync(`${process.cwd()}/src/ui/styles.css`, 'utf8');
const DARK_MARKER = '@media (prefers-color-scheme: dark)';
const [lightPart = '', darkPart = ''] = [css.slice(0, css.indexOf(DARK_MARKER)), css.slice(css.indexOf(DARK_MARKER), css.indexOf('* { box-sizing'))];
function vars(part: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of part.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6});/g)) out[m[1] ?? ''] = m[2] ?? '';
  return out;
}

describe.each([
  ['light', { ...vars(lightPart) }],
  ['dark', { ...vars(lightPart), ...vars(darkPart) }],
] as const)('Depth Matrix palette contrast (%s theme)', (_theme, v) => {
  const c = (a: string, b: string) => contrast(v[a] ?? '#000000', v[b] ?? '#ffffff');
  it('letter text is at least 4.5:1 on its own background', () => {
    expect(c('dm-granted-fg', 'dm-granted-bg')).toBeGreaterThanOrEqual(4.5);
    expect(c('dm-covered-fg', 'bg')).toBeGreaterThanOrEqual(4.5);
    expect(c('dm-inactive-fg', 'bg')).toBeGreaterThanOrEqual(4.5);
    expect(c('dm-na-fg', 'dm-na-bg')).toBeGreaterThanOrEqual(4.5);
    expect(c('dm-na-fg', 'dm-na-stripe')).toBeGreaterThanOrEqual(4.5);
    expect(c('dm-unknown-fg', 'dm-unknown-bg')).toBeGreaterThanOrEqual(4.5);
    expect(c('dm-staged-fg', 'dm-staged-bg')).toBeGreaterThanOrEqual(4.5);
  });
  it('borders and filled glyphs are at least 3:1 against the page background', () => {
    expect(c('dm-granted-bg', 'bg')).toBeGreaterThanOrEqual(3);
    expect(c('dm-covered-border', 'bg')).toBeGreaterThanOrEqual(3);
    expect(c('dm-staged-border', 'bg')).toBeGreaterThanOrEqual(3);
    expect(c('dm-unknown-fg', 'bg')).toBeGreaterThanOrEqual(3);
  });
});
