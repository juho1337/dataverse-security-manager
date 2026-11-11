import type { BuManagerReader, PlanningData } from '../../application/buManager/ports';
import type { BusinessUnit, Role, RolePrivilege, SecuritySettings, SecuritySnapshot, Team, TeamType, UserSummary } from '../../domain/buMove/types';
import type { PrivilegeId } from '../../domain/privileges';
import type { UserHit } from '../../ports/accessReader';
import type { ReadResult } from '../../ports/securityDataReader';
import { linkedId, PptbAccessReader, roleGrantsFetch, teamRolesFetch, teamsByIdFetch, usersByIdFetch, type PptbAccessReaderOptions, type Session } from './accessReader';
import type { HostWindow } from './connection';
import { createReadOnlyHost } from './readOnlyHost';
import { normalizeParentRoot } from './lineage';
import { createPageNumberStrategy } from './paging';
import { depthFromMask, privilegeFetch } from './reader';

// Read side of the BU Manager over the PPTB host (issues #271, #273). It extends the Access Explorer reader (same identity check, connection
// fingerprint around every request, retry and paging; read-only facade only) with the reads the planner needs. Every read is fresh.
// UNVERIFIED against the real host (tested against a fake host only; the first real run is write-test S3 preparation):
//  - FetchXML on the intersect tables systemuserroles / teammembership / teamroles by id columns, and `isdefault`/`teamtype` filters on team,
//  - the shape of lookup columns (`businessunitid` vs `_businessunitid_value`) and of `parentbusinessunitid` / `parentrootroleid`,
//  - the size and speed of the privilege catalog read (all tables) and of the role privileges of the compared roles.
// The organization-level security settings that change what a move does to roles are NOT read: they stay `null` (unknown) and the planner
// states what a move is expected to do as an expectation with its basis, never as a certainty.

type Row = Record<string, unknown>;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IN_CHUNK = 50;

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (r: Row, k: string): string | null => (typeof r[k] === 'string' && (r[k] as string).length > 0 ? (r[k] as string) : null);
const id = (r: Row, k: string): string | null => text(r, k)?.toLowerCase() ?? null;
const lookup = (r: Row, c: string): string | null => id(r, `_${c}_value`) ?? id(r, c);
const num = (r: Row, k: string): number | null => {
  const v = r[k];
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) ? n : null;
};
const unique = (values: readonly (string | null)[]): string[] => [...new Set(values.filter((v): v is string => v !== null))];
const inValues = (ids: readonly string[]) => ids.map((v) => `<value>${xml(v)}</value>`).join('');
const paged = (p: number, size: number) => `<fetch page="${p}" count="${size}">`;

const ACCESS_RIGHT: ReadonlyMap<number, PrivilegeId> = new Map<number, PrivilegeId>([
  [1, 'Read'], [2, 'Write'], [4, 'Append'], [16, 'AppendTo'], [32, 'Create'], [65536, 'Delete'], [262144, 'Share'], [524288, 'Assign'],
]);

// ---- FetchXML builders (exported for tests)
export function allBusinessUnitsFetch(p: number, size: number): string {
  return `${paged(p, size)}<entity name="businessunit"><attribute name="businessunitid"/><attribute name="name"/><attribute name="parentbusinessunitid"/><attribute name="isdisabled"/><order attribute="businessunitid"/></entity></fetch>`;
}
export function allRolesFetch(p: number, size: number): string {
  return `${paged(p, size)}<entity name="role"><attribute name="roleid"/><attribute name="name"/><attribute name="businessunitid"/><attribute name="parentrootroleid"/><attribute name="ismanaged"/><order attribute="roleid"/></entity></fetch>`;
}
// Intersect tables are read FROM systemuser through a link-entity (a fetch rooted at systemuserroles is a 404 on the real host, verified 2026-11-03).
export function usersRolesFetch(p: number, size: number, userIds: readonly string[]): string {
  return `${paged(p, size)}<entity name="systemuser"><attribute name="systemuserid"/><filter><condition attribute="systemuserid" operator="in">${inValues(userIds)}</condition></filter><order attribute="systemuserid"/>` +
    `<link-entity name="systemuserroles" from="systemuserid" to="systemuserid" alias="sur" intersect="true"><attribute name="roleid"/><order attribute="roleid"/></link-entity></entity></fetch>`;
}
export function usersMembershipsFetch(p: number, size: number, userIds: readonly string[]): string {
  return `${paged(p, size)}<entity name="systemuser"><attribute name="systemuserid"/><filter><condition attribute="systemuserid" operator="in">${inValues(userIds)}</condition></filter><order attribute="systemuserid"/>` +
    `<link-entity name="teammembership" from="systemuserid" to="systemuserid" alias="tm" intersect="true"><attribute name="teamid"/><order attribute="teamid"/></link-entity></entity></fetch>`;
}
export function defaultTeamsFetch(p: number, size: number, businessUnitIds: readonly string[]): string {
  return `${paged(p, size)}<entity name="team"><attribute name="teamid"/><attribute name="name"/><attribute name="teamtype"/><attribute name="isdefault"/><attribute name="businessunitid"/><filter><condition attribute="isdefault" operator="eq" value="1"/><condition attribute="businessunitid" operator="in">${inValues(businessUnitIds)}</condition></filter><order attribute="teamid"/></entity></fetch>`;
}
export function usersByEmailFetch(p: number, size: number, emails: readonly string[]): string {
  return `${paged(p, size)}<entity name="systemuser"><attribute name="systemuserid"/><attribute name="fullname"/><attribute name="internalemailaddress"/><attribute name="businessunitid"/><attribute name="isdisabled"/><attribute name="applicationid"/><filter><condition attribute="internalemailaddress" operator="in">${inValues(emails)}</condition></filter><order attribute="systemuserid"/><link-entity name="businessunit" from="businessunitid" to="businessunitid" alias="bu" link-type="outer"><attribute name="name"/></link-entity></entity></fetch>`;
}

function teamTypeOf(r: Row): TeamType {
  if (r['isdefault'] === true) return 'Default';
  const t = num(r, 'teamtype');
  return t === 0 ? 'Owner' : t === 1 ? 'Access' : 'Other';
}

function userOf(r: Row): UserHit | null {
  const userId = id(r, 'systemuserid');
  if (!userId) return null;
  const bu = r['bu.name'] ?? r['bu_x002e_name'];
  const user: UserSummary = {
    id: userId,
    fullName: text(r, 'fullname') ?? '(no name)',
    email: text(r, 'internalemailaddress') ?? '',
    businessUnitId: lookup(r, 'businessunitid') ?? '',
    isDisabled: r['isdisabled'] === true,
    isApplicationUser: text(r, 'applicationid') !== null,
  };
  return { user, businessUnitName: typeof bu === 'string' ? bu : null };
}

const UNKNOWN_SETTINGS: SecuritySettings = {
  enableOwnershipAcrossBusinessUnits: null,
  doNotRemoveRolesOnChangeBusinessUnit: null,
  alwaysMoveRecordToOwnerBusinessUnit: null,
  notes: ['The organization settings that decide what a move does to roles are not read by this tool; the preview states expectations only.'],
};

export class PptbBuManagerReader extends PptbAccessReader implements BuManagerReader {
  /** Privilege catalog (id -> table and operation), read once per connection; it is large and does not change during a session. */
  private catalog: { readonly key: string; readonly entries: ReadonlyMap<string, { entity: string; operation: PrivilegeId }>; readonly complete: boolean } | null = null;

  async listBusinessUnits(): Promise<ReadResult<readonly BusinessUnit[]>> {
    const cid = this.nextId();
    return this.guarded(cid, async (s) => {
      const gaps: string[] = [];
      const rows = (await this.section(s, allBusinessUnitsFetch, 'business units', gaps)).rows;
      const data = this.businessUnitsOf(rows);
      if (data.length === 0 && gaps.length === 0) gaps.push('No business unit was returned.');
      return gaps.length > 0 ? { status: 'partial', data, notes: unique(gaps) } : { status: 'ok', data };
    });
  }

  async findUsersByEmail(emails: readonly string[]): Promise<ReadResult<readonly UserHit[]>> {
    const wanted = unique(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0));
    if (wanted.length === 0) return { status: 'ok', data: [] };
    const cid = this.nextId();
    return this.guarded(cid, async (s) => {
      const gaps: string[] = [];
      const rows = await this.chunked(s, wanted, usersByEmailFetch, 'users by email', gaps);
      const data = rows.map(userOf).filter((h): h is UserHit => h !== null);
      return gaps.length > 0 ? { status: 'partial', data, notes: unique(gaps) } : { status: 'ok', data };
    });
  }

  async loadPlanningData(userIds: readonly string[], targetBusinessUnitId: string, extraRoleIds: readonly string[] = []): Promise<ReadResult<PlanningData>> {
    const cid = this.nextId();
    const ids = unique(userIds.map((u) => (GUID.test(u) ? u.toLowerCase() : null)));
    const target = targetBusinessUnitId.toLowerCase();
    if (ids.length === 0 || ids.length !== userIds.length || !GUID.test(target)) {
      return { status: 'error', errorClass: 'notFound', message: `A user or business unit id is not valid. (ref ${cid})` };
    }
    return this.guarded(cid, async (s) => {
      this.trace({ correlationId: cid, step: 'loadPlanningData' });
      const gaps: string[] = [];
      const buRows = (await this.section(s, allBusinessUnitsFetch, 'business units', gaps)).rows;
      const businessUnits = this.businessUnitsOf(buRows);
      if (!businessUnits.some((b) => b.id === target)) return { status: 'error', errorClass: 'notFound', message: `The target business unit was not found. (ref ${cid})` };

      const userRows = await this.chunked(s, ids, usersByIdFetch, 'users', gaps);
      const users = userRows.map(userOf).filter((h): h is UserHit => h !== null).map((h) => h.user);
      for (const u of ids) if (!users.some((x) => x.id === u)) gaps.push(`User ${u} could not be read.`);
      const assignmentRows = await this.chunked(s, ids, usersRolesFetch, 'role assignments', gaps);
      const membershipRows = await this.chunked(s, ids, usersMembershipsFetch, 'team memberships', gaps);
      const directAssignments = assignmentRows.flatMap((r) => {
        const u = id(r, 'systemuserid');
        const ro = linkedId(r, 'sur', 'roleid');
        return u && ro ? [{ userId: u, roleId: ro }] : [];
      });
      const memberships = membershipRows.flatMap((r) => {
        const u = id(r, 'systemuserid');
        const t = linkedId(r, 'tm', 'teamid');
        return u && t ? [{ userId: u, teamId: t }] : [];
      });

      // Teams: those the users belong to, plus the default team of every business unit involved (the planner states what the default team
      // grants before and after a move).
      const involved = unique([...users.map((u) => (u.businessUnitId === '' ? null : u.businessUnitId)), target]);
      const memberTeamIds = unique(memberships.map((m) => m.teamId));
      const teamRows = [
        ...(await this.chunked(s, memberTeamIds, teamsByIdFetch, 'teams', gaps)),
        ...(await this.chunked(s, involved, defaultTeamsFetch, 'default teams', gaps)),
      ];
      const teamById = new Map<string, Row>();
      for (const r of teamRows) {
        const t = id(r, 'teamid');
        if (t) teamById.set(t, r);
      }
      const teamIds = [...teamById.keys()];
      const teamRoleRows = await this.chunked(s, teamIds, teamRolesFetch, 'team roles', gaps);
      const roleIdsOfTeam = new Map<string, string[]>();
      for (const r of teamRoleRows) {
        const t = id(r, 'teamid');
        const ro = linkedId(r, 'tr', 'roleid');
        if (t && ro) roleIdsOfTeam.set(t, [...(roleIdsOfTeam.get(t) ?? []), ro]);
      }
      const teams: Team[] = [...teamById.entries()].map(([teamId, r]) => ({
        id: teamId,
        name: text(r, 'name') ?? '(unnamed team)',
        businessUnitId: lookup(r, 'businessunitid') ?? '',
        type: teamTypeOf(r),
        roleIds: roleIdsOfTeam.get(teamId) ?? [],
      }));

      const roleRows = (await this.section(s, allRolesFetch, 'roles', gaps)).rows;
      const roles: Role[] = roleRows.flatMap((r) => {
        const roleId = id(r, 'roleid');
        return roleId
          ? [{ id: roleId, name: text(r, 'name') ?? '(unnamed role)', businessUnitId: lookup(r, 'businessunitid') ?? '', parentRoleId: null, parentRootRoleId: ((p) => (p === null ? null : normalizeParentRoot(roleId, p)))(lookup(r, 'parentrootroleid')), isManaged: r['ismanaged'] === true }]
          : [];
      });

      // Privileges are compared only for the roles a match can involve: the users' direct roles and every role that shares a name or a root
      // role with one of them. Reading every role of the environment would be slow and is not needed for a match.
      const direct = new Set(directAssignments.map((a) => a.roleId));
      const sources = roles.filter((r) => direct.has(r.id));
      const names = new Set(sources.map((r) => r.name.toLowerCase()));
      const roots = new Set(sources.map((r) => r.parentRootRoleId ?? r.id));
      const known = new Set(roles.map((r) => r.id));
      // A role chosen freely (custom strategy) is compared too: its privileges must be read, otherwise it would look like a role with none.
      const chosen = unique(extraRoleIds.map((r) => (GUID.test(r) ? r.toLowerCase() : null)));
      const compared = unique([...roles.filter((r) => direct.has(r.id) || names.has(r.name.toLowerCase()) || roots.has(r.parentRootRoleId ?? r.id)).map((r) => r.id), ...chosen.filter((r) => known.has(r))]);
      const privileges = await this.loadPrivileges(s, compared, gaps);
      // A Business Unit copy of a role stores no privileges of its own: observed on the real Developer environment (2026-11-04) where every copy
      // had 0 grants and its root had them, so the copy has the privileges of its root. Comparing the empty copy with the root reported
      // differences that do not exist (and "gives more access" for the identical role). A copy that does store grants keeps its own.
      const comparedSet = new Set(compared);
      const stored = new Set(privileges.rows.map((r) => r.roleId));
      const rowsOf = new Map<string, RolePrivilege[]>();
      for (const row of privileges.rows) rowsOf.set(row.roleId, [...(rowsOf.get(row.roleId) ?? []), row]);
      const inherited: RolePrivilege[] = [];
      for (const role of roles) {
        if (role.parentRootRoleId === null || !comparedSet.has(role.id) || stored.has(role.id)) continue;
        if (!comparedSet.has(role.parentRootRoleId)) {
          privileges.complete = false; // the root was not read, so what the copy inherits is unknown
          continue;
        }
        for (const row of rowsOf.get(role.parentRootRoleId) ?? []) inherited.push({ ...row, roleId: role.id });
      }
      privileges.rows.push(...inherited);
      if (chosen.some((r) => !known.has(r))) {
        privileges.complete = false; // a chosen role that was not found cannot be compared
        gaps.push('A chosen role could not be found, so it could not be compared.');
      }

      const snapshot: SecuritySnapshot = {
        businessUnits,
        roles,
        users,
        teams,
        directAssignments,
        memberships,
        settings: UNKNOWN_SETTINGS,
        warnings: unique(gaps),
      };
      const data: PlanningData = { snapshot, privileges: privileges.rows, privilegesComplete: privileges.complete };
      return gaps.length > 0 ? { status: 'partial', data, notes: unique(gaps).map((n, i, a) => (i === a.length - 1 ? `${n} (ref ${cid})` : n)) } : { status: 'ok', data };
    });
  }

  private businessUnitsOf(rows: readonly Row[]): BusinessUnit[] {
    return rows.flatMap((r) => {
      const buId = id(r, 'businessunitid');
      return buId ? [{ id: buId, name: text(r, 'name') ?? '(unnamed business unit)', parentId: lookup(r, 'parentbusinessunitid'), isDisabled: r['isdisabled'] === true }] : [];
    });
  }

  private async loadPrivileges(s: Session, roleIds: readonly string[], gaps: string[]): Promise<{ rows: RolePrivilege[]; complete: boolean }> {
    let complete = true;
    const catalog = await this.privilegeCatalog(s, gaps);
    if (!catalog.complete) complete = false;
    const grants: Row[] = [];
    for (let i = 0; i < roleIds.length; i += IN_CHUNK) {
      const part = roleIds.slice(i, i + IN_CHUNK);
      const before = gaps.length;
      grants.push(...(await this.section(s, (p, n) => roleGrantsFetch(p, n, part), 'role privileges', gaps)).rows);
      if (gaps.length > before) complete = false;
    }
    const rows: RolePrivilege[] = [];
    for (const g of grants) {
      const roleId = id(g, 'roleid');
      const privId = (id(g, 'rp.privilegeid') ?? id(g, 'rp_x002e_privilegeid') ?? id(g, 'privilegeid'));
      const mask = num(g, 'rp.privilegedepthmask') ?? num(g, 'rp_x002e_privilegedepthmask') ?? num(g, 'privilegedepthmask');
      const entry = privId ? catalog.entries.get(privId) : undefined;
      if (!roleId || !entry) continue; // a miscellaneous (non-table) privilege: not part of the comparison
      const depth = mask === null ? null : depthFromMask(mask);
      if (depth === null) {
        complete = false;
        continue;
      }
      if (depth === 'None') continue;
      rows.push({ roleId, entity: entry.entity, operation: entry.operation, depth });
    }
    return { rows, complete };
  }

  private async privilegeCatalog(s: Session, gaps: string[]) {
    if (this.catalog && this.catalog.key === s.fingerprint) return this.catalog;
    const local: string[] = [];
    const result = await this.section(s, (p, n) => privilegeFetch(p, n), 'privilege catalog', local);
    const entries = new Map<string, { entity: string; operation: PrivilegeId }>();
    for (const r of result.rows) {
      const privId = id(r, 'privilegeid');
      const op = ACCESS_RIGHT.get(num(r, 'accessright') ?? -1);
      const table = r['ptc.objecttypecode'] ?? r['ptc_x002e_objecttypecode'];
      if (privId && op && typeof table === 'string' && table !== '' && table.toLowerCase() !== 'none') entries.set(privId, { entity: table.toLowerCase(), operation: op });
    }
    const complete = local.length === 0;
    gaps.push(...local);
    // An incomplete catalog is not remembered: the next plan reads it again.
    const catalog = { key: s.fingerprint, entries, complete };
    if (complete) this.catalog = catalog;
    return catalog;
  }
}

/** Error-reporting reader when the host has no Dataverse API, so callers never receive a half-working adapter. */
export function createPptbBuManagerReader(host: HostWindow | undefined, options: PptbAccessReaderOptions = {}): BuManagerReader {
  const api = host?.dataverseAPI;
  if (!api) {
    const unavailable = async <T>(): Promise<ReadResult<T>> => ({ status: 'error', errorClass: 'unknown', message: 'The PPTB host Dataverse API is not available in this context.' });
    return { searchUsers: () => unavailable(), loadUserAccess: () => unavailable(), listBusinessUnits: () => unavailable(), findUsersByEmail: () => unavailable(), loadPlanningData: () => unavailable() };
  }
  return new PptbBuManagerReader(createReadOnlyHost(api), host?.toolboxAPI?.connections, { paging: createPageNumberStrategy(), ...options });
}
