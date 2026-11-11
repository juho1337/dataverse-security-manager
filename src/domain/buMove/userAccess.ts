import type { RoleGrant, SecuritySnapshot, UserAccess } from './types';

/** Case-insensitive ordinal comparison (the C# StringComparer.OrdinalIgnoreCase). */
export function cmp(a: string, b: string): number {
  const x = a.toUpperCase();
  const y = b.toUpperCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

export function buName(snapshot: SecuritySnapshot, businessUnitId: string): string {
  return snapshot.businessUnits.find((b) => b.id === businessUnitId)?.name ?? 'an unknown business unit';
}

export const SCOPE_NOTICE =
  'This lists the security roles a user holds and where each comes from. It evaluates privileges only: record sharing, ' +
  "the user and business unit hierarchy and field security are not evaluated, so it is not a full effective-access analysis.";

/**
 * Direct roles come only from the user's own assignments; team roles only from the roles of the teams the user belongs to, each with its
 * team. Access teams never carry roles (a role reported on one is flagged, not used). Anything that cannot be resolved (unknown team or
 * role, snapshot gaps) becomes a warning so the view says it is incomplete. Port of XrmToolBox UserAccessExplainer.
 */
export function explainUserAccess(snapshot: SecuritySnapshot, userId: string): UserAccess {
  const user = snapshot.users.find((u) => u.id === userId);
  if (!user) throw new Error('The user is not in the snapshot.');
  const roleById = new Map(snapshot.roles.map((r) => [r.id, r]));
  const teamById = new Map(snapshot.teams.map((t) => [t.id, t]));
  const warnings = snapshot.warnings.map((w) => `Data gap: ${w}`);

  const direct: RoleGrant[] = [];
  for (const roleId of new Set(snapshot.directAssignments.filter((a) => a.userId === userId).map((a) => a.roleId))) {
    const role = roleById.get(roleId);
    if (!role) {
      warnings.push(`Direct role ${roleId} is not in the role list.`);
      continue;
    }
    direct.push({ role, roleBusinessUnitName: buName(snapshot, role.businessUnitId), origin: 'direct', team: null, teamBusinessUnitName: null });
  }

  const viaTeams: RoleGrant[] = [];
  for (const teamId of new Set(snapshot.memberships.filter((m) => m.userId === userId).map((m) => m.teamId))) {
    const team = teamById.get(teamId);
    if (!team) {
      warnings.push(`Team ${teamId} is not in the team list.`);
      continue;
    }
    if (team.type === 'Access') {
      if (team.roleIds.length > 0) warnings.push(`Access team ${team.name} reports roles; access teams carry none, so they are ignored.`);
      continue;
    }
    for (const roleId of new Set(team.roleIds)) {
      const role = roleById.get(roleId);
      if (!role) {
        warnings.push(`Role ${roleId} of team ${team.name} is not in the role list.`);
        continue;
      }
      viaTeams.push({
        role,
        roleBusinessUnitName: buName(snapshot, role.businessUnitId),
        origin: 'team',
        team,
        teamBusinessUnitName: buName(snapshot, team.businessUnitId),
      });
    }
  }

  direct.sort((a, b) => cmp(a.role.name, b.role.name) || cmp(a.role.id, b.role.id));
  viaTeams.sort((a, b) => cmp(a.role.name, b.role.name) || cmp(a.team?.name ?? '', b.team?.name ?? '') || cmp(a.role.id, b.role.id));
  return { user, businessUnitName: buName(snapshot, user.businessUnitId), directRoles: direct, teamRoles: viaTeams, warnings, isComplete: warnings.length === 0 };
}
