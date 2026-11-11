import type { Role, UserAccess } from '../../domain/buMove/types';
import { aggregateTablePrivileges, roleInstancesOfTeam, roleInstancesOfUser, type RoleInstance, type TablePrivileges } from '../../domain/tablePrivileges';
import type { AccessReader, ReadResult, RoleRef, TeamAccess } from '../../ports/accessReader';

// Table privileges of one user or team, derived from the roles they actually hold (direct, and through teams for a user). One aggregation
// (domain/tablePrivileges.ts) over the explicit grants the reader returns; nothing is invented: a gap in the roles, the grants or the
// catalog makes the affected cells unknown and the result partial.

export interface TablePrivilegeAnalysis {
  readonly subject: 'user' | 'team';
  readonly roles: readonly RoleInstance[];
  readonly tables: readonly TablePrivileges[];
}

const unavailable = <T>(): ReadResult<T> => ({ status: 'error', errorClass: 'unknown', message: 'This reader cannot read table privileges.' });

function refsOf(roles: readonly Role[]): RoleRef[] {
  const byId = new Map<string, RoleRef>();
  for (const r of roles) byId.set(r.id, { id: r.id, rootId: r.parentRootRoleId ?? null });
  return [...byId.values()];
}

async function analyze(
  reader: AccessReader,
  subject: 'user' | 'team',
  instances: readonly RoleInstance[],
  roles: readonly Role[],
  rolesComplete: boolean,
  roleNotes: readonly string[],
): Promise<ReadResult<TablePrivilegeAnalysis>> {
  if (!reader.loadRoleGrants) return unavailable();
  if (instances.length === 0) return { status: rolesComplete ? 'ok' : 'partial', data: { subject, roles: instances, tables: [] }, ...(rolesComplete ? {} : { notes: roleNotes }) } as ReadResult<TablePrivilegeAnalysis>;
  const read = await reader.loadRoleGrants(refsOf(roles));
  if (read.status === 'error') return read;
  const tables = aggregateTablePrivileges({ roles: instances, data: read.data, rolesComplete });
  const notes = [...(read.status === 'partial' ? read.notes : []), ...(rolesComplete ? [] : roleNotes)];
  const data: TablePrivilegeAnalysis = { subject, roles: instances, tables };
  return notes.length > 0 ? { status: 'partial', data, notes } : { status: 'ok', data };
}

/** The privileges the roles of a user grant on every table: directly held roles and roles through teams, each source kept. */
export function loadUserTablePrivileges(reader: AccessReader, access: UserAccess): Promise<ReadResult<TablePrivilegeAnalysis>> {
  const roles = [...access.directRoles, ...access.teamRoles].map((g) => g.role);
  return analyze(reader, 'user', roleInstancesOfUser(access), roles, access.isComplete, [
    'The roles of this user were not read completely (team membership or assignments are missing), so a table without a grant here may still be granted by a role that could not be read.',
    ...access.warnings,
  ]);
}

/** The privileges of the roles assigned to the team itself. It does not say what any member effectively has. */
export function loadTeamTablePrivileges(reader: AccessReader, access: TeamAccess): Promise<ReadResult<TablePrivilegeAnalysis>> {
  const rolesComplete = access.rolesComplete !== false;
  return analyze(reader, 'team', roleInstancesOfTeam(access.roles), access.roles.map((r) => r.role), rolesComplete, [
    'The roles of this team were not read completely, so a table without a grant here may still be granted by a role that could not be read.',
    ...(access.roleGaps ?? []),
  ]);
}
