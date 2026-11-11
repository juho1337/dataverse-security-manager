import { describe, expect, it } from 'vitest';
import { normalizeParentRoot } from './lineage';

describe('normalizeParentRoot', () => {
  it('a role that names itself as its root is a root (null)', () => {
    expect(normalizeParentRoot('AAA', 'aaa')).toBeNull();
  });
  it('a copy keeps its root id, and a missing value stays null', () => {
    expect(normalizeParentRoot('bbb', 'aaa')).toBe('aaa');
    expect(normalizeParentRoot('bbb', null)).toBeNull();
  });
});
