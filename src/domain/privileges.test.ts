import { describe, expect, it } from 'vitest';
import { DEPTH_IDS, grantsAnything, hasUnknownCell, PRIVILEGE_IDS } from './privileges';
import type { CellValue, RoleRow } from './privileges';
import { DEPTH_LABEL, describeCell, PRIVILEGE_LABEL } from '../ui/labels';

const row = (fill: CellValue, override: Partial<Record<(typeof PRIVILEGE_IDS)[number], CellValue>> = {}): RoleRow => ({
  roleId: 'r',
  name: 'R',
  cells: Object.fromEntries(PRIVILEGE_IDS.map((p) => [p, override[p] ?? fill])) as RoleRow['cells'],
});

describe('canonical ids and display labels', () => {
  it('uses the shared contract depth ids', () => {
    expect([...DEPTH_IDS]).toEqual(['None', 'Basic', 'Local', 'Deep', 'Global']);
  });

  it('maps every depth id to a display label in the UI layer only', () => {
    expect(DEPTH_LABEL).toEqual({
      None: 'None',
      Basic: 'User',
      Local: 'Business Unit',
      Deep: 'Parent: Child BU',
      Global: 'Organization',
    });
  });

  it('has exactly the eight privileges in order with display labels', () => {
    expect(PRIVILEGE_IDS.map((p) => PRIVILEGE_LABEL[p])).toEqual([
      'Create', 'Read', 'Write', 'Delete', 'Append', 'Append To', 'Assign', 'Share',
    ]);
  });
});

describe('cell states are distinct', () => {
  it('renders None, No grant, n/a and Unknown with different text and glyphs', () => {
    const cells = [
      describeCell({ kind: 'depth', depth: 'None' }),
      describeCell({ kind: 'noGrant' }),
      describeCell({ kind: 'notApplicable' }),
      describeCell({ kind: 'unknown' }),
    ];
    expect(new Set(cells.map((c) => c.text)).size).toBe(4);
    expect(new Set(cells.map((c) => c.glyph)).size).toBe(4);
  });

  it('never shows an unknown cell as None', () => {
    expect(describeCell({ kind: 'unknown' }).text).not.toBe('None');
  });
});

describe('role predicates', () => {
  it('a role with only None / no grant / n/a grants nothing', () => {
    expect(grantsAnything(row({ kind: 'noGrant' }, { Read: { kind: 'depth', depth: 'None' }, Assign: { kind: 'notApplicable' } }))).toBe(false);
  });

  it('a role with one real depth grants something', () => {
    expect(grantsAnything(row({ kind: 'noGrant' }, { Read: { kind: 'depth', depth: 'Basic' } }))).toBe(true);
  });

  it('detects unknown cells', () => {
    expect(hasUnknownCell(row({ kind: 'noGrant' }, { Write: { kind: 'unknown' } }))).toBe(true);
    expect(hasUnknownCell(row({ kind: 'noGrant' }))).toBe(false);
  });
});
