import { toEmailListResult, type EmailListEntry, type EmailListResult, type ImportFileResult } from './parser';

// Resolution of imported addresses against the loaded users, and the review step between reading a file and the move (issue #271).
// Port of XrmToolBox UserEmailResolver and ImportReview. Nothing is added to the move by merely reading a file: only rows the person
// leaves included, and that can still be moved, are added.

/** The user fields import needs. The BU move's `UserSummary` satisfies it structurally, so this module does not depend on the planner. */
export interface UserSummary {
  readonly id: string;
  readonly fullName: string;
  readonly email: string;
  readonly businessUnitId: string;
  readonly isDisabled: boolean;
  readonly isApplicationUser: boolean;
}

export type EmailResolutionStatus = 'ready' | 'notFound' | 'ambiguous' | 'disabled' | 'applicationUser' | 'alreadyInTargetBusinessUnit';

export interface EmailResolutionEntry {
  readonly email: string;
  readonly status: EmailResolutionStatus;
  readonly matchedUsers: readonly UserSummary[];
  readonly reason: string;
}

export interface EmailResolution {
  readonly entries: readonly EmailResolutionEntry[];
  readonly invalid: readonly EmailListEntry[];
  readonly duplicates: readonly EmailListEntry[];
}

export function resolveEmails(list: EmailListResult, users: readonly UserSummary[], targetBusinessUnitId: string): EmailResolution {
  const byEmail = new Map<string, UserSummary[]>();
  for (const user of users) {
    if (!user?.email) continue;
    const key = user.email.toLowerCase();
    const matches = byEmail.get(key) ?? [];
    matches.push(user);
    byEmail.set(key, matches);
  }

  const entries = list.valid.map((email): EmailResolutionEntry => {
    const matches = email ? byEmail.get(email.toLowerCase()) : undefined;
    if (!matches) return { email, status: 'notFound', matchedUsers: [], reason: 'No user matches this email.' };
    if (matches.length > 1) return { email, status: 'ambiguous', matchedUsers: matches, reason: 'Multiple users match this email.' };
    const user = matches[0] as UserSummary;
    if (user.isApplicationUser) return { email, status: 'applicationUser', matchedUsers: matches, reason: 'Application users cannot be moved.' };
    if (user.isDisabled) return { email, status: 'disabled', matchedUsers: matches, reason: 'Disabled users cannot be moved.' };
    if (user.businessUnitId === targetBusinessUnitId) {
      return { email, status: 'alreadyInTargetBusinessUnit', matchedUsers: matches, reason: 'User is already in the target business unit.' };
    }
    return { email, status: 'ready', matchedUsers: matches, reason: 'User is ready to move.' };
  });
  return { entries, invalid: list.invalid, duplicates: list.duplicates };
}

/** What an imported line turned out to be, in the terms the administrator acts on. */
export type ImportClass =
  /** A single, enabled, movable user that is not yet in the move. */
  | 'ready'
  | 'alreadySelected'
  | 'alreadyInTarget'
  | 'notFound'
  | 'ambiguous'
  | 'disabled'
  | 'applicationUser'
  /** The line holds no usable email address. */
  | 'invalid'
  /** The same address appeared on an earlier line. */
  | 'duplicate';

export interface ImportReviewRow {
  readonly lineNumber: number;
  /** The address as written in the file; null for a line without one. */
  readonly email: string | null;
  /** The line as read, for lines without a usable address. */
  readonly text: string;
  readonly class: ImportClass;
  readonly reason: string;
  /** The one matching user; null when none or several match. */
  readonly user: UserSummary | null;
  /** Whether the row is added to the move. Only a `ready` row can be included. */
  readonly include: boolean;
}

export interface ImportReview {
  /** Plain-language description of what was read (format and email column), for the dialog header. */
  readonly source: string;
  readonly rows: readonly ImportReviewRow[];
}

/** The selection the review adds to (the shared user selection of the BU Manager). */
export interface UserSelectionLike {
  has(userId: string): boolean;
  /** Adds the user; the result says what happened. Eligibility rules live in the selection, not here. */
  add(user: UserSummary): 'added' | 'alreadySelected' | 'notEligible';
}

const canInclude = (row: ImportReviewRow): boolean => row.class === 'ready';

function classOf(status: EmailResolutionStatus, user: UserSummary | null, selection: UserSelectionLike | null): ImportClass {
  switch (status) {
    case 'notFound':
      return 'notFound';
    case 'ambiguous':
      return 'ambiguous';
    case 'disabled':
      return 'disabled';
    case 'applicationUser':
      return 'applicationUser';
    case 'alreadyInTargetBusinessUnit':
      return 'alreadyInTarget';
    default:
      return selection && user && selection.has(user.id) ? 'alreadySelected' : 'ready';
  }
}

const describe = (file: ImportFileResult): string =>
  file.format === 'plainList' ? 'Plain list, one address per line' : `Table with the email column "${file.emailColumn ?? ''}"`;

export function buildImportReview(
  file: ImportFileResult,
  users: readonly UserSummary[],
  targetBusinessUnitId: string,
  selection: UserSelectionLike | null = null,
): ImportReview {
  const resolution = resolveEmails(toEmailListResult(file), users, targetBusinessUnitId);
  const byEmail = new Map<string, EmailResolutionEntry>();
  for (const e of resolution.entries) if (e.email && !byEmail.has(e.email.toLowerCase())) byEmail.set(e.email.toLowerCase(), e);

  const make = (lineNumber: number, email: string | null, text: string, cls: ImportClass, reason: string, user: UserSummary | null): ImportReviewRow => ({
    lineNumber, email, text, class: cls, reason, user, include: cls === 'ready',
  });

  const rows = file.rows.map((r): ImportReviewRow => {
    if (r.isDuplicate) return make(r.lineNumber, r.email, r.raw, 'duplicate', 'Same address as an earlier line; counted once.', null);
    if (r.problem !== null) return make(r.lineNumber, r.email, r.raw, 'invalid', r.problem, null);
    const entry = r.email === null ? undefined : byEmail.get(r.email.toLowerCase());
    if (!entry) return make(r.lineNumber, r.email, r.raw, 'notFound', 'No user matches this email.', null);
    const user = entry.matchedUsers.length === 1 ? (entry.matchedUsers[0] as UserSummary) : null;
    const cls = classOf(entry.status, user, selection);
    return make(r.lineNumber, r.email, r.raw, cls, cls === 'alreadySelected' ? 'Already in the move.' : entry.reason, user);
  });
  return { source: describe(file), rows };
}

export const countClass = (review: ImportReview, c: ImportClass): number => review.rows.filter((r) => r.class === c).length;
export const includedCount = (review: ImportReview): number => review.rows.filter((r) => r.include).length;

/** Includes or excludes one row (by line number). A row that cannot be moved stays excluded; `changed` says whether the change was made. */
export function setInclude(review: ImportReview, lineNumber: number, include: boolean): { readonly review: ImportReview; readonly changed: boolean } {
  const row = review.rows.find((r) => r.lineNumber === lineNumber);
  if (!row || (include && !canInclude(row))) return { review, changed: false };
  return { review: { ...review, rows: review.rows.map((r) => (r === row ? { ...r, include } : r)) }, changed: true };
}

export function setAll(review: ImportReview, include: boolean): ImportReview {
  return { ...review, rows: review.rows.map((r) => ({ ...r, include: include && canInclude(r) })) };
}

export function reviewSummary(review: ImportReview): string {
  const n = (c: ImportClass) => countClass(review, c);
  return (
    `${review.rows.length} line(s): ${n('ready')} ready, ${n('alreadySelected')} already in the move, ${n('alreadyInTarget')} already in the target, ` +
    `${n('notFound')} not found, ${n('ambiguous')} ambiguous, ${n('disabled') + n('applicationUser')} not movable, ${n('invalid')} invalid, ` +
    `${n('duplicate')} duplicate. ${includedCount(review)} will be added.`
  );
}

export interface AddSummary {
  readonly added: number;
  readonly alreadySelected: number;
  readonly notEligible: number;
}

/** Adds the included rows to the shared selection and counts what happened. Rows that stopped being addable are skipped. */
export function applyImportReview(review: ImportReview, selection: UserSelectionLike): AddSummary {
  let added = 0;
  let alreadySelected = 0;
  let notEligible = 0;
  for (const r of review.rows.filter((x) => x.include && canInclude(x) && x.user !== null)) {
    const outcome = selection.add(r.user as UserSummary);
    if (outcome === 'added') added++;
    else if (outcome === 'alreadySelected') alreadySelected++;
    else notEligible++;
  }
  return { added, alreadySelected, notEligible };
}

/** The not-ready rows as plain rows the administrator can keep (class, line, address, reason). No user data beyond what the file held. */
export function problemRows(review: ImportReview): readonly (readonly string[])[] {
  return review.rows
    .filter((r) => r.class !== 'ready' && r.class !== 'alreadySelected')
    .map((r) => [r.class, String(r.lineNumber), r.email ?? r.text ?? '', r.reason]);
}
