import { explainUserAccess } from '../../domain/buMove/userAccess';
import type { BusinessUnit, Role, SecuritySnapshot, Team, TeamType, UserAccess, UserSummary } from '../../domain/buMove/types';
import type { PrivilegeId } from '../../domain/privileges';
import type { RoleGrantRecord, RoleGrantsData } from '../../domain/tablePrivileges';
import { ROLE_LIST_LIMIT, SEARCH_LIMIT, TEAM_MEMBER_LIMIT, type AccessReader, type NameRequest, type ReadResult, type ResolvedNames, type RoleRef, type TeamAccess, type TeamSummary, type UserHit } from '../../ports/accessReader';
import { lockedEnvironment, type ApprovedEnvironment } from './config';
import type { HostWindow } from './connection';
import { classifyHostError, ConnectionChangedError, toPortErrorClass, withRetry, type ClassifiedError, type RetryOptions } from './errors';
import { connectionFingerprint, normalizeUrl, readConnectionIdentity, verifyHostEnvironment, type IdentityResult } from './identity';
import { normalizeParentRoot } from './lineage';
import { ACCESS_RIGHT_TO_PRIVILEGE, depthFromMask, displayNameOf, privilegeFetch } from './reader';
import { createPageNumberStrategy, type PagedRows, type PagingStrategy } from './paging';
import { createReadOnlyHost, type ReadOnlyHost } from './readOnlyHost';

// Read-only Access Explorer reader over the PPTB host (issue #269). Same guard as the Role Analyzer reader: the environment identity
// check first, a connection fingerprint bracketing every host request, retries for transient errors, and only the ReadOnlyHost facade.
// UNVERIFIED against the real host (no live evidence exists for this reader; it is tested against a fake host only):
//  - the shape of lookup columns in FetchXML results (`businessunitid` vs `_businessunitid_value`; both are accepted) and of aliased
//    link-entity columns (`bu.name` vs `bu_x002e_name`; both are accepted),
//  - that the intersect tables systemuserroles, teamroles and teammembership can be queried with FetchXML on their id columns,
//  - FetchXML `top` and `like` behaviour, and paging (see paging.ts).

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IN_CHUNK = 50;
/** Names are resolved for at most this many ids per kind in one call. */
const NAME_LIMIT = 50;
const MAX_QUERY = 100;

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Escapes the SQL LIKE wildcards so a typed `%`, `_` or `[` matches itself. */
const likeEscape = (s: string) => s.replace(/\[/g, '[[]').replace(/%/g, '[%]').replace(/_/g, '[_]');

type Row = Record<string, unknown>;

function text(row: Row, key: string): string | null {
  const v = row[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function id(row: Row, key: string): string | null {
  const v = text(row, key)?.toLowerCase() ?? null;
  return v !== null && GUID.test(v) ? v : null;
}
/** A lookup column: the host may return `col` or `_col_value` (UNVERIFIED which). */
function lookup(row: Row, column: string): string | null {
  return id(row, column) ?? id(row, `_${column}_value`);
}
/** A GUID column of a link-entity: `alias.column`, the OData-encoded `alias_x002e_column`, or the plain name (UNVERIFIED which spelling the host
 *  uses for an alias; verified on the real host 2026-11-03: `alias.column`). */
export function linkedId(row: Row, alias: string, column: string): string | null {
  return id(row, `${alias}.${column}`) ?? id(row, `${alias}_x002e_${column}`) ?? id(row, column);
}
function int(row: Row, key: string): number | null {
  const v = row[key];
  if (typeof v === 'string' && v.trim() === '') return null; // Number('') is 0, which would read as "no privilege" instead of "unreadable"
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) ? n : null;
}
/** Aliased link-entity column: `alias.col` or the OData-encoded `alias_x002e_col` (UNVERIFIED which). */
function aliased(row: Row, alias: string, column: string): string | null {
  const v = row[`${alias}.${column}`] ?? row[`${alias}_x002e_${column}`];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const USER_COLUMNS = ['systemuserid', 'fullname', 'internalemailaddress', 'businessunitid', 'isdisabled', 'applicationid', 'accessmode']
  .map((c) => `<attribute name="${c}"/>`)
  .join('');
const BU_LINK = '<link-entity name="businessunit" from="businessunitid" to="businessunitid" alias="bu" link-type="outer"><attribute name="name"/></link-entity>';
const inValues = (ids: readonly string[]) => ids.map((v) => `<value>${xml(v)}</value>`).join('');

// ---- FetchXML builders (exported for tests)
const paged = (p: number, size: number) => `<fetch page="${p}" count="${size}">`;

export function userSearchFetch(query: string): string {
  const like = `%${xml(likeEscape(query))}%`;
  return (
    `<fetch top="${SEARCH_LIMIT + 1}"><entity name="systemuser">${USER_COLUMNS}<order attribute="fullname"/>` +
    `<filter type="or"><condition attribute="fullname" operator="like" value="${like}"/><condition attribute="internalemailaddress" operator="like" value="${like}"/></filter>` +
    `${BU_LINK}</entity></fetch>`
  );
}
export function teamSearchFetch(query: string): string {
  const like = `%${xml(likeEscape(query))}%`;
  return (
    `<fetch top="${SEARCH_LIMIT + 1}"><entity name="team"><attribute name="teamid"/><attribute name="name"/><attribute name="teamtype"/><attribute name="isdefault"/>` +
    `<attribute name="businessunitid"/><order attribute="name"/><filter><condition attribute="name" operator="like" value="${like}"/></filter>${BU_LINK}</entity></fetch>`
  );
}
export function userFetch(userId: string): string {
  return `<fetch top="1"><entity name="systemuser">${USER_COLUMNS}<filter><condition attribute="systemuserid" operator="eq" value="${xml(userId)}"/></filter>${BU_LINK}</entity></fetch>`;
}
// Many-to-many (intersect) tables are read FROM a parent table through a link-entity (intersect="true"): the PPTB host answers 404 for a fetch
// ROOTED at systemuserroles (verified on the real host 2026-11-03, like roleprivileges). Each row carries the parent key as a plain column and the
// linked column as `alias.column` (or `alias_x002e_column`).
export function userRolesFetch(p: number, size: number, userId: string): string {
  return `${paged(p, size)}<entity name="systemuser"><attribute name="systemuserid"/><filter><condition attribute="systemuserid" operator="eq" value="${xml(userId)}"/></filter><order attribute="systemuserid"/>` +
    `<link-entity name="systemuserroles" from="systemuserid" to="systemuserid" alias="sur" intersect="true"><attribute name="roleid"/><order attribute="roleid"/></link-entity></entity></fetch>`;
}
export function userMembershipsFetch(p: number, size: number, userId: string): string {
  return `${paged(p, size)}<entity name="systemuser"><attribute name="systemuserid"/><filter><condition attribute="systemuserid" operator="eq" value="${xml(userId)}"/></filter><order attribute="systemuserid"/>` +
    `<link-entity name="teammembership" from="systemuserid" to="systemuserid" alias="tm" intersect="true"><attribute name="teamid"/><order attribute="teamid"/></link-entity></entity></fetch>`;
}
export function teamMembersFetch(teamId: string, top: number): string {
  return `<fetch top="${top}"><entity name="team"><attribute name="teamid"/><filter><condition attribute="teamid" operator="eq" value="${xml(teamId)}"/></filter>` +
    `<link-entity name="teammembership" from="teamid" to="teamid" alias="tm" intersect="true"><attribute name="systemuserid"/><order attribute="systemuserid"/></link-entity></entity></fetch>`;
}
export function teamsByIdFetch(p: number, size: number, ids: readonly string[]): string {
  return `${paged(p, size)}<entity name="team"><attribute name="teamid"/><attribute name="name"/><attribute name="teamtype"/><attribute name="isdefault"/><attribute name="businessunitid"/><filter><condition attribute="teamid" operator="in">${inValues(ids)}</condition></filter><order attribute="teamid"/></entity></fetch>`;
}
export function teamRolesFetch(p: number, size: number, teamIds: readonly string[]): string {
  return `${paged(p, size)}<entity name="team"><attribute name="teamid"/><filter><condition attribute="teamid" operator="in">${inValues(teamIds)}</condition></filter><order attribute="teamid"/>` +
    `<link-entity name="teamroles" from="teamid" to="teamid" alias="tr" intersect="true"><attribute name="roleid"/><order attribute="roleid"/></link-entity></entity></fetch>`;
}
export function rolesByIdFetch(p: number, size: number, ids: readonly string[]): string {
  return `${paged(p, size)}<entity name="role"><attribute name="roleid"/><attribute name="name"/><attribute name="businessunitid"/><attribute name="parentrootroleid"/><attribute name="ismanaged"/><filter><condition attribute="roleid" operator="in">${inValues(ids)}</condition></filter><order attribute="roleid"/></entity></fetch>`;
}
/** The roles of one Business Unit (one more than the cap is requested to detect it). */
export function rolesOfBusinessUnitFetch(businessUnitId: string): string {
  return `<fetch top="${ROLE_LIST_LIMIT + 1}"><entity name="role"><attribute name="roleid"/><attribute name="name"/><attribute name="businessunitid"/><attribute name="parentrootroleid"/><attribute name="ismanaged"/><filter><condition attribute="businessunitid" operator="eq" value="${xml(businessUnitId)}"/></filter><order attribute="name"/></entity></fetch>`;
}
/**
 * Grants of the given roles, read FROM the role through the intersect table (a fetch rooted at `roleprivileges` is answered 404 by the PPTB
 * host, verified 2026-11-03). Each row is `roleid` plus the aliased `rp.privilegeid` and `rp.privilegedepthmask`.
 */
export function roleGrantsFetch(p: number, size: number, roleIds: readonly string[]): string {
  const values = roleIds.map((v) => `<value>${xml(v)}</value>`).join('');
  return `<fetch page="${p}" count="${size}"><entity name="role"><attribute name="roleid"/><filter><condition attribute="roleid" operator="in">${values}</condition></filter><order attribute="roleid"/><link-entity name="roleprivileges" from="roleid" to="roleid" alias="rp" intersect="true"><attribute name="privilegeid"/><attribute name="privilegedepthmask"/><order attribute="privilegeid"/></link-entity></entity></fetch>`;
}

export function businessUnitsByIdFetch(p: number, size: number, ids: readonly string[]): string {
  return `${paged(p, size)}<entity name="businessunit"><attribute name="businessunitid"/><attribute name="name"/><filter><condition attribute="businessunitid" operator="in">${inValues(ids)}</condition></filter><order attribute="businessunitid"/></entity></fetch>`;
}
export function usersByIdFetch(p: number, size: number, ids: readonly string[]): string {
  return `${paged(p, size)}<entity name="systemuser">${USER_COLUMNS}<filter><condition attribute="systemuserid" operator="in">${inValues(ids)}</condition></filter><order attribute="systemuserid"/>${BU_LINK}</entity></fetch>`;
}
export function teamFetch(teamId: string): string {
  return `<fetch top="1"><entity name="team"><attribute name="teamid"/><attribute name="name"/><attribute name="teamtype"/><attribute name="isdefault"/><attribute name="businessunitid"/><filter><condition attribute="teamid" operator="eq" value="${xml(teamId)}"/></filter>${BU_LINK}</entity></fetch>`;
}

// ---- row mappers
function teamType(row: Row): TeamType {
  if (row['isdefault'] === true) return 'Default';
  switch (int(row, 'teamtype')) {
    case 0: return 'Owner';
    case 1: return 'Access';
    default: return 'Other';
  }
}

function userOf(row: Row): UserHit | null {
  const userId = id(row, 'systemuserid');
  if (!userId) return null;
  const user: UserSummary = {
    id: userId,
    fullName: text(row, 'fullname') ?? '(no name)',
    email: text(row, 'internalemailaddress') ?? '',
    businessUnitId: lookup(row, 'businessunitid') ?? '',
    isDisabled: row['isdisabled'] === true,
    isApplicationUser: text(row, 'applicationid') !== null,
  };
  return { user, businessUnitName: aliased(row, 'bu', 'name') };
}

function teamOf(row: Row): TeamSummary | null {
  const teamId = id(row, 'teamid');
  if (!teamId) return null;
  return {
    id: teamId,
    name: text(row, 'name') ?? '(unnamed team)',
    type: teamType(row),
    businessUnitId: lookup(row, 'businessunitid') ?? '',
    businessUnitName: aliased(row, 'bu', 'name'),
  };
}

function roleOf(row: Row): Role | null {
  const roleId = id(row, 'roleid');
  if (!roleId) return null;
  return {
    id: roleId,
    name: text(row, 'name') ?? '(unnamed role)',
    businessUnitId: lookup(row, 'businessunitid') ?? '',
    parentRoleId: null,
    parentRootRoleId: ((p) => (p === null ? null : normalizeParentRoot(roleId, p)))(lookup(row, 'parentrootroleid')),
    isManaged: row['ismanaged'] === true,
  };
}

function friendly(c: ClassifiedError): string {
  switch (c.kind) {
    case 'auth': return 'Sign-in to the environment is required or has expired.';
    case 'permission': return 'The signed-in user is not allowed to read this data.';
    case 'throttled': return 'Dataverse is throttling requests; try again shortly.';
    case 'network': return 'The environment could not be reached.';
    case 'notFound': return 'The requested data was not found.';
    default: return `The read failed: ${c.message}`;
  }
}

export interface PptbAccessReaderOptions {
  /** Omitted: the build default (open, or locked in a lock build). `null`: open. An environment: locked to it. */
  readonly expected?: ApprovedEnvironment | null;
  readonly paging?: PagingStrategy;
  readonly retry?: RetryOptions;
  readonly newCorrelationId?: () => string;
  /** Receives non-sensitive trace events (operation, correlation id, page counts, error kind). */
  readonly trace?: (event: { readonly correlationId: string; readonly step: string; readonly detail?: string }) => void;
}

export interface ConnectionsApi {
  getActiveConnection?: () => Promise<{ id?: string; url?: string } | null>;
  getConnections?: () => Promise<Array<{ url?: string } | null>>;
}

export interface Session {
  readonly cid: string;
  readonly fingerprint: string;
}

/** The outcome of a section read: rows plus the reason it is incomplete (a failed or partial read is a gap, never an empty answer). */
export interface Section {
  readonly rows: readonly Row[];
  readonly gap: string | null;
}

export class PptbAccessReader implements AccessReader {
  protected readonly expected: ApprovedEnvironment | null;
  protected readonly paging: PagingStrategy;
  protected readonly retry: RetryOptions;
  protected readonly trace: NonNullable<PptbAccessReaderOptions['trace']>;
  protected readonly nextId: () => string;
  private verified: { readonly key: string; readonly result: IdentityResult } | null = null;
  private counter = 0;

  constructor(protected readonly host: ReadOnlyHost, protected readonly connections: ConnectionsApi | undefined, options: PptbAccessReaderOptions = {}) {
    this.expected = options.expected === undefined ? lockedEnvironment() : options.expected;
    this.paging = options.paging ?? createPageNumberStrategy();
    this.retry = options.retry ?? {};
    this.trace = options.trace ?? (() => undefined);
    this.nextId = options.newCorrelationId ?? (() => `dsm-access-${Date.now().toString(36)}-${(++this.counter).toString(36)}`);
  }

  /** Identity check before every read session; the organization row is only re-read when the connection changed. */
  async verifyIdentity(): Promise<IdentityResult> {
    const connection = await readConnectionIdentity(this.connections);
    const key = connection.activeConnectionUrl ? normalizeUrl(connection.activeConnectionUrl) : '';
    if (this.verified && key !== '' && this.verified.key === key && connection.candidateConnectionCount === 1) return this.verified.result;
    const result = await verifyHostEnvironment(this.expected, this.connections, this.host);
    this.verified = result.status === 'refused' ? null : { key, result };
    return result;
  }

  async searchUsers(query: string): Promise<ReadResult<readonly UserHit[]>> {
    const q = query.trim().slice(0, MAX_QUERY);
    if (q.length < 2) return { status: 'ok', data: [] };
    const cid = this.nextId();
    return this.guarded(cid, async (s) => {
      this.trace({ correlationId: cid, step: 'searchUsers' });
      const rows = (await this.call(s, () => this.host.fetchXmlQuery(userSearchFetch(q)))).value ?? [];
      const hits: UserHit[] = [];
      let unreadable = 0;
      for (const r of rows.slice(0, SEARCH_LIMIT)) {
        const hit = userOf(r);
        if (hit) hits.push(hit);
        else unreadable++;
      }
      const notes: string[] = [];
      if (rows.length > SEARCH_LIMIT) notes.push(`Only the first ${SEARCH_LIMIT} matches are shown; refine the search to see others.`);
      if (unreadable > 0) notes.push(`${unreadable} matching row(s) could not be read and are not listed.`);
      if (hits.some((h) => h.businessUnitName === null)) notes.push('The business unit of some users could not be read.');
      return notes.length > 0 ? { status: 'partial', data: hits, notes: withRef(notes, cid) } : { status: 'ok', data: hits };
    });
  }

  async searchTeams(query: string): Promise<ReadResult<readonly TeamSummary[]>> {
    const q = query.trim().slice(0, MAX_QUERY);
    if (q.length < 2) return { status: 'ok', data: [] };
    const cid = this.nextId();
    return this.guarded(cid, async (s) => {
      this.trace({ correlationId: cid, step: 'searchTeams' });
      const rows = (await this.call(s, () => this.host.fetchXmlQuery(teamSearchFetch(q)))).value ?? [];
      const teams: TeamSummary[] = [];
      let unreadable = 0;
      for (const r of rows.slice(0, SEARCH_LIMIT)) {
        const t = teamOf(r);
        if (t) teams.push(t);
        else unreadable++;
      }
      const notes: string[] = [];
      if (rows.length > SEARCH_LIMIT) notes.push(`Only the first ${SEARCH_LIMIT} matches are shown; refine the search to see others.`);
      if (unreadable > 0) notes.push(`${unreadable} matching row(s) could not be read and are not listed.`);
      if (teams.some((t) => t.businessUnitName === null)) notes.push('The business unit of some teams could not be read.');
      return notes.length > 0 ? { status: 'partial', data: teams, notes: withRef(notes, cid) } : { status: 'ok', data: teams };
    });
  }

  async loadUserAccess(userId: string): Promise<ReadResult<UserAccess>> {
    const cid = this.nextId();
    if (!GUID.test(userId)) return { status: 'error', errorClass: 'notFound', message: `"${userId}" is not a valid user id. (ref ${cid})` };
    const uid = userId.toLowerCase();
    return this.guarded(cid, async (s) => {
      this.trace({ correlationId: cid, step: 'loadUserAccess' });
      // The user row is the one thing nothing can be shown without; a failure here is an error, not a partial result.
      const userRows = (await this.call(s, () => this.host.fetchXmlQuery(userFetch(uid)))).value ?? [];
      const hit = userRows.map(userOf).find((h) => h?.user.id === uid) ?? null;
      if (!hit) return { status: 'error', errorClass: 'notFound', message: `The user was not found. (ref ${cid})` };

      const gaps: string[] = [];
      const direct = await this.section(s, (p, n) => userRolesFetch(p, n, uid), 'direct role assignments', gaps);
      const memberships = await this.section(s, (p, n) => userMembershipsFetch(p, n, uid), 'team memberships', gaps);
      const directRoleIds = unique(direct.rows.map((r) => linkedId(r, 'sur', 'roleid')));
      const teamIds = unique(memberships.rows.map((r) => linkedId(r, 'tm', 'teamid')));

      const teamRows = await this.chunked(s, teamIds, teamsByIdFetch, 'teams', gaps);
      const teamRoleRows = await this.chunked(s, teamIds, teamRolesFetch, 'team roles', gaps);
      const roleIdsOfTeam = new Map<string, string[]>();
      for (const r of teamRoleRows) {
        const t = id(r, 'teamid');
        const ro = linkedId(r, 'tr', 'roleid');
        if (t && ro) roleIdsOfTeam.set(t, [...(roleIdsOfTeam.get(t) ?? []), ro]);
      }
      const teams: Team[] = [];
      for (const r of teamRows) {
        const t = teamOf(r);
        if (!t) {
          gaps.push('A team row could not be read.');
          continue;
        }
        teams.push({ id: t.id, name: t.name, businessUnitId: t.businessUnitId, type: t.type, roleIds: roleIdsOfTeam.get(t.id) ?? [] });
      }

      const allRoleIds = unique([...directRoleIds, ...teams.flatMap((t) => t.roleIds)]);
      const roleRows = await this.chunked(s, allRoleIds, rolesByIdFetch, 'roles', gaps);
      const roles: Role[] = [];
      for (const r of roleRows) {
        const role = roleOf(r);
        if (role) roles.push(role);
        else gaps.push('A role row could not be read.');
      }

      const buIds = unique([hit.user.businessUnitId, ...roles.map((r) => r.businessUnitId), ...teams.map((t) => t.businessUnitId)].map((b) => (b === '' ? null : b)));
      const buRows = await this.chunked(s, buIds, businessUnitsByIdFetch, 'business units', gaps);
      const businessUnits: BusinessUnit[] = [];
      for (const r of buRows) {
        const b = id(r, 'businessunitid');
        if (b) businessUnits.push({ id: b, name: text(r, 'name') ?? '(unnamed business unit)', parentId: null, isDisabled: false });
      }
      const known = new Set(businessUnits.map((b) => b.id));
      if (hit.user.businessUnitId === '' || buIds.some((b) => !known.has(b))) {
        gaps.push('The name of at least one business unit could not be resolved; it is shown as unknown.');
      }

      const snapshot: SecuritySnapshot = {
        businessUnits,
        roles,
        users: [hit.user],
        teams,
        directAssignments: directRoleIds.map((roleId) => ({ userId: uid, roleId })),
        memberships: teamIds.map((teamId) => ({ userId: uid, teamId })),
        settings: { enableOwnershipAcrossBusinessUnits: null, doNotRemoveRolesOnChangeBusinessUnit: null, alwaysMoveRecordToOwnerBusinessUnit: null, notes: [] },
        warnings: unique(gaps),
      };
      const access = explainUserAccess(snapshot, uid);
      // The explainer's warnings include every data gap and every row it could not resolve; any of them makes the answer incomplete.
      return access.isComplete ? { status: 'ok', data: access } : { status: 'partial', data: access, notes: withRef(access.warnings, cid) };
    });
  }

  async loadTeamAccess(teamId: string): Promise<ReadResult<TeamAccess>> {
    const cid = this.nextId();
    if (!GUID.test(teamId)) return { status: 'error', errorClass: 'notFound', message: `"${teamId}" is not a valid team id. (ref ${cid})` };
    const tid = teamId.toLowerCase();
    return this.guarded(cid, async (s) => {
      this.trace({ correlationId: cid, step: 'loadTeamAccess' });
      const teamRows = (await this.call(s, () => this.host.fetchXmlQuery(teamFetch(tid)))).value ?? [];
      const team = teamRows.map(teamOf).find((t) => t?.id === tid) ?? null;
      if (!team) return { status: 'error', errorClass: 'notFound', message: `The team was not found. (ref ${cid})` };

      const gaps: string[] = [];
      // Access teams carry no roles by definition; that is not a gap and nothing is read for it.
      const roleIds = team.type === 'Access' ? [] : unique((await this.section(s, (p, n) => teamRolesFetch(p, n, [tid]), 'team roles', gaps)).rows.map((r) => linkedId(r, 'tr', 'roleid')));
      const roleRows = await this.chunked(s, roleIds, rolesByIdFetch, 'roles', gaps);
      const roleList: Role[] = [];
      for (const r of roleRows) {
        const role = roleOf(r);
        if (role) roleList.push(role);
        else gaps.push('A role row could not be read.');
      }
      for (const rid of roleIds) if (!roleList.some((r) => r.id === rid)) gaps.push(`Role ${rid} of the team is not in the role list.`);
      const buRows = await this.chunked(s, unique(roleList.map((r) => (r.businessUnitId === '' ? null : r.businessUnitId))), businessUnitsByIdFetch, 'business units', gaps);
      const buName = new Map(buRows.map((r) => [id(r, 'businessunitid') ?? '', text(r, 'name') ?? '(unnamed business unit)']));

      const roleGaps = unique(gaps); // everything noted so far is about the team's roles (the members come next)
      let members: UserHit[] = [];
      let truncated = false;
      try {
        const memberRows = (await this.call(s, () => this.host.fetchXmlQuery(teamMembersFetch(tid, TEAM_MEMBER_LIMIT + 1)))).value ?? [];
        const memberIds = unique(memberRows.map((r) => linkedId(r, 'tm', 'systemuserid')));
        truncated = memberRows.length > TEAM_MEMBER_LIMIT;
        const shown = memberIds.slice(0, TEAM_MEMBER_LIMIT);
        const userRows = await this.chunked(s, shown, usersByIdFetch, 'members', gaps);
        members = userRows.map(userOf).filter((h): h is UserHit => h !== null);
        members.sort((a, b) => a.user.fullName.localeCompare(b.user.fullName) || a.user.id.localeCompare(b.user.id));
        if (members.length < shown.length) gaps.push('Some members could not be resolved to a user record and are not listed.');
      } catch (e) {
        const c = classifyHostError(e);
        if (c.kind === 'connectionChanged') throw e;
        gaps.push(`Team members could not be read (${c.kind}).`);
      }
      if (truncated) gaps.push(`Only the first ${TEAM_MEMBER_LIMIT} members are listed; the team has more.`);

      roleList.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      const data: TeamAccess = {
        team,
        roles: roleList.map((role) => ({ role, businessUnitName: buName.get(role.businessUnitId) ?? null })),
        members,
        membersTruncated: truncated,
        ...(roleGaps.length > 0 ? { rolesComplete: false, roleGaps: withRef(roleGaps, cid) } : {}),
      };
      return gaps.length > 0 ? { status: 'partial', data, notes: withRef(unique(gaps), cid) } : { status: 'ok', data };
    });
  }

  async listRolesOfBusinessUnit(businessUnitId: string): Promise<ReadResult<readonly Role[]>> {
    const cid = this.nextId();
    if (!GUID.test(businessUnitId)) return { status: 'error', errorClass: 'notFound', message: `"${businessUnitId}" is not a valid business unit id. (ref ${cid})` };
    const bu = businessUnitId.toLowerCase();
    return this.guarded(cid, async (s) => {
      this.trace({ correlationId: cid, step: 'listRolesOfBusinessUnit' });
      const rows = (await this.call(s, () => this.host.fetchXmlQuery(rolesOfBusinessUnitFetch(bu)))).value ?? [];
      const roles: Role[] = [];
      let unreadable = 0;
      for (const r of rows.slice(0, ROLE_LIST_LIMIT)) {
        const role = roleOf(r);
        if (role && role.businessUnitId === bu) roles.push(role);
        else unreadable++;
      }
      const notes: string[] = [];
      if (rows.length > ROLE_LIST_LIMIT) notes.push(`Only the first ${ROLE_LIST_LIMIT} roles are listed.`);
      if (unreadable > 0) notes.push(`${unreadable} role row(s) could not be read and are not listed.`);
      return notes.length > 0 ? { status: 'partial', data: roles, notes: withRef(notes, cid) } : { status: 'ok', data: roles };
    });
  }

  /** Display names of users and roles by id, for a restore preview (reads only; at most NAME_LIMIT ids per kind). A name that was not read is absent, never invented. */
  async resolveNames(request: NameRequest): Promise<ReadResult<ResolvedNames>> {
    const cid = this.nextId();
    const clean = (list: readonly string[] | undefined): string[] => unique((list ?? []).filter((v) => GUID.test(v)).map((v) => v.toLowerCase())).slice(0, NAME_LIMIT);
    const userIds = clean(request.users);
    const roleIds = clean(request.roles);
    return this.guarded(cid, async (s) => {
      this.trace({ correlationId: cid, step: 'resolveNames', detail: `${userIds.length} user id(s), ${roleIds.length} role id(s)` });
      const gaps: string[] = [];
      const userRows = userIds.length > 0 ? await this.chunked(s, userIds, usersByIdFetch, 'user names', gaps) : [];
      const roleRows = roleIds.length > 0 ? await this.chunked(s, roleIds, rolesByIdFetch, 'role names', gaps) : [];
      const users = new Map<string, string>();
      for (const r of userRows) {
        const key = id(r, 'systemuserid');
        const name = text(r, 'fullname');
        if (key && name) users.set(key, name);
      }
      const roles = new Map<string, string>();
      for (const r of roleRows) {
        const key = id(r, 'roleid');
        const name = text(r, 'name');
        if (key && name) roles.set(key, name);
      }
      const data = { users, roles };
      return gaps.length > 0 ? { status: 'partial', data, notes: withRef(gaps, cid) } : { status: 'ok', data };
    });
  }

  private grantCatalog: { readonly key: string; readonly byPrivilege: Map<string, { readonly table: string; readonly operation: PrivilegeId }[]>; readonly tables: Map<string, Set<PrivilegeId>>; readonly complete: boolean } | null = null;
  private tableNames: { readonly key: string; readonly names: Map<string, string> } | null = null;

  async loadRoleGrants(roles: readonly RoleRef[]): Promise<ReadResult<RoleGrantsData>> {
    const cid = this.nextId();
    const refs = roles.filter((r) => GUID.test(r.id) && (r.rootId === null || GUID.test(r.rootId)));
    return this.guarded(cid, async (s) => {
      this.trace({ correlationId: cid, step: 'loadRoleGrants', detail: `${refs.length} role(s)` });
      const gaps: string[] = [];
      const catalog = await this.privilegeCatalogOf(s, gaps);
      // The roles themselves and the roots of their Business Unit copies: a copy stores no privileges and has its root's (observed on the real service).
      const ids = unique(refs.flatMap((r) => [r.id.toLowerCase(), r.rootId?.toLowerCase() ?? null]));
      const rows = await this.chunked(s, ids, roleGrantsFetch, 'role privileges', gaps);
      let unreadable = 0;
      let unattributable = 0;
      const stored = new Map<string, RoleGrantRecord[]>();
      for (const row of rows) {
        const roleId = id(row, 'roleid');
        const privilegeId = linkedId(row, 'rp', 'privilegeid') ?? id(row, 'privilegeid');
        const mask = int(row, 'rp.privilegedepthmask') ?? int(row, 'rp_x002e_privilegedepthmask') ?? int(row, 'privilegedepthmask');
        if (!roleId || !privilegeId) {
          unattributable++; // not a miscellaneous privilege: we cannot tell what it was, so never treat it as absent
          continue;
        }
        const entries = catalog.byPrivilege.get(privilegeId);
        if (!entries || entries.length === 0) continue; // a miscellaneous (non-table) privilege
        const depth = mask === null ? null : depthFromMask(mask);
        if (depth === null) {
          unreadable++;
          continue;
        }
        // The grant applies to every table the privilege belongs to.
        stored.set(roleId, [...(stored.get(roleId) ?? []), ...entries.map((e) => ({ roleId, table: e.table, operation: e.operation, depth }))]);
      }
      if (unreadable > 0) gaps.push(`${unreadable} privilege depth value(s) could not be read.`);
      if (unattributable > 0) gaps.push(`${unattributable} role privilege row(s) could not be attributed to a role and privilege; the grants shown may be incomplete.`);
      const grants: RoleGrantRecord[] = [];
      for (const ref of refs) {
        const own = stored.get(ref.id.toLowerCase());
        const source = own && own.length > 0 ? own : ref.rootId ? (stored.get(ref.rootId.toLowerCase()) ?? []) : [];
        for (const g of source) grants.push({ ...g, roleId: ref.id.toLowerCase() });
      }
      const names = await this.tableNamesOf(s, gaps);
      const data: RoleGrantsData = { grants, catalog: catalog.tables, tableNames: names, complete: gaps.length === 0 && catalog.complete, catalogComplete: catalog.complete };
      return gaps.length > 0 ? { status: 'partial', data, notes: withRef(unique(gaps), cid) } : { status: 'ok', data };
    });
  }

  /** Which operations exist for which table, from the whole privilege catalog (read once per connection). */
  private async privilegeCatalogOf(s: Session, gaps: string[]) {
    if (this.grantCatalog && this.grantCatalog.key === s.fingerprint) return this.grantCatalog;
    const local: string[] = [];
    const section = await this.section(s, (p, n) => privilegeFetch(p, n), 'privilege catalog', local);
    // One privilege can belong to several tables (activity tables share the activitypointer privileges): keep every association.
    const byPrivilege = new Map<string, { readonly table: string; readonly operation: PrivilegeId }[]>();
    const tables = new Map<string, Set<PrivilegeId>>();
    let unreadableRows = 0;
    for (const r of section.rows) {
      const privilegeId = id(r, 'privilegeid');
      const right = int(r, 'accessright');
      const operation = right === null ? undefined : ACCESS_RIGHT_TO_PRIVILEGE.get(right);
      const raw = aliased(r, 'ptc', 'objecttypecode');
      const table = typeof raw === 'string' ? raw.toLowerCase() : null;
      if (table === 'none') continue; // a miscellaneous privilege: bound to no table
      if (!privilegeId || right === null || !table) {
        unreadableRows++; // could be any table's privilege; never treat it as absent
        continue;
      }
      if (!operation) continue; // an access right this tool does not model
      const known = byPrivilege.get(privilegeId) ?? [];
      if (!known.some((k) => k.table === table && k.operation === operation)) known.push({ table, operation });
      byPrivilege.set(privilegeId, known);
      tables.set(table, (tables.get(table) ?? new Set()).add(operation));
    }
    if (unreadableRows > 0) local.push(`${unreadableRows} privilege catalog row(s) could not be read; table operations may be missing.`);
    const catalog = { key: s.fingerprint, byPrivilege, tables, complete: local.length === 0 };
    gaps.push(...local);
    if (catalog.complete) this.grantCatalog = catalog; // an incomplete catalog is read again next time
    return catalog;
  }

  private async tableNamesOf(s: Session, gaps: string[]): Promise<Map<string, string>> {
    if (this.tableNames && this.tableNames.key === s.fingerprint) return this.tableNames.names;
    const names = new Map<string, string>();
    try {
      const meta = await this.call(s, () => this.host.getAllEntitiesMetadata(['LogicalName', 'DisplayName']));
      for (const raw of meta.value ?? []) {
        const logical = text(raw as Row, 'LogicalName');
        const display = displayNameOf(raw as Record<string, unknown>);
        if (logical && display) names.set(logical.toLowerCase(), display);
      }
      this.tableNames = { key: s.fingerprint, names };
    } catch (e) {
      const c = classifyHostError(e);
      if (c.kind === 'connectionChanged') throw e;
      gaps.push(`Table display names could not be read (${c.kind}); logical names are shown.`);
    }
    return names;
  }

  // ---- internals
  /** A paged read whose failure or truncation is recorded as a gap instead of an empty answer. A changed connection still aborts. */
  protected async section(session: Session, build: (page: number, size: number) => string, label: string, gaps: string[]): Promise<Section> {
    try {
      const result = await this.readPaged(session, build, label);
      if (!result.complete) gaps.push(`${label} were read only in part. ${result.note ?? ''}`.trim());
      return { rows: result.rows, gap: result.complete ? null : (result.note ?? 'incomplete') };
    } catch (e) {
      const c = classifyHostError(e);
      if (c.kind === 'connectionChanged') throw e;
      const gap = `${label} could not be read (${c.kind}).`;
      gaps.push(gap);
      return { rows: [], gap };
    }
  }

  protected async chunked(session: Session, ids: readonly string[], build: (page: number, size: number, ids: readonly string[]) => string, label: string, gaps: string[]): Promise<Row[]> {
    const rows: Row[] = [];
    for (const part of chunks(ids, IN_CHUNK)) {
      const s = await this.section(session, (p, n) => build(p, n, part), label, gaps);
      rows.push(...s.rows);
    }
    return rows;
  }

  protected async guarded<T>(cid: string, work: (session: Session) => Promise<ReadResult<T>>): Promise<ReadResult<T>> {
    try {
      const before = await connectionFingerprint(this.connections);
      const identity = await this.verifyIdentity();
      if (identity.status === 'refused') {
        this.trace({ correlationId: cid, step: 'identityRefused', detail: identity.reason });
        return { status: 'error', errorClass: 'permission', message: `${identity.message} (ref ${cid})` };
      }
      const after = await connectionFingerprint(this.connections);
      if (before === null || before !== after) throw new ConnectionChangedError();
      return await work({ cid, fingerprint: before });
    } catch (e) {
      const c = classifyHostError(e);
      this.trace({ correlationId: cid, step: 'error', detail: c.kind });
      return { status: 'error', errorClass: toPortErrorClass(c.kind), message: `${friendly(c)} (ref ${cid})` };
    }
  }

  protected async assertSameConnection(session: Session): Promise<void> {
    if ((await connectionFingerprint(this.connections)) !== session.fingerprint) {
      this.trace({ correlationId: session.cid, step: 'connectionChanged' });
      throw new ConnectionChangedError();
    }
  }

  protected call<T>(session: Session, fn: () => Promise<T>): Promise<T> {
    return withRetry(async () => {
      await this.assertSameConnection(session);
      const result = await fn();
      await this.assertSameConnection(session);
      return result;
    }, this.retry);
  }

  protected async readPaged(session: Session, build: (page: number, size: number) => string, label: string): Promise<PagedRows> {
    const result = await this.paging.readAll(
      build,
      (fetchXml) => this.call(session, () => this.host.fetchXmlQuery(fetchXml)),
      (row) => JSON.stringify(row),
    );
    this.trace({ correlationId: session.cid, step: 'pages', detail: `${label}: ${result.pages} page(s), ${result.rows.length} row(s), complete=${result.complete}` });
    return result;
  }
}

function unique(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => v !== null))];
}

function withRef(notes: readonly string[], cid: string): readonly string[] {
  return notes.map((n, i) => (i === notes.length - 1 ? `${n} (ref ${cid})` : n));
}

/** Factory: an error-reporting reader when the host does not provide the Dataverse API, so callers never receive a half-working adapter. */
export function createPptbAccessReader(host: HostWindow | undefined, options: PptbAccessReaderOptions = {}): AccessReader {
  const api = host?.dataverseAPI;
  if (!api) {
    const unavailable = async <T>(): Promise<ReadResult<T>> => ({
      status: 'error',
      errorClass: 'unknown',
      message: 'The PPTB host Dataverse API is not available in this context.',
    });
    return { searchUsers: () => unavailable(), searchTeams: () => unavailable(), loadUserAccess: () => unavailable(), loadTeamAccess: () => unavailable(), listRolesOfBusinessUnit: () => unavailable(), loadRoleGrants: () => unavailable() };
  }
  return new PptbAccessReader(createReadOnlyHost(api), host?.toolboxAPI?.connections, options);
}
