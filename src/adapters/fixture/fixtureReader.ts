import type { RoleFamily, RoleInstance } from '../../domain/access';
import { countAssignments, differingPrivileges } from '../../domain/access';
import { PRIVILEGE_IDS } from '../../domain/privileges';
import type { PrivilegeCells, PrivilegeId, RoleMatrix, RoleRow, TableInfo } from '../../domain/privileges';
import type { ReadResult, SecurityDataReader } from '../../ports/securityDataReader';
import { BU_HQ, INSTANCE_SEEDS, T_DELIVERY_PARTIAL } from './syntheticAccess';
import type { InstanceSeed } from './syntheticAccess';
import { FAILING_TABLE, PARTIAL_ROLES, PARTIAL_TABLE, ROLES_BY_TABLE, SYNTHETIC_TABLES } from './syntheticData';

export interface FixtureReaderOptions {
  /** Artificial latency so loading states are observable (0 in tests). */
  readonly latencyMs?: number;
  readonly tables?: readonly TableInfo[];
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

/** On the partial-data table the team memberships of "Project Contributor" are only partly readable. */
const partialMembershipRole = (table: string, rootRoleId: string): boolean => table === PARTIAL_TABLE && rootRoleId === 'r-contrib';

const PARTIAL_NOTE =
  'Team memberships of this role could not be read completely: a membership row refers to a user that was not read, so user and team counts are lower bounds (≥).';

/** Fictional privilege ids for the demo data (never real Dataverse ids). */
const SYNTHETIC_CATALOG: Readonly<Partial<Record<PrivilegeId, string>>> = Object.fromEntries(
  PRIVILEGE_IDS.map((p, i) => [p, `99999999-0000-0000-0000-${String(i + 1).padStart(12, '0')}`]),
);

function rolesFor(table: string): readonly RoleRow[] {
  return table === PARTIAL_TABLE ? PARTIAL_ROLES : (ROLES_BY_TABLE[table] ?? []);
}

function buildFamily(table: string, base: RoleRow): RoleFamily {
  const seeds: readonly InstanceSeed[] = INSTANCE_SEEDS[base.roleId] ?? [
    { roleId: base.roleId, businessUnit: BU_HQ, directUsers: [], teams: [] },
  ];
  const instances: RoleInstance[] = seeds.map((s) => ({
    roleId: s.roleId,
    businessUnitId: s.businessUnit.id,
    businessUnitName: s.businessUnit.name,
    cells: { ...base.cells, ...s.cellOverrides } as PrivilegeCells,
    directUsers: s.directUsers,
    teams: partialMembershipRole(table, base.roleId) ? s.teams.map((t) => (t.teamId === T_DELIVERY_PARTIAL.teamId ? T_DELIVERY_PARTIAL : t)) : s.teams,
  }));
  return { rootRoleId: base.roleId, name: base.name, instances };
}

/** Read-only reader over synthetic data. Never touches a host or Dataverse. */
export class FixtureReader implements SecurityDataReader {
  private readonly latencyMs: number;
  private readonly tables: readonly TableInfo[];

  constructor(options: FixtureReaderOptions = {}) {
    this.latencyMs = options.latencyMs ?? 0;
    this.tables = options.tables ?? SYNTHETIC_TABLES;
  }

  async listTables(): Promise<ReadResult<readonly TableInfo[]>> {
    await sleep(this.latencyMs);
    return { status: 'ok', data: this.tables };
  }

  async loadRoleMatrix(tableLogicalName: string): Promise<ReadResult<RoleMatrix>> {
    await sleep(this.latencyMs);
    const table = this.tables.find((t) => t.logicalName === tableLogicalName);
    if (!table) return { status: 'error', errorClass: 'notFound', message: `Table '${tableLogicalName}' was not found.` };
    if (!table.supported) {
      return { status: 'error', errorClass: 'notFound', message: table.unsupportedReason ?? 'This table is not supported.' };
    }
    if (tableLogicalName === FAILING_TABLE) {
      return { status: 'error', errorClass: 'network', message: 'The security roles could not be loaded (simulated failure).' };
    }
    const roles = rolesFor(tableLogicalName).map((row): RoleRow => {
      const family = buildFamily(tableLogicalName, row);
      const counts = countAssignments(family.instances);
      return {
        ...row,
        isManaged: false,
        parentRootRoleId: null,
        summary: {
          instanceCount: family.instances.length,
          uniqueUsers: counts.uniqueUsers,
          teams: counts.teams,
          complete: !partialMembershipRole(tableLogicalName, row.roleId),
          instancesDiffer: differingPrivileges(family.instances).length > 0,
        },
      };
    });
    if (tableLogicalName === PARTIAL_TABLE) {
      return {
        status: 'partial',
        data: { table, roles, privilegeCatalog: SYNTHETIC_CATALOG },
        notes: ['Privileges of "Project Contributor" could not be read completely; unknown cells are marked "?".'],
      };
    }
    return { status: 'ok', data: { table, roles, privilegeCatalog: SYNTHETIC_CATALOG } };
  }

  async loadRoleDetails(tableLogicalName: string, rootRoleId: string): Promise<ReadResult<RoleFamily>> {
    await sleep(this.latencyMs);
    const base = rolesFor(tableLogicalName).find((r) => r.roleId === rootRoleId);
    if (!base) return { status: 'error', errorClass: 'notFound', message: `Role '${rootRoleId}' was not found for this table.` };
    const family = buildFamily(tableLogicalName, base);
    if (partialMembershipRole(tableLogicalName, rootRoleId)) return { status: 'partial', data: family, notes: [PARTIAL_NOTE] };
    return { status: 'ok', data: family };
  }
}
