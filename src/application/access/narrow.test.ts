import { describe, expect, it } from 'vitest';
import { narrowByBusinessUnit } from './narrow';

const hits = [{ n: 'a', bu: 'Sales North' }, { n: 'b', bu: 'Finance' }, { n: 'c', bu: null }];
const bu = (h: { bu: string | null }) => h.bu;

describe('narrowByBusinessUnit', () => {
  it('returns everything for an empty text', () => {
    expect(narrowByBusinessUnit(hits, bu, '  ')).toEqual({ shown: hits, unknownKept: 0, hidden: 0 });
  });
  it('matches part of the name, case-insensitively', () => {
    expect(narrowByBusinessUnit(hits, bu, 'NORTH').shown.map((h) => h.n)).toEqual(['a', 'c']);
  });
  it('keeps and counts a hit whose Business Unit is unknown, and counts the hidden ones', () => {
    const r = narrowByBusinessUnit(hits, bu, 'finance');
    expect(r.shown.map((h) => h.n)).toEqual(['b', 'c']);
    expect(r.unknownKept).toBe(1);
    expect(r.hidden).toBe(1);
  });
});
