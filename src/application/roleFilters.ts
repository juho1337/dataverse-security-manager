import type { RoleFamily } from '../domain/access';
import type { DepthId, PrivilegeId, RoleRow } from '../domain/privileges';
import { PRIVILEGE_IDS } from '../domain/privileges';
import type { ReadResult } from '../ports/securityDataReader';
import { filterRoles } from './tables';

// Role Analyzer filters (RA-10). Name search and "show all" already existed; this adds the privilege/depth filter (answerable from the matrix cells
// alone) and the holder / Business Unit filter (answerable only from a role's loaded assignments). Pure functions: no host, no UI.
//
// Honesty rules:
// - a cell that could not be read ("unknown") is never used to hide a role: it matches any privilege/depth filter, and the role is counted
//   as "included although a cell is unreadable";
// - the holder / Business Unit filter only knows roles whose assignments were loaded. A role that was not loaded is NOT silently treated as
//   "nobody holds it": it is counted as "not checked", and a role whose assignments failed to load stays listed and is counted as "could not be checked".

export interface MatrixFilters {
  readonly search: string;
  readonly showAll: boolean;
  /** Only these privileges are examined; empty = all eight. */
  readonly privileges: readonly PrivilegeId[];
  /** The role must grant one of these depths on an examined privilege; empty = any depth that grants something. Only used when `privileges` or `depths` is set. */
  readonly depths: readonly DepthId[];
  /** Part of a user, team or team-member name (case-insensitive); empty = off. */
  readonly holder: string;
  /** Part of a Business Unit name of one of the role's copies (case-insensitive); empty = off. */
  readonly businessUnit: string;
}

export const NO_FILTERS: MatrixFilters = { search: '', showAll: false, privileges: [], depths: [], holder: '', businessUnit: '' };

export const hasPrivilegeFilter = (f: MatrixFilters): boolean => f.privileges.length > 0 || f.depths.length > 0;
export const hasHolderFilter = (f: MatrixFilters): boolean => f.holder.trim() !== '' || f.businessUnit.trim() !== '';

/** What a loaded (or not yet loaded) role's assignments are, as far as the filter is concerned. */
export type Assignments = ReadResult<RoleFamily> | 'loading' | undefined;

export interface FilterOutcome {
  readonly rows: readonly RoleRow[];
  /** Roles hidden because they grant nothing (relevant-roles default). */
  readonly hiddenCount: number;
  /** Roles that match the privilege filter only because a cell could not be read. */
  readonly unreadableIncluded: number;
  /** Holder / Business Unit filter active: roles whose assignments are not loaded (hidden, until loaded). */
  readonly notChecked: readonly string[];
  /** Holder / Business Unit filter active: roles whose assignments could not be read, or only in part and without a match (listed, never hidden). */
  readonly couldNotCheck: number;
}

const has = (text: string, needle: string): boolean => text.toLowerCase().includes(needle);

/** Does the cell satisfy the privilege/depth filter? `unknown` answers "maybe" (true, flagged by the caller). */
function cellMatches(row: RoleRow, p: PrivilegeId, depths: readonly DepthId[]): { match: boolean; unknown: boolean } {
  const c = row.cells[p];
  if (c.kind === 'unknown') return { match: true, unknown: true };
  if (c.kind !== 'depth') return { match: false, unknown: false };
  if (depths.length > 0) return { match: depths.includes(c.depth), unknown: false };
  return { match: c.depth !== 'None', unknown: false };
}

function privilegeMatch(row: RoleRow, f: MatrixFilters): { match: boolean; unknown: boolean } {
  const examined = f.privileges.length > 0 ? f.privileges : PRIVILEGE_IDS;
  let unknown = false;
  for (const p of examined) {
    const r = cellMatches(row, p, f.depths);
    if (r.match && !r.unknown) return { match: true, unknown: false };
    if (r.unknown) unknown = true;
  }
  return { match: unknown, unknown };
}

/** True when any copy of the role satisfies the holder / Business Unit text filters (both must be satisfied by the same copy). */
export function familyMatches(family: RoleFamily, holder: string, businessUnit: string): boolean {
  const h = holder.trim().toLowerCase();
  const b = businessUnit.trim().toLowerCase();
  return family.instances.some((i) => {
    if (b && !has(i.businessUnitName, b)) return false;
    if (!h) return true;
    return (
      i.directUsers.some((u) => has(u.name, h)) ||
      i.teams.some((t) => has(t.name, h) || t.members.some((m) => has(m.name, h)))
    );
  });
}

/**
 * Applies name search, show-all, privilege/depth and holder/Business Unit filters in that order.
 * `assignments(roleId)` returns what is known about a role's holders.
 */
export function applyMatrixFilters(roles: readonly RoleRow[], f: MatrixFilters, assignments: (rootRoleId: string) => Assignments): FilterOutcome {
  // With a depth/privilege filter the relevant-roles default is part of the answer; keep it only when no such filter is set.
  const base = filterRoles(roles, f.search, f.showAll || hasPrivilegeFilter(f));
  let rows = base.rows;
  let unreadableIncluded = 0;
  if (hasPrivilegeFilter(f)) {
    const kept: RoleRow[] = [];
    for (const r of rows) {
      const m = privilegeMatch(r, f);
      if (!m.match) continue;
      if (m.unknown) unreadableIncluded++;
      kept.push(r);
    }
    rows = kept;
  }
  const notChecked: string[] = [];
  let couldNotCheck = 0;
  if (hasHolderFilter(f)) {
    const kept: RoleRow[] = [];
    for (const r of rows) {
      const a = assignments(r.roleId);
      if (a === undefined || a === 'loading') {
        notChecked.push(r.roleId);
        continue;
      }
      if (a.status === 'error') {
        couldNotCheck++;
        kept.push(r);
        continue;
      }
      if (familyMatches(a.data, f.holder, f.businessUnit)) kept.push(r);
      else if (a.status === 'partial') {
        // A partial read left sections empty (failed user, team or membership reads): a non-match proves nothing, so the role stays and is flagged.
        couldNotCheck++;
        kept.push(r);
      }
    }
    rows = kept;
  }
  return { rows, hiddenCount: hasPrivilegeFilter(f) ? 0 : base.hiddenCount, unreadableIncluded, notChecked, couldNotCheck };
}

/** The filters in words, for the report header: the file says what it leaves out. */
export function describeFilters(f: MatrixFilters, outcome: FilterOutcome, depthLabel: (d: DepthId) => string, privilegeLabel: (p: PrivilegeId) => string): string {
  const parts: string[] = [
    f.search.trim() ? `role name contains "${f.search.trim()}"` : 'no role-name search',
    f.showAll || hasPrivilegeFilter(f) ? 'all roles' : `only roles that grant something${outcome.hiddenCount > 0 ? ` (${outcome.hiddenCount} hidden)` : ''}`,
  ];
  if (hasPrivilegeFilter(f)) {
    const ops = f.privileges.length > 0 ? f.privileges.map(privilegeLabel).join(' or ') : 'any privilege';
    const ds = f.depths.length > 0 ? f.depths.map(depthLabel).join(' or ') : 'any granting depth';
    parts.push(`${ops} at ${ds}${outcome.unreadableIncluded > 0 ? ` (${outcome.unreadableIncluded} included because a cell could not be read)` : ''}`);
  }
  if (f.holder.trim()) parts.push(`held by a user or team matching "${f.holder.trim()}"`);
  if (f.businessUnit.trim()) parts.push(`Business Unit copy matching "${f.businessUnit.trim()}"`);
  if (hasHolderFilter(f) && outcome.notChecked.length > 0) parts.push(`${outcome.notChecked.length} role(s) not checked (assignments not loaded)`);
  if (hasHolderFilter(f) && outcome.couldNotCheck > 0) parts.push(`${outcome.couldNotCheck} role(s) listed although their assignments could not be read completely`);
  return parts.join('; ');
}
