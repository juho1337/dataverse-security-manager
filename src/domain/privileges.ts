// Canonical, UI-independent vocabulary (shared contract ids; display labels live in the UI layer).

/** Dataverse privilege depths, lowest to highest. `None` = the role explicitly grants no access. */
export const DEPTH_IDS = ['None', 'Basic', 'Local', 'Deep', 'Global'] as const;
export type DepthId = (typeof DEPTH_IDS)[number];

/** The eight table privileges, always shown in this order. */
export const PRIVILEGE_IDS = ['Create', 'Read', 'Write', 'Delete', 'Append', 'AppendTo', 'Assign', 'Share'] as const;
export type PrivilegeId = (typeof PRIVILEGE_IDS)[number];

/**
 * One matrix cell. The four kinds are deliberately distinct and must never be collapsed:
 * - `depth`: the role has the privilege at that depth (`None` included).
 * - `noGrant`: the role has no entry for this privilege on the table.
 * - `notApplicable`: the table has no such privilege (for example Assign on a non-ownable table).
 * - `unknown`: could not be determined (read failed or partial); never to be shown as None.
 */
export type CellValue =
  | { readonly kind: 'depth'; readonly depth: DepthId }
  | { readonly kind: 'noGrant' }
  | { readonly kind: 'notApplicable' }
  | { readonly kind: 'unknown' };

export type PrivilegeCells = Readonly<Record<PrivilegeId, CellValue>>;

export interface TableInfo {
  readonly logicalName: string;
  readonly displayName: string;
  readonly supported: boolean;
  /** Why the table is not supported (shown when unsupported tables are listed). */
  readonly unsupportedReason?: string;
}

/** Collapsed-row figures for a logical role, available before the (lazily loaded) details. */
export interface RoleSummary {
  readonly instanceCount: number;
  readonly uniqueUsers: number;
  readonly teams: number;
  /** False when the data behind the numbers is incomplete: the numbers are then lower bounds. */
  readonly complete: boolean;
  /** True when the Business Unit copies of this role disagree on this table. */
  readonly instancesDiffer: boolean;
}

/**
 * What the matrix knows about a logical role's Business Unit copies without loading users: counted from the roles read for the table.
 * The row of a family shows the ROOT role's cells; the copies are listed (with their own cells) when the row is expanded.
 */
export interface RoleLineage {
  /** The root plus the copies found in the loaded data (an orphan copy counts as 1). */
  readonly instanceCount: number;
  /** A copy that stores privileges on this table disagrees with the root on at least one privilege (cells that are unknown are not compared). */
  readonly instancesDiffer: boolean;
  /**
   * Copies that store NO privilege on this table while the root may hold some. They are not compared: on the real Developer environment
   * the copies of the system roles store no grants at all (the root holds them), so "no stored grant" is not evidence of a difference.
   */
  readonly copiesWithoutStoredGrants: number;
  /** Any instance of the family grants (or has unknown cells on) this table: the family is relevant even when the root grants nothing. */
  readonly anyInstanceGrants: boolean;
  /** A copy whose root role is not in the loaded data (incomplete lineage): shown as its own row, never edited. */
  readonly rootMissing?: boolean;
}

export interface RoleRow {
  /** Root role id: the identity of the logical role (its Business Unit copies are loaded on expansion). */
  readonly roleId: string;
  readonly name: string;
  /** Whether the role is managed (belongs to a solution). Absent when it could not be read: such a role is never treated as editable. */
  readonly isManaged?: boolean;
  /** Id of the root role this record was copied from; `null` for a root role. Absent when lineage could not be read: never treated as a root. */
  readonly parentRootRoleId?: string | null;
  readonly cells: PrivilegeCells;
  readonly summary?: RoleSummary;
  /** Present when roles are grouped by lineage (one row per logical role). */
  readonly lineage?: RoleLineage;
}

export interface RoleMatrix {
  readonly table: TableInfo;
  readonly roles: readonly RoleRow[];
  /** Dataverse privilege ids of this table by operation (what an edit writes). Absent for a privilege the table does not have. */
  readonly privilegeCatalog?: Readonly<Partial<Record<PrivilegeId, string>>>;
}

/** True when the role grants anything on the table (a depth other than None). */
export function grantsAnything(row: RoleRow): boolean {
  return PRIVILEGE_IDS.some((p) => {
    const c = row.cells[p];
    return c.kind === 'depth' && c.depth !== 'None';
  });
}

/** True when any cell could not be determined. */
export function hasUnknownCell(row: RoleRow): boolean {
  return PRIVILEGE_IDS.some((p) => row.cells[p].kind === 'unknown');
}
