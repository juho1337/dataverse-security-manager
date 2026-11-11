import type { RoleGrant, UserAccess, UserSummary } from '../../domain/buMove/types';
import { cmp, SCOPE_NOTICE } from '../../domain/buMove/userAccess';

// View-model helpers of the Access Explorer: origin text, status labels, team grouping and the two-user comparison. Pure functions over
// the domain `UserAccess`; nothing here reads data.

export { SCOPE_NOTICE };

/** Port of the XrmToolBox RoleGrant.OriginText. */
export function originText(g: RoleGrant): string {
  if (g.origin === 'direct' || !g.team) return 'direct';
  const bu = g.teamBusinessUnitName ?? 'an unknown business unit';
  if (g.team.type === 'Default') return `via the default team of ${bu}`;
  return `via ${g.team.type.toLowerCase()} team ${g.team.name} in ${bu}`;
}

/** Disabled and application users are always labelled (port of UserAccess.Status). */
export function statusLabel(u: Pick<UserSummary, 'isDisabled' | 'isApplicationUser'>): string {
  const parts: string[] = [];
  if (u.isApplicationUser) parts.push('application user');
  if (u.isDisabled) parts.push('disabled');
  return parts.length === 0 ? 'enabled' : parts.join(', ');
}

export interface TeamRoleGroup {
  readonly teamId: string;
  readonly teamName: string;
  readonly teamTypeText: string;
  readonly teamBusinessUnitName: string;
  readonly heading: string;
  readonly grants: readonly RoleGrant[];
}

/** Team-derived roles grouped by the team they come through (sorted by team name, then id). */
export function groupTeamRoles(access: UserAccess): readonly TeamRoleGroup[] {
  const groups = new Map<string, { team: NonNullable<RoleGrant['team']>; bu: string; grants: RoleGrant[] }>();
  for (const g of access.teamRoles) {
    if (!g.team) continue;
    const entry = groups.get(g.team.id) ?? { team: g.team, bu: g.teamBusinessUnitName ?? 'an unknown business unit', grants: [] };
    entry.grants.push(g);
    groups.set(g.team.id, entry);
  }
  return [...groups.values()]
    .sort((a, b) => cmp(a.team.name, b.team.name) || cmp(a.team.id, b.team.id))
    .map((e) => ({
      teamId: e.team.id,
      teamName: e.team.name,
      teamTypeText: e.team.type === 'Default' ? 'default team' : `${e.team.type.toLowerCase()} team`,
      teamBusinessUnitName: e.bu,
      heading: e.team.type === 'Default' ? `Default team of ${e.bu}` : `${e.team.name} (${e.team.type.toLowerCase()} team, ${e.bu})`,
      grants: e.grants,
    }));
}

export interface RoleHolding {
  readonly roleId: string;
  readonly roleName: string;
  readonly businessUnitName: string;
  /** Every origin through which this user holds the role, as text. */
  readonly origins: readonly string[];
}

export interface AccessComparison {
  readonly left: UserAccess;
  readonly right: UserAccess;
  readonly onlyLeft: readonly RoleHolding[];
  readonly onlyRight: readonly RoleHolding[];
  /** Roles both hold; `left`/`right` list how each holds them (origins may differ). */
  readonly both: readonly { readonly roleId: string; readonly roleName: string; readonly businessUnitName: string; readonly leftOrigins: readonly string[]; readonly rightOrigins: readonly string[] }[];
  /** Either side is incomplete: a role missing from one side may be a data gap, not a difference. */
  readonly incomplete: boolean;
}

function holdings(access: UserAccess): Map<string, RoleHolding> {
  const map = new Map<string, RoleHolding>();
  for (const g of [...access.directRoles, ...access.teamRoles]) {
    const existing = map.get(g.role.id);
    const origin = originText(g);
    if (existing) map.set(g.role.id, { ...existing, origins: [...existing.origins, origin] });
    else map.set(g.role.id, { roleId: g.role.id, roleName: g.role.name, businessUnitName: g.roleBusinessUnitName, origins: [origin] });
  }
  return map;
}

const byName = (a: RoleHolding, b: RoleHolding) => cmp(a.roleName, b.roleName) || cmp(a.businessUnitName, b.businessUnitName) || cmp(a.roleId, b.roleId);

/** Compares by role id, never by name: two same-named roles of different business units are different roles (port of UserAccessComparer). */
export function compareAccess(left: UserAccess, right: UserAccess): AccessComparison {
  const l = holdings(left);
  const r = holdings(right);
  const onlyLeft = [...l.values()].filter((h) => !r.has(h.roleId)).sort(byName);
  const onlyRight = [...r.values()].filter((h) => !l.has(h.roleId)).sort(byName);
  const both = [...l.values()]
    .filter((h) => r.has(h.roleId))
    .sort(byName)
    .map((h) => ({ roleId: h.roleId, roleName: h.roleName, businessUnitName: h.businessUnitName, leftOrigins: h.origins, rightOrigins: r.get(h.roleId)?.origins ?? [] }));
  return { left, right, onlyLeft, onlyRight, both, incomplete: !left.isComplete || !right.isComplete };
}
