import type { RoleGrant, UserAccess } from './buMove/types';
import { DEPTH_IDS, PRIVILEGE_IDS, type CellValue, type DepthId, type PrivilegeCells, type PrivilegeId } from './privileges';

// Table privileges of one user or team, aggregated from the roles they hold. This is the SAME vocabulary as the Role Analyzer (the eight
// privileges, the depth order, and the cell kinds depth / noGrant / notApplicable / unknown): one explicit grant per role and operation, the
// highest one wins, and lower depths are implied by it and never a second grant. Nothing here evaluates ownership, sharing, the user
// hierarchy or field security: it is role-derived privilege only, not effective access to a record.

/** Where a role instance comes from for the person or team being analyzed. */
export type GrantOrigin = { readonly kind: 'direct' } | { readonly kind: 'team'; readonly teamId: string; readonly teamName: string };

/** One concrete role record (the instance of one Business Unit): same-name roles with different ids are different instances. */
export interface RoleInstance {
  readonly roleId: string;
  readonly roleName: string;
  readonly businessUnitName: string;
  readonly origins: readonly GrantOrigin[];
}

/** One explicit grant read from a role instance: this operation on this table at this depth. `None` grants are dropped before aggregation. */
export interface RoleGrantRecord {
  readonly roleId: string;
  readonly table: string;
  readonly operation: PrivilegeId;
  readonly depth: DepthId;
}

/** Which of the eight operations exist for which table (from the privilege catalog); an operation that does not exist is not applicable. */
export type TableCatalog = ReadonlyMap<string, ReadonlySet<PrivilegeId>>;

export interface RoleGrantsData {
  readonly grants: readonly RoleGrantRecord[];
  readonly catalog: TableCatalog;
  /** Logical name -> display name; a table without an entry is shown by its logical name. */
  readonly tableNames: ReadonlyMap<string, string>;
  /** False when a part of the grants or of the catalog could not be read: absence is then unprovable. */
  readonly complete: boolean;
  /** False when the privilege catalog (which operations a table has) was read only in part: a missing operation is then unknown, not "not applicable". Absent = complete. */
  readonly catalogComplete?: boolean;
}

export interface Contributor {
  readonly roleId: string;
  readonly roleName: string;
  readonly businessUnitName: string;
  readonly depth: Exclude<DepthId, 'None'>;
  readonly origins: readonly GrantOrigin[];
  /** True when this grant is at the aggregate's depth (several roles can determine it together). */
  readonly determinesAggregate: boolean;
}

export interface OperationAggregate {
  readonly cell: CellValue;
  /** Highest depth first, then by role name. Empty for noGrant / notApplicable / unknown. */
  readonly contributors: readonly Contributor[];
  /** True when every role and grant that could contribute was read, so the contributor list is exhaustive. */
  readonly complete?: boolean;
}

export interface TablePrivileges {
  readonly logicalName: string;
  readonly displayName: string;
  readonly operations: Readonly<Record<PrivilegeId, OperationAggregate>>;
  /** True when at least one cell is unknown (a gap in the roles, the grants or the catalog). */
  readonly partial: boolean;
}

export interface AggregateInput {
  readonly roles: readonly RoleInstance[];
  readonly data: RoleGrantsData;
  /** False when the person's or team's roles were not read completely (membership or assignments missing): empty cells are then unknown. */
  readonly rolesComplete: boolean;
}

const rank = (d: DepthId): number => DEPTH_IDS.indexOf(d);

export function mergeOrigins(a: readonly GrantOrigin[], b: readonly GrantOrigin[]): readonly GrantOrigin[] {
  const out: GrantOrigin[] = [...a];
  for (const o of b) {
    const same = out.some((x) => (x.kind === 'direct' ? o.kind === 'direct' : o.kind === 'team' && o.teamId === x.teamId));
    if (!same) out.push(o);
  }
  return out;
}

/** The role instances of a user, one per role id, with every way the user gets each one (directly, through one or more teams). */
export function roleInstancesOfUser(access: UserAccess): readonly RoleInstance[] {
  const byId = new Map<string, RoleInstance>();
  const add = (g: RoleGrant, origin: GrantOrigin) => {
    const prior = byId.get(g.role.id);
    byId.set(g.role.id, {
      roleId: g.role.id,
      roleName: g.role.name,
      businessUnitName: g.roleBusinessUnitName,
      origins: mergeOrigins(prior?.origins ?? [], [origin]),
    });
  };
  for (const g of access.directRoles) add(g, { kind: 'direct' });
  for (const g of access.teamRoles) if (g.team) add(g, { kind: 'team', teamId: g.team.id, teamName: g.team.name });
  return [...byId.values()];
}

/** The role instances assigned to a team itself (not the privileges its members effectively have). */
export function roleInstancesOfTeam(roles: readonly { readonly role: { readonly id: string; readonly name: string }; readonly businessUnitName: string | null }[]): readonly RoleInstance[] {
  return roles.map((r) => ({ roleId: r.role.id, roleName: r.role.name, businessUnitName: r.businessUnitName ?? 'business unit not read', origins: [{ kind: 'direct' }] }));
}

/**
 * Aggregates the explicit grants of the given role instances per table and operation: the highest granted depth wins, every contributor is
 * kept with its origin, and a cell without any contributor is `noGrant` only when everything was read (otherwise `unknown`). Only tables that
 * at least one of the roles grants something on are returned.
 */
export function aggregateTablePrivileges(input: AggregateInput): readonly TablePrivileges[] {
  const { roles, data, rolesComplete } = input;
  const instance = new Map(roles.map((r) => [r.roleId.toLowerCase(), r]));
  const known = rolesComplete && data.complete;

  // table -> operation -> grants from the roles of this person or team
  const byTable = new Map<string, Map<PrivilegeId, { readonly role: RoleInstance; readonly depth: Exclude<DepthId, 'None'> }[]>>();
  for (const g of data.grants) {
    if (g.depth === 'None') continue;
    const role = instance.get(g.roleId.toLowerCase());
    if (!role) continue; // a grant of a role this person or team does not hold
    const ops = byTable.get(g.table) ?? new Map();
    const list = ops.get(g.operation) ?? [];
    list.push({ role, depth: g.depth });
    ops.set(g.operation, list);
    byTable.set(g.table, ops);
  }

  const result: TablePrivileges[] = [];
  for (const [table, ops] of byTable) {
    const exists = data.catalog.get(table);
    let partial = false;
    const operations = {} as Record<PrivilegeId, OperationAggregate>;
    for (const op of PRIVILEGE_IDS) {
      const grants = ops.get(op) ?? [];
      if (grants.length > 0) {
        const max = grants.reduce((m, g) => (rank(g.depth) > rank(m) ? g.depth : m), grants[0]!.depth);
        const contributors = grants
          .map((g): Contributor => ({ roleId: g.role.roleId, roleName: g.role.roleName, businessUnitName: g.role.businessUnitName, depth: g.depth, origins: g.role.origins, determinesAggregate: g.depth === max }))
          .sort((a, b) => rank(b.depth) - rank(a.depth) || a.roleName.localeCompare(b.roleName) || a.roleId.localeCompare(b.roleId));
        operations[op] = { cell: { kind: 'depth', depth: max }, contributors, complete: known };
      } else if (exists !== undefined && !exists.has(op) && data.catalogComplete !== false) {
        operations[op] = { cell: { kind: 'notApplicable' }, contributors: [], complete: true };
      } else if (known) {
        operations[op] = { cell: { kind: 'noGrant' }, contributors: [], complete: true };
      } else {
        partial = true;
        operations[op] = { cell: { kind: 'unknown' }, contributors: [], complete: false };
      }
    }
    result.push({ logicalName: table, displayName: data.tableNames.get(table) ?? table, operations, partial });
  }
  return result.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.logicalName.localeCompare(b.logicalName));
}

/** The aggregate of one table as plain cells (the Role Analyzer's row shape), for the shared letter and depth rendering. */
export function cellsOf(table: TablePrivileges): PrivilegeCells {
  return Object.fromEntries(PRIVILEGE_IDS.map((op) => [op, table.operations[op].cell])) as PrivilegeCells;
}

/**
 * What removing one contributor would do to the aggregate of an operation: nothing when another grant at the same depth remains, a drop to the
 * next highest grant when it was the only one at the top, or the loss of the privilege when it was the only grant. Stated, never guessed:
 * anything else (an unknown cell) says so.
 */
export function removalEffect(op: OperationAggregate, roleId: string): { readonly kind: 'nothing' | 'lowers' | 'removes' | 'unknown'; readonly to?: Exclude<DepthId, 'None'> } {
  if (op.cell.kind !== 'depth') return { kind: 'unknown' };
  const exhaustive = op.complete !== false;
  const mine = op.contributors.find((c) => c.roleId.toLowerCase() === roleId.toLowerCase());
  if (!mine) return { kind: 'unknown' };
  const others = op.contributors.filter((c) => c.roleId.toLowerCase() !== roleId.toLowerCase());
  // A role whose grants could not be read can only ADD grants: "nothing changes" stays true, but "it would lower / remove" might not be.
  if (others.length === 0) return exhaustive ? { kind: 'removes' } : { kind: 'unknown' };
  const top = others.reduce((m, c) => (rank(c.depth) > rank(m) ? c.depth : m), others[0]!.depth);
  if (rank(top) >= rank(op.cell.depth)) return { kind: 'nothing' };
  return exhaustive ? { kind: 'lowers', to: top } : { kind: 'unknown' };
}
