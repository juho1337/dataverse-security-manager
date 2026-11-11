import { PRIVILEGE_IDS, grantsAnything, hasUnknownCell, type CellValue, type PrivilegeId, type RoleLineage, type RoleRow } from './privileges';

// Groups the role records read for a table into ONE row per logical role (its root), like the legacy tool: identity is the role id and the
// root-role lineage, never the display name, so two roles with the same name stay separate rows. Pure; no host access.

const cellKey = (c: CellValue): string => (c.kind === 'depth' ? `depth:${c.depth}` : c.kind);
const storesAnyGrant = (r: RoleRow): boolean => PRIVILEGE_IDS.some((p) => r.cells[p].kind === 'depth');

/** Privileges on which a copy disagrees with the root; a cell that is unknown on either side is not compared (it proves nothing). */
function differsFromRoot(root: RoleRow, copy: RoleRow): PrivilegeId[] {
  return PRIVILEGE_IDS.filter((p) => {
    const a = root.cells[p];
    const b = copy.cells[p];
    if (a.kind === 'unknown' || b.kind === 'unknown') return false;
    return cellKey(a) !== cellKey(b);
  });
}

function lineageOf(root: RoleRow, copies: readonly RoleRow[]): RoleLineage {
  let differ = false;
  let withoutGrants = 0;
  for (const c of copies) {
    if (!storesAnyGrant(c) && !hasUnknownCell(c)) {
      withoutGrants++;
      continue;
    }
    if (differsFromRoot(root, c).length > 0) differ = true;
  }
  const anyGrants = [root, ...copies].some((r) => grantsAnything(r) || hasUnknownCell(r));
  return { instanceCount: 1 + copies.length, instancesDiffer: differ, copiesWithoutStoredGrants: withoutGrants, anyInstanceGrants: anyGrants };
}

/**
 * One row per root role (with `lineage`); a copy whose root is not in the data stays its own row marked `rootMissing`. When the lineage of
 * any record could not be read (`parentRootRoleId` absent) nothing is grouped: grouping on a guess would hide or merge roles.
 */
export function groupRolesByLineage(roles: readonly RoleRow[]): RoleRow[] {
  if (roles.some((r) => r.parentRootRoleId === undefined)) return [...roles];
  const rootIds = new Set(roles.filter((r) => r.parentRootRoleId === null).map((r) => r.roleId.toLowerCase()));
  const copiesOf = new Map<string, RoleRow[]>();
  const out: RoleRow[] = [];
  for (const r of roles) {
    if (r.parentRootRoleId === null) continue;
    const root = (r.parentRootRoleId ?? '').toLowerCase();
    if (rootIds.has(root)) copiesOf.set(root, [...(copiesOf.get(root) ?? []), r]);
    else out.push({ ...r, lineage: { instanceCount: 1, instancesDiffer: false, copiesWithoutStoredGrants: 0, anyInstanceGrants: grantsAnything(r) || hasUnknownCell(r), rootMissing: true } });
  }
  for (const r of roles) {
    if (r.parentRootRoleId !== null) continue;
    out.push({ ...r, lineage: lineageOf(r, copiesOf.get(r.roleId.toLowerCase()) ?? []) });
  }
  return out;
}
