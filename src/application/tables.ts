import type { RoleRow, TableInfo } from '../domain/privileges';
import { grantsAnything } from '../domain/privileges';

/** Table list filter: matches display name OR logical name (case-insensitive); prefix matches first, then alphabetical. */
export function filterTables(tables: readonly TableInfo[], query: string, showUnsupported: boolean): TableInfo[] {
  const q = query.trim().toLowerCase();
  const rank = (t: TableInfo): number => {
    if (!q) return 0;
    const dn = t.displayName.toLowerCase();
    const ln = t.logicalName.toLowerCase();
    if (dn.startsWith(q) || ln.startsWith(q)) return 0;
    if (dn.includes(q) || ln.includes(q)) return 1;
    return -1;
  };
  return tables
    .filter((t) => (showUnsupported || t.supported) && rank(t) >= 0)
    .sort((a, b) => rank(a) - rank(b) || a.displayName.localeCompare(b.displayName));
}

export function countUnsupported(tables: readonly TableInfo[]): number {
  return tables.filter((t) => !t.supported).length;
}

export interface RoleFilterResult {
  readonly rows: readonly RoleRow[];
  /** Roles hidden because they grant nothing (relevant-roles default). */
  readonly hiddenCount: number;
}

/** Relevant roles (granting something) by default; role-name search; "show all" lists the rest. */
export function filterRoles(roles: readonly RoleRow[], search: string, showAll: boolean): RoleFilterResult {
  const q = search.trim().toLowerCase();
  const byName = roles.filter((r) => !q || r.name.toLowerCase().includes(q));
  const rows = showAll ? byName : byName.filter(grantsOrUnknown);
  return {
    rows: [...rows].sort((a, b) => a.name.localeCompare(b.name)),
    hiddenCount: byName.length - rows.length,
  };
}

// A role whose cells are unknown must not be hidden as "grants nothing".
function grantsOrUnknown(r: RoleRow): boolean {
  // A family is relevant when its root or any copy grants (or is unknown on) the table.
  return grantsAnything(r) || Object.values(r.cells).some((c) => c.kind === 'unknown') || r.lineage?.anyInstanceGrants === true;
}
