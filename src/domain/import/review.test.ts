import { describe, expect, it } from 'vitest';
import { parseImportFile } from './parser';
import {
  applyImportReview,
  buildImportReview,
  countClass,
  includedCount,
  problemRows,
  resolveEmails,
  reviewSummary,
  setAll,
  setInclude,
  type UserSelectionLike,
  type UserSummary,
} from './review';
import { parseEmailList } from './parser';

const TARGET = 'bu-target';
const OTHER = 'bu-other';
const user = (n: number, email: string, over: Partial<UserSummary> = {}): UserSummary => ({
  id: `u${n}`, fullName: `User ${n}`, email, businessUnitId: OTHER, isDisabled: false, isApplicationUser: false, ...over,
});

const users: UserSummary[] = [
  user(1, 'alex@example.test'),
  user(2, 'sam@example.test', { isDisabled: true }),
  user(3, 'app@example.test', { isApplicationUser: true }),
  user(4, 'here@example.test', { businessUnitId: TARGET }),
  user(5, 'twin@example.test'),
  user(6, 'TWIN@example.test'),
  user(7, 'picked@example.test'),
];

class Selection implements UserSelectionLike {
  readonly ids = new Set<string>();
  constructor(initial: string[] = [], private readonly ineligible: string[] = []) { initial.forEach((i) => this.ids.add(i)); }
  has(id: string): boolean { return this.ids.has(id); }
  add(u: UserSummary): 'added' | 'alreadySelected' | 'notEligible' {
    if (this.ineligible.includes(u.id)) return 'notEligible';
    if (this.ids.has(u.id)) return 'alreadySelected';
    this.ids.add(u.id);
    return 'added';
  }
}

describe('resolveEmails', () => {
  const list = parseEmailList('alex@example.test\nsam@example.test\napp@example.test\nhere@example.test\ntwin@example.test\nmissing@example.test\n');
  const r = resolveEmails(list, users, TARGET);

  it('classifies each address by what an administrator can do with it', () => {
    expect(r.entries.map((e) => [e.email, e.status])).toEqual([
      ['alex@example.test', 'ready'],
      ['sam@example.test', 'disabled'],
      ['app@example.test', 'applicationUser'],
      ['here@example.test', 'alreadyInTargetBusinessUnit'],
      ['twin@example.test', 'ambiguous'],
      ['missing@example.test', 'notFound'],
    ]);
  });

  it('matches case-insensitively and keeps every ambiguous match', () => {
    expect(r.entries[4]?.matchedUsers.map((u) => u.id)).toEqual(['u5', 'u6']);
  });

  it('ignores users without an email and carries invalid and duplicate lines through', () => {
    const withBlank = resolveEmails(parseEmailList('a@example.test\nbad\na@example.test'), [user(9, '')], TARGET);
    expect(withBlank.entries[0]?.status).toBe('notFound');
    expect(withBlank.invalid).toHaveLength(1);
    expect(withBlank.duplicates).toHaveLength(1);
  });
});

describe('import review', () => {
  const file = parseImportFile('email,name\nalex@example.test,n\nsam@example.test,n\nhere@example.test,n\nmissing@example.test,n\nbad,n\nalex@example.test,n\ntwin@example.test,n\napp@example.test,n\npicked@example.test,n\n');
  const review = buildImportReview(file, users, TARGET, new Selection(['u7']));

  it('classifies every line, including duplicates, invalid lines and users already in the move', () => {
    expect(review.rows.map((r) => r.class)).toEqual([
      'ready', 'disabled', 'alreadyInTarget', 'notFound', 'invalid', 'duplicate', 'ambiguous', 'applicationUser', 'alreadySelected',
    ]);
    expect(review.source).toBe('Table with the email column "email"');
    expect(review.rows[8]?.reason).toBe('Already in the move.');
  });

  it('includes only ready rows by default and never lets another class be included', () => {
    expect(includedCount(review)).toBe(1);
    const tried = setInclude(review, 3, true);
    expect(tried.changed).toBe(false);
    expect(includedCount(tried.review)).toBe(1);
    const alexOff = setInclude(review, review.rows[0]?.lineNumber ?? 0, false);
    expect(alexOff.changed).toBe(true);
    expect(includedCount(alexOff.review)).toBe(0);
    expect(includedCount(setAll(alexOff.review, true))).toBe(1);
    expect(includedCount(setAll(review, false))).toBe(0);
  });

  it('is immutable', () => {
    const before = includedCount(review);
    setAll(review, false);
    setInclude(review, 2, false);
    expect(includedCount(review)).toBe(before);
  });

  it('summarises the counts in plain language', () => {
    expect(reviewSummary(review)).toBe(
      '9 line(s): 1 ready, 1 already in the move, 1 already in the target, 1 not found, 1 ambiguous, 2 not movable, 1 invalid, 1 duplicate. 1 will be added.',
    );
    expect(countClass(review, 'ready')).toBe(1);
  });

  it('adds nothing merely by building the review, and only included rows on apply', () => {
    const selection = new Selection();
    buildImportReview(file, users, TARGET, selection);
    expect(selection.ids.size).toBe(0);
    expect(applyImportReview(review, selection)).toEqual({ added: 1, alreadySelected: 0, notEligible: 0 });
    expect([...selection.ids]).toEqual(['u1']);
  });

  it('counts rows that stopped being addable instead of failing', () => {
    expect(applyImportReview(review, new Selection([], ['u1']))).toEqual({ added: 0, alreadySelected: 0, notEligible: 1 });
    expect(applyImportReview(review, new Selection(['u1']))).toEqual({ added: 0, alreadySelected: 1, notEligible: 0 });
  });

  it('lists the problem rows, not the ready or already-selected ones', () => {
    expect(problemRows(review).map((r) => r[0])).toEqual(['disabled', 'alreadyInTarget', 'notFound', 'invalid', 'duplicate', 'ambiguous', 'applicationUser']);
    expect(problemRows(review)[2]).toEqual(['notFound', '5', 'missing@example.test', 'No user matches this email.']);
  });

  it('describes a plain list source and works without a selection', () => {
    const plain = buildImportReview(parseImportFile('alex@example.test\n'), users, TARGET);
    expect(plain.source).toBe('Plain list, one address per line');
    expect(plain.rows[0]?.class).toBe('ready');
  });
});
