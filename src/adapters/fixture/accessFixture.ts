import { explainUserAccess } from '../../domain/buMove/userAccess';
import type { BusinessUnit, Role, SecuritySnapshot, Team, TeamType, UserAccess, UserSummary } from '../../domain/buMove/types';
import type { PrivilegeId } from '../../domain/privileges';
import type { RoleGrantRecord, RoleGrantsData } from '../../domain/tablePrivileges';
import { SEARCH_LIMIT, TEAM_MEMBER_LIMIT, type AccessReader, type NameRequest, type ReadResult, type ResolvedNames, type RoleRef, type TeamAccess, type TeamSummary, type UserHit } from '../../ports/accessReader';

// Synthetic Access Explorer data for demo mode and tests: fictional people, teams and roles (example.test addresses, no customer or
// legacy material). Deliberate cases: a role held directly AND through a team, a role only through a default team, an access team
// that carries no role, a disabled user, an application user, and a user whose team membership cannot be resolved (partial data).

const bu = (id: string, name: string, parentId: string | null): BusinessUnit => ({ id, name, parentId, isDisabled: false });
const role = (id: string, name: string, businessUnitId: string): Role => ({ id, name, businessUnitId, parentRoleId: null, parentRootRoleId: null, isManaged: false });
const user = (id: string, fullName: string, businessUnitId: string, extra: Partial<UserSummary> = {}): UserSummary => ({
  id,
  fullName,
  email: `${fullName.toLowerCase().replace(/[^a-z]+/g, '.')}@example.test`,
  businessUnitId,
  isDisabled: false,
  isApplicationUser: false,
  ...extra,
});
const team = (id: string, name: string, businessUnitId: string, type: TeamType, roleIds: readonly string[]): Team => ({ id, name, businessUnitId, type, roleIds });

export const SYNTHETIC_ACCESS_SNAPSHOT: SecuritySnapshot = {
  businessUnits: [bu('bu-hq', 'Contoso', null), bu('bu-north', 'North', 'bu-hq')],
  roles: [
    role('r-basic', 'Basic User', 'bu-hq'),
    role('r-admin', 'System Administrator', 'bu-hq'),
    role('r-contrib', 'Project Contributor', 'bu-hq'),
    role('r-contrib-north', 'Project Contributor', 'bu-north'),
    role('r-sales', 'Sales Manager', 'bu-north'),
  ],
  users: [
    user('u-ann', 'Ann Admin', 'bu-hq'),
    user('u-ben', 'Ben Brooks', 'bu-north'),
    user('u-cara', 'Cara Cole', 'bu-hq'),
    user('u-finn', 'Finn Fox', 'bu-north', { isDisabled: true }),
    user('u-svc', 'Svc Integration', 'bu-hq', { isApplicationUser: true, email: '' }),
    user('u-pat', 'Pat Partial', 'bu-hq'),
  ],
  teams: [
    team('t-default-hq', 'Contoso', 'bu-hq', 'Default', ['r-basic']),
    team('t-default-north', 'North', 'bu-north', 'Default', ['r-basic']),
    team('t-delivery', 'Project Delivery', 'bu-hq', 'Owner', ['r-contrib']),
    team('t-leads', 'Regional Leads', 'bu-north', 'Owner', ['r-sales', 'r-contrib-north']),
    team('t-reviewers', 'Reviewers', 'bu-hq', 'Access', []),
  ],
  directAssignments: [
    { userId: 'u-ann', roleId: 'r-admin' },
    { userId: 'u-ann', roleId: 'r-contrib' },
    { userId: 'u-cara', roleId: 'r-contrib' },
    { userId: 'u-ben', roleId: 'r-contrib-north' },
    { userId: 'u-finn', roleId: 'r-contrib-north' },
    { userId: 'u-pat', roleId: 'r-basic' },
  ],
  memberships: [
    { userId: 'u-ann', teamId: 't-default-hq' },
    { userId: 'u-ann', teamId: 't-delivery' },
    { userId: 'u-ann', teamId: 't-reviewers' },
    { userId: 'u-cara', teamId: 't-default-hq' },
    { userId: 'u-cara', teamId: 't-delivery' },
    { userId: 'u-ben', teamId: 't-default-north' },
    { userId: 'u-ben', teamId: 't-leads' },
    { userId: 'u-finn', teamId: 't-default-north' },
    { userId: 'u-svc', teamId: 't-default-hq' },
    { userId: 'u-pat', teamId: 't-default-hq' },
    // Partial data: this team row was not read, so what Pat gets through it is unknown, never "nothing".
    { userId: 'u-pat', teamId: 't-unread' },
  ],
  settings: { enableOwnershipAcrossBusinessUnits: null, doNotRemoveRolesOnChangeBusinessUnit: null, alwaysMoveRecordToOwnerBusinessUnit: null, notes: [] },
  warnings: [],
};

export interface FixtureAccessReaderOptions {
  /** Artificial latency so loading states are observable (0 in tests). */
  readonly latencyMs?: number;
  readonly snapshot?: SecuritySnapshot;
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());
const has = (text: string, part: string) => text.toLowerCase().includes(part.toLowerCase());

const ALL_OPS: readonly PrivilegeId[] = ['Create', 'Read', 'Write', 'Delete', 'Append', 'AppendTo', 'Assign', 'Share'];
const everything = (roleId: string, table: string, depth: RoleGrantRecord['depth']): RoleGrantRecord[] => ALL_OPS.map((operation) => ({ roleId, table, operation, depth }));

/** Synthetic explicit grants of the demo roles (a few tables, different depths), so the table privilege analysis has something to show. */
export const SYNTHETIC_ROLE_GRANTS: RoleGrantsData = {
  grants: [
    ...everything('r-admin', 'account', 'Global'),
    ...everything('r-admin', 'contoso_project', 'Global').filter((g) => g.operation !== 'Assign'),
    { roleId: 'r-basic', table: 'account', operation: 'Read', depth: 'Basic' },
    { roleId: 'r-basic', table: 'contoso_project', operation: 'Read', depth: 'Basic' },
    { roleId: 'r-contrib', table: 'contoso_project', operation: 'Create', depth: 'Local' },
    { roleId: 'r-contrib', table: 'contoso_project', operation: 'Read', depth: 'Global' },
    { roleId: 'r-contrib', table: 'contoso_project', operation: 'Write', depth: 'Deep' },
    { roleId: 'r-contrib', table: 'account', operation: 'Read', depth: 'Local' },
    { roleId: 'r-contrib-north', table: 'contoso_project', operation: 'Read', depth: 'Local' },
    { roleId: 'r-sales', table: 'account', operation: 'Create', depth: 'Deep' },
    { roleId: 'r-sales', table: 'account', operation: 'Read', depth: 'Deep' },
  ],
  catalog: new Map<string, ReadonlySet<PrivilegeId>>([
    ['account', new Set(ALL_OPS)],
    ['contoso_project', new Set(ALL_OPS.filter((o) => o !== 'Assign'))],
  ]),
  tableNames: new Map([['account', 'Account'], ['contoso_project', 'Contoso Project']]),
  complete: true,
};

export class FixtureAccessReader implements AccessReader {
  private readonly snapshot: SecuritySnapshot;
  private readonly latencyMs: number;

  constructor(options: FixtureAccessReaderOptions = {}) {
    this.snapshot = options.snapshot ?? SYNTHETIC_ACCESS_SNAPSHOT;
    this.latencyMs = options.latencyMs ?? 0;
  }

  private buName(id: string): string | null {
    return this.snapshot.businessUnits.find((b) => b.id === id)?.name ?? null;
  }
  private hit(u: UserSummary): UserHit {
    return { user: u, businessUnitName: this.buName(u.businessUnitId) };
  }
  private summary(t: Team): TeamSummary {
    return { id: t.id, name: t.name, type: t.type, businessUnitId: t.businessUnitId, businessUnitName: this.buName(t.businessUnitId) };
  }

  async searchUsers(query: string): Promise<ReadResult<readonly UserHit[]>> {
    await sleep(this.latencyMs);
    const q = query.trim();
    if (q.length < 2) return { status: 'ok', data: [] };
    const found = this.snapshot.users
      .filter((u) => has(u.fullName, q) || has(u.email, q))
      .sort((a, b) => a.fullName.localeCompare(b.fullName) || a.id.localeCompare(b.id));
    const data = found.slice(0, SEARCH_LIMIT).map((u) => this.hit(u));
    return found.length > SEARCH_LIMIT ? { status: 'partial', data, notes: [`Only the first ${SEARCH_LIMIT} matches are shown; refine the search to see others.`] } : { status: 'ok', data };
  }

  async searchTeams(query: string): Promise<ReadResult<readonly TeamSummary[]>> {
    await sleep(this.latencyMs);
    const q = query.trim();
    if (q.length < 2) return { status: 'ok', data: [] };
    const found = this.snapshot.teams.filter((t) => has(t.name, q)).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { status: 'ok', data: found.slice(0, SEARCH_LIMIT).map((t) => this.summary(t)) };
  }

  async loadUserAccess(userId: string): Promise<ReadResult<UserAccess>> {
    await sleep(this.latencyMs);
    if (!this.snapshot.users.some((u) => u.id === userId)) return { status: 'error', errorClass: 'notFound', message: 'The user was not found.' };
    const access = explainUserAccess(this.snapshot, userId);
    return access.isComplete ? { status: 'ok', data: access } : { status: 'partial', data: access, notes: access.warnings };
  }

  async listRolesOfBusinessUnit(businessUnitId: string): Promise<ReadResult<readonly Role[]>> {
    await sleep(this.latencyMs);
    return { status: 'ok', data: this.snapshot.roles.filter((r) => r.businessUnitId === businessUnitId).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) };
  }

  async resolveNames(request: NameRequest): Promise<ReadResult<ResolvedNames>> {
    await sleep(this.latencyMs);
    const users = new Map<string, string>();
    for (const id of request.users ?? []) {
      const u = this.snapshot.users.find((x) => x.id.toLowerCase() === id.toLowerCase());
      if (u) users.set(id.toLowerCase(), u.fullName);
    }
    const roles = new Map<string, string>();
    for (const id of request.roles ?? []) {
      const r = this.snapshot.roles.find((x) => x.id.toLowerCase() === id.toLowerCase());
      if (r) roles.set(id.toLowerCase(), r.name);
    }
    return { status: 'ok', data: { users, roles } };
  }

  async loadRoleGrants(roles: readonly RoleRef[]): Promise<ReadResult<RoleGrantsData>> {
    await sleep(this.latencyMs);
    const wanted = new Set(roles.map((r) => r.id));
    return { status: 'ok', data: { ...SYNTHETIC_ROLE_GRANTS, grants: SYNTHETIC_ROLE_GRANTS.grants.filter((g) => wanted.has(g.roleId)) } };
  }

  async loadTeamAccess(teamId: string): Promise<ReadResult<TeamAccess>> {
    await sleep(this.latencyMs);
    const t = this.snapshot.teams.find((x) => x.id === teamId);
    if (!t) return { status: 'error', errorClass: 'notFound', message: 'The team was not found.' };
    const memberIds = new Set(this.snapshot.memberships.filter((m) => m.teamId === teamId).map((m) => m.userId));
    const all = this.snapshot.users.filter((u) => memberIds.has(u.id)).sort((a, b) => a.fullName.localeCompare(b.fullName));
    const roles = (t.type === 'Access' ? [] : t.roleIds)
      .map((rid) => this.snapshot.roles.find((r) => r.id === rid))
      .filter((r): r is Role => r !== undefined)
      .map((r) => ({ role: r, businessUnitName: this.buName(r.businessUnitId) }));
    const data: TeamAccess = { team: this.summary(t), roles, members: all.slice(0, TEAM_MEMBER_LIMIT).map((u) => this.hit(u)), membersTruncated: all.length > TEAM_MEMBER_LIMIT };
    return data.membersTruncated ? { status: 'partial', data, notes: [`Only the first ${TEAM_MEMBER_LIMIT} members are listed; the team has more.`] } : { status: 'ok', data };
  }
}
