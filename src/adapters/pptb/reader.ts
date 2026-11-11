import type { Person, PersonStatus, RoleFamily, RoleInstance, TeamNode } from '../../domain/access';
import type { CellValue, DepthId, PrivilegeCells, PrivilegeId, RoleMatrix, RoleRow, TableInfo } from '../../domain/privileges';
import { PRIVILEGE_IDS } from '../../domain/privileges';
import type { ReadResult, SecurityDataReader } from '../../ports/securityDataReader';
import { lockedEnvironment, type ApprovedEnvironment } from './config';
import type { HostWindow } from './connection';
import { classifyHostError, ConnectionChangedError, toPortErrorClass, withRetry, type ClassifiedError, type RetryOptions } from './errors';
import { connectionFingerprint, normalizeUrl, readConnectionIdentity, verifyHostEnvironment, type IdentityResult } from './identity';
import { linkedId } from './accessReader';
import { groupRolesByLineage } from '../../domain/lineage';
import { normalizeParentRoot } from './lineage';
import { createPageNumberStrategy, type PagedRows, type PagingStrategy } from './paging';
import { createReadOnlyHost, type ReadOnlyHost } from './readOnlyHost';

// Read-only Dataverse reader over the PPTB host. It implements the SecurityDataReader port, reaches the host only
// through the ReadOnlyHost facade, and refuses to read anything until the environment identity guard has passed.
// UNVERIFIED against the real host (see paging.ts, identity.ts and the notes below): FetchXML paging behavior, the
// shape of aliased link-entity columns, the objecttypecode filter, and the error shape.

/** privilege.accessright flags (AccessRights): same mapping the XrmToolBox reader uses. */
export const ACCESS_RIGHT_TO_PRIVILEGE: ReadonlyMap<number, PrivilegeId> = new Map<number, PrivilegeId>([
  [1, 'Read'],
  [2, 'Write'],
  [4, 'Append'],
  [16, 'AppendTo'],
  [32, 'Create'],
  [65536, 'Delete'],
  [262144, 'Share'],
  [524288, 'Assign'],
]);

/** roleprivileges.privilegedepthmask: 1 basic, 2 local, 4 deep, 8 global (0 = none). */
export function depthFromMask(mask: number): DepthId | null {
  switch (mask) {
    case 0: return 'None';
    case 1: return 'Basic';
    case 2: return 'Local';
    case 4: return 'Deep';
    case 8: return 'Global';
    default: return null;
  }
}

/** The depth mask must be a real integer number; anything else (missing, null, string, float, NaN) is unreadable. */
function depthMask(row: Record<string, unknown>): number | null {
  const v = aliased(row, 'rp', 'privilegedepthmask') ?? row['privilegedepthmask'];
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

const TABLE_NAME = /^[a-z][a-z0-9_]*$/i;
const UNSUPPORTED_REASON = 'No security privileges defined for this table';

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function text(row: Record<string, unknown>, key: string): string | null {
  const v = row[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function id(row: Record<string, unknown>, key: string): string | null {
  return text(row, key)?.toLowerCase() ?? null;
}
function int(row: Record<string, unknown>, key: string): number | null {
  const v = row[key];
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) ? n : null;
}
/** Aliased link-entity column: the host may return `alias.col` or the OData-encoded `alias_x002e_col` (UNVERIFIED which). */
function aliased(row: Record<string, unknown>, alias: string, column: string): unknown {
  return row[`${alias}.${column}`] ?? row[`${alias}_x002e_${column}`];
}

// ---- FetchXML builders (page and count are added by the paging strategy)
const page = (p: number, size: number) => `<fetch page="${p}" count="${size}">`;

/**
 * `objectTypeCode` is the table's integer ObjectTypeCode (account = 1). The server-side filter on `privilegeobjecttypecodes.objecttypecode`
 * takes that integer (a logical name makes Dataverse answer 400 FormatException), although the column is RETURNED as the logical name.
 * Verified on the real service (Developer environment, 2026-11-03).
 */
export function privilegeFetch(p: number, size: number, objectTypeCode?: number): string {
  const filter = objectTypeCode !== undefined && Number.isInteger(objectTypeCode)
    ? `<filter><condition attribute="objecttypecode" operator="eq" value="${objectTypeCode}"/></filter>`
    : '';
  return (
    `${page(p, size)}<entity name="privilege"><attribute name="privilegeid"/><attribute name="name"/><attribute name="accessright"/>` +
    `<order attribute="privilegeid"/>` +
    `<link-entity name="privilegeobjecttypecodes" from="privilegeid" to="privilegeid" alias="ptc" link-type="inner">` +
    `<attribute name="objecttypecode"/><order attribute="objecttypecode"/>${filter}</link-entity></entity></fetch>`
  );
}
export function roleFetch(p: number, size: number, roleIds?: readonly string[]): string {
  const filter = roleIds ? `<filter><condition attribute="roleid" operator="in">${roleIds.map((v) => `<value>${xml(v)}</value>`).join('')}</condition></filter>` : '';
  return `${page(p, size)}<entity name="role"><attribute name="roleid"/><attribute name="name"/><attribute name="ismanaged"/><attribute name="parentrootroleid"/>${filter}<order attribute="roleid"/></entity></fetch>`;
}
/**
 * Grants of the given privileges, read FROM the role through the intersect table. A fetch whose root entity is `roleprivileges` makes the PPTB
 * host answer 404 (it cannot resolve that entity set; verified on the real host 2026-11-03), whereas `role` is a normal table. Each row then
 * carries `roleid` plus the aliased columns `rp.privilegeid` and `rp.privilegedepthmask`.
 */
export function rolePrivilegeFetch(p: number, size: number, privilegeIds: readonly string[], roleIds?: readonly string[]): string {
  const values = privilegeIds.map((v) => `<value>${xml(v)}</value>`).join('');
  const roleFilter = roleIds ? `<filter><condition attribute="roleid" operator="in">${roleIds.map((v) => `<value>${xml(v)}</value>`).join('')}</condition></filter>` : '';
  return (
    `${page(p, size)}<entity name="role"><attribute name="roleid"/>${roleFilter}<order attribute="roleid"/>` +
    `<link-entity name="roleprivileges" from="roleid" to="roleid" alias="rp" intersect="true"><attribute name="privilegeid"/><attribute name="privilegedepthmask"/>` +
    `<filter><condition attribute="privilegeid" operator="in">${values}</condition></filter><order attribute="privilegeid"/></link-entity></entity></fetch>`
  );
}
// ---- Role expansion reads (Role Analyzer details). Intersect tables are read FROM systemuser / team through `<link-entity intersect="true">`
// (a fetch rooted at the intersect table is a 404 on the real host). Shapes verified read-only on the real Developer environment 2026-11-03,
// except `teamroles` (no team holds a role there, so `tr.roleid` is unproven).
const USER_ATTRS = '<attribute name="systemuserid"/><attribute name="fullname"/><attribute name="isdisabled"/><attribute name="applicationid"/><attribute name="accessmode"/>';
const inList = (ids: readonly string[]) => ids.map((v) => `<value>${xml(v)}</value>`).join('');
/** One role's lineage: its own id and the root it belongs to (a root names itself; a Business Unit copy names its root). */
export function roleLineageFetch(roleId: string): string {
  return `<fetch top="1"><entity name="role"><attribute name="roleid"/><attribute name="parentrootroleid"/><filter><condition attribute="roleid" operator="eq" value="${xml(roleId)}"/></filter></entity></fetch>`;
}
/** The logical role: the root role itself plus its Business Unit copies (roots name themselves, copies name their root), with the BU name. */
export function familyRolesFetch(p: number, size: number, rootRoleId: string): string {
  return (
    `${page(p, size)}<entity name="role"><attribute name="roleid"/><attribute name="name"/><attribute name="businessunitid"/><attribute name="parentrootroleid"/><attribute name="ismanaged"/>` +
    `<filter type="or"><condition attribute="roleid" operator="eq" value="${xml(rootRoleId)}"/><condition attribute="parentrootroleid" operator="eq" value="${xml(rootRoleId)}"/></filter>` +
    `<order attribute="roleid"/><link-entity name="businessunit" from="businessunitid" to="businessunitid" alias="bu" link-type="outer"><attribute name="name"/></link-entity></entity></fetch>`
  );
}
/** Users that hold one of the roles directly: one row per (user, role) assignment, role in `sur.roleid`. */
export function roleUsersFetch(p: number, size: number, roleIds: readonly string[]): string {
  return (
    `${page(p, size)}<entity name="systemuser">${USER_ATTRS}<order attribute="systemuserid"/>` +
    `<link-entity name="systemuserroles" from="systemuserid" to="systemuserid" alias="sur" intersect="true"><attribute name="roleid"/>` +
    `<filter><condition attribute="roleid" operator="in">${inList(roleIds)}</condition></filter><order attribute="roleid"/></link-entity></entity></fetch>`
  );
}
/** Teams that hold one of the roles: one row per (team, role), role in `tr.roleid`. */
export function roleTeamsFetch(p: number, size: number, roleIds: readonly string[]): string {
  return (
    `${page(p, size)}<entity name="team"><attribute name="teamid"/><attribute name="name"/><attribute name="teamtype"/><attribute name="isdefault"/><attribute name="businessunitid"/><order attribute="teamid"/>` +
    `<link-entity name="teamroles" from="teamid" to="teamid" alias="tr" intersect="true"><attribute name="roleid"/>` +
    `<filter><condition attribute="roleid" operator="in">${inList(roleIds)}</condition></filter><order attribute="roleid"/></link-entity></entity></fetch>`
  );
}
/** Members of the given teams: one row per (user, team), team in `tm.teamid`. */
export function teamMembersFetch(p: number, size: number, teamIds: readonly string[]): string {
  return (
    `${page(p, size)}<entity name="systemuser">${USER_ATTRS}<order attribute="systemuserid"/>` +
    `<link-entity name="teammembership" from="systemuserid" to="systemuserid" alias="tm" intersect="true"><attribute name="teamid"/>` +
    `<filter><condition attribute="teamid" operator="in">${inList(teamIds)}</condition></filter><order attribute="teamid"/></link-entity></entity></fetch>`
  );
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEAM_CHUNK = 50;

/** Only an enabled, non-application user is counted as a person; application users and disabled users are listed but excluded. */
function personOf(row: Record<string, unknown>): Person | null {
  const userId = id(row, 'systemuserid');
  if (!userId) return null;
  const status: PersonStatus = text(row, 'applicationid') !== null ? 'ApplicationUser' : row['isdisabled'] === true ? 'Disabled' : 'Enabled';
  return { userId, name: text(row, 'fullname') ?? '(no name)', status };
}

function teamTypeOf(row: Record<string, unknown>): string {
  if (row['isdefault'] === true) return 'Default';
  switch (int(row, 'teamtype')) {
    case 0: return 'Owner';
    case 1: return 'Access';
    default: return 'Other';
  }
}

/** The privilege id of a grant row (aliased intersect column; the plain name is accepted too). */
function grantPrivilegeId(row: Record<string, unknown>): string | null {
  const v = aliased(row, 'rp', 'privilegeid') ?? row['privilegeid'];
  return typeof v === 'string' && v !== '' ? v.toLowerCase() : null;
}

function friendly(c: ClassifiedError): string {
  switch (c.kind) {
    case 'auth': return 'Sign-in to the environment is required or has expired.';
    // The host's own words (already stripped of tokens and cut short) say WHICH privilege or read was refused, so the owner can tell a
    // genuinely missing privilege from a wrongly classified failure.
    case 'permission': return `The signed-in user is not allowed to read this data.${c.message ? ` Host said: ${c.message.slice(0, 160)}` : ''}`;
    case 'throttled': return 'Dataverse is throttling requests; try again shortly.';
    case 'network': return 'The environment could not be reached.';
    case 'notFound': return 'The requested data was not found.';
    default: return `The read failed: ${c.message}`;
  }
}

export interface PptbReaderOptions {
  /** Omitted: the build default (open, or locked in a lock build). `null`: open. An environment: locked to it. */
  readonly expected?: ApprovedEnvironment | null;
  readonly paging?: PagingStrategy;
  readonly retry?: RetryOptions;
  readonly newCorrelationId?: () => string;
  /** Receives non-sensitive trace events (operation, correlation id, page counts, error kind). */
  readonly trace?: (event: { readonly correlationId: string; readonly step: string; readonly detail?: string }) => void;
}

interface ConnectionsApi {
  getActiveConnection?: () => Promise<{ id?: string; url?: string } | null>;
  getConnections?: () => Promise<Array<{ url?: string } | null>>;
}

interface Session {
  readonly cid: string;
  readonly fingerprint: string;
}

export class PptbSecurityDataReader implements SecurityDataReader {
  private readonly expected: ApprovedEnvironment | null;
  private readonly paging: PagingStrategy;
  private readonly retry: RetryOptions;
  private readonly trace: NonNullable<PptbReaderOptions['trace']>;
  private readonly nextId: () => string;
  private verified: { readonly key: string; readonly result: IdentityResult } | null = null;
  private counter = 0;

  constructor(private readonly host: ReadOnlyHost, private readonly connections: ConnectionsApi | undefined, options: PptbReaderOptions = {}) {
    this.expected = options.expected === undefined ? lockedEnvironment() : options.expected;
    this.paging = options.paging ?? createPageNumberStrategy();
    this.retry = options.retry ?? {};
    this.trace = options.trace ?? (() => undefined);
    this.nextId = options.newCorrelationId ?? (() => `dsm-${Date.now().toString(36)}-${(++this.counter).toString(36)}`);
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

  /**
   * The Business Unit instances of one logical role for a table, with direct users, role-bearing teams and their members. Read lazily when a
   * role is expanded. Nothing is invented: a section that could not be read completely makes the result `partial` (the numbers derived from it
   * are lower bounds). Effective record access is NOT evaluated: only direct assignments and team membership of teams that hold the role.
   */
  async loadRoleDetails(tableLogicalName: string, rootRoleId: string): Promise<ReadResult<RoleFamily>> {
    const cid = this.nextId();
    if (!TABLE_NAME.test(tableLogicalName)) {
      return { status: 'error', errorClass: 'notFound', message: `"${tableLogicalName}" is not a valid table logical name. (ref ${cid})` };
    }
    if (!GUID_RE.test(rootRoleId)) {
      return { status: 'error', errorClass: 'notFound', message: `"${rootRoleId}" is not a role id. (ref ${cid})` };
    }
    const given = rootRoleId.toLowerCase();
    return this.guarded(cid, async (s) => {
      this.trace({ correlationId: cid, step: 'loadRoleDetails', detail: tableLogicalName });
      const notes: string[] = [];
      // The matrix lists concrete role records, so the id may be a Business Unit COPY: resolve it to its root first (a root names itself), or
      // only that one copy would be found. A failed lookup is an error (the family cannot be identified); a role whose lineage cannot be read
      // is shown alone, flagged as partial.
      const lineage = await this.call(s, () => this.host.fetchXmlQuery(roleLineageFetch(given)));
      const own = Array.isArray(lineage?.value) ? lineage.value.find((r) => id(r, 'roleid') === given) : undefined;
      if (!own) return { status: 'error', errorClass: 'notFound', message: `The role was not found. (ref ${cid})` };
      const parentRoot = lookupId(own, 'parentrootroleid');
      const root = parentRoot ?? given;
      if (parentRoot === null) notes.push('The lineage of this role could not be read, so only this one role instance is shown; its Business Unit copies may be missing.');
      const soft = async (label: string, work: () => Promise<PagedRows>): Promise<PagedRows | null> => {
        try {
          const r = await work();
          if (!r.complete) notes.push(r.note ?? `${label} were read only in part.`);
          return r;
        } catch (e) {
          const c = classifyHostError(e);
          if (c.kind === 'connectionChanged') throw e;
          notes.push(`${label} could not be read (${c.kind}).`);
          return null;
        }
      };

      // 1. The instances of the logical role. Without them there is nothing to show: a failure here is an error, not a partial result.
      const roleRows = await this.readPaged(s, (pg, sz) => familyRolesFetch(pg, sz, root), 'role instances');
      const family = roleRows.rows.map((r) => ({ roleId: id(r, 'roleid'), row: r })).filter((x): x is { roleId: string; row: Record<string, unknown> } => x.roleId !== null);
      if (family.length === 0) {
        if (!roleRows.complete) return { status: 'error', errorClass: 'unknown', message: `The role instances could not be read completely. (ref ${cid})` };
        return { status: 'error', errorClass: 'notFound', message: `The role was not found. (ref ${cid})` };
      }
      if (!roleRows.complete) notes.push(roleRows.note ?? 'The role instances were read only in part; some Business Unit copies may be missing.');
      const roleIds = family.map((f) => f.roleId);

      // 2. The privilege cells of each instance for this table (the same read and rules as the matrix, restricted to these roles).
      const matrix = await this.buildMatrix(s, cid, tableLogicalName, roleIds);
      if (matrix.status === 'error') return matrix;
      if (matrix.status === 'partial') notes.push(...matrix.notes);
      const cellsOf = new Map(matrix.data.roles.map((r) => [r.roleId, r.cells]));

      // 3. Direct users, 4. role-bearing teams, 5. their members. Each is its own read; a failed one leaves its section empty AND flags the result.
      const userRows = await soft('The direct users', () => this.readPaged(s, (pg, sz) => roleUsersFetch(pg, sz, roleIds), 'role users'));
      const teamRows = await soft('The teams that hold this role', () => this.readPaged(s, (pg, sz) => roleTeamsFetch(pg, sz, roleIds), 'role teams'));
      const teamIds = [...new Set((teamRows?.rows ?? []).map((r) => id(r, 'teamid')).filter((v): v is string => v !== null))];
      const memberRowsByChunk: PagedRows[] = [];
      for (let i = 0; i < teamIds.length; i += TEAM_CHUNK) {
        const chunk = teamIds.slice(i, i + TEAM_CHUNK);
        const r = await soft('The team members', () => this.readPaged(s, (pg, sz) => teamMembersFetch(pg, sz, chunk), 'team members'));
        if (r) memberRowsByChunk.push(r);
      }

      const directByRole = new Map<string, Map<string, Person>>();
      for (const r of userRows?.rows ?? []) {
        const rid = linkedId(r, 'sur', 'roleid');
        const person = personOf(r);
        if (!rid || !person) continue;
        const m = directByRole.get(rid) ?? new Map<string, Person>();
        m.set(person.userId, person);
        directByRole.set(rid, m);
      }
      const membersByTeam = new Map<string, Map<string, Person>>();
      for (const chunk of memberRowsByChunk) {
        for (const r of chunk.rows) {
          const tid = linkedId(r, 'tm', 'teamid');
          const person = personOf(r);
          if (!tid || !person) continue;
          const m = membersByTeam.get(tid) ?? new Map<string, Person>();
          m.set(person.userId, person);
          membersByTeam.set(tid, m);
        }
      }
      const teamsByRole = new Map<string, Map<string, TeamNode>>();
      for (const r of teamRows?.rows ?? []) {
        const tid = id(r, 'teamid');
        const rid = linkedId(r, 'tr', 'roleid');
        if (!tid || !rid) continue;
        const node: TeamNode = {
          teamId: tid,
          name: text(r, 'name') ?? '(unnamed team)',
          teamType: teamTypeOf(r),
          businessUnitId: lookupId(r, 'businessunitid') ?? '',
          members: [...(membersByTeam.get(tid)?.values() ?? [])],
        };
        const m = teamsByRole.get(rid) ?? new Map<string, TeamNode>();
        m.set(tid, node);
        teamsByRole.set(rid, m);
      }

      const instances: RoleInstance[] = family.map(({ roleId, row }) => ({
        roleId,
        businessUnitId: lookupId(row, 'businessunitid') ?? '',
        businessUnitName: aliasedText(row, 'bu', 'name') ?? '(unknown Business Unit)',
        cells: cellsOf.get(roleId) ?? unknownCells(),
        directUsers: [...(directByRole.get(roleId)?.values() ?? [])],
        teams: [...(teamsByRole.get(roleId)?.values() ?? [])],
      }));
      // The root first, then the copies by Business Unit name: a stable order for display.
      instances.sort((a, b) => Number(b.roleId === root) - Number(a.roleId === root) || a.businessUnitName.localeCompare(b.businessUnitName) || a.roleId.localeCompare(b.roleId));
      const rootRow = family.find((f) => f.roleId === root)?.row ?? family[0]?.row;
      const data: RoleFamily = { rootRoleId: root, name: text(rootRow ?? {}, 'name') ?? '(unnamed role)', instances };
      return notes.length > 0 ? { status: 'partial', data, notes: withRef(notes, cid) } : { status: 'ok', data };
    });
  }

  async listTables(): Promise<ReadResult<readonly TableInfo[]>> {
    const cid = this.nextId();
    return this.guarded(cid, async (s) => {
      this.trace({ correlationId: cid, step: 'listTables' });
      // Selected properties only: names and flags, no attribute payloads.
      const meta = await this.call(s, () => this.host.getAllEntitiesMetadata(['LogicalName', 'DisplayName', 'IsPrivate', 'IsIntersect']));
      const notes: string[] = [];
      let withPrivileges: Set<string> | null;
      try {
        const paged = await this.readPaged(s, (pg, sz) => privilegeFetch(pg, sz), 'privilege catalog');
        withPrivileges = new Set<string>();
        for (const r of paged.rows) {
          const right = int(r, 'accessright');
          const table = aliased(r, 'ptc', 'objecttypecode');
          if (right !== null && ACCESS_RIGHT_TO_PRIVILEGE.has(right) && typeof table === 'string' && table && table.toLowerCase() !== 'none') {
            withPrivileges.add(table.toLowerCase());
          }
        }
        if (!paged.complete) {
          // Missing rows prove nothing: an incomplete catalog must not mark any table unsupported.
          withPrivileges = null;
          notes.push(`The privilege catalog was read only in part, so which tables support security roles could not be determined; all tables are listed as supported. ${paged.note ?? ''}`.trim());
        }
      } catch (e) {
        const kind = classifyHostError(e).kind;
        if (kind === 'connectionChanged') throw e;
        withPrivileges = null;
        notes.push(`Which tables support security roles could not be determined (${kind}); all tables are listed as supported.`);
      }
      const tables: TableInfo[] = [];
      for (const raw of meta.value) {
        const logicalName = text(raw, 'LogicalName');
        if (!logicalName || raw['IsPrivate'] === true || raw['IsIntersect'] === true) continue;
        const supported = withPrivileges === null || withPrivileges.has(logicalName.toLowerCase());
        tables.push({
          logicalName,
          displayName: displayNameOf(raw) ?? logicalName,
          supported,
          ...(supported ? {} : { unsupportedReason: UNSUPPORTED_REASON }),
        });
      }
      tables.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.logicalName.localeCompare(b.logicalName));
      return notes.length > 0 ? { status: 'partial', data: tables, notes: withRef(notes, cid) } : { status: 'ok', data: tables };
    });
  }

  async loadRoleMatrix(tableLogicalName: string): Promise<ReadResult<RoleMatrix>> {
    const cid = this.nextId();
    if (!TABLE_NAME.test(tableLogicalName)) {
      return { status: 'error', errorClass: 'notFound', message: `"${tableLogicalName}" is not a valid table logical name. (ref ${cid})` };
    }
    return this.guarded(cid, (s) => {
      this.trace({ correlationId: cid, step: 'loadRoleMatrix', detail: tableLogicalName });
      return this.buildMatrix(s, cid, tableLogicalName, undefined, true);
    });
  }

  /**
   * The matrix of one table; `roleIds` restricts it to those role instances (used by the role expansion, which needs the concrete instances).
   * `groupByLineage` returns one row per logical role (its root) with the copies counted in `lineage`; the matrix screen uses it.
   */
  private async buildMatrix(s: Session, cid: string, tableLogicalName: string, roleIds?: readonly string[], groupByLineage = false): Promise<ReadResult<RoleMatrix>> {
    {
      const meta = await this.call(s, () => this.host.getEntityMetadata(tableLogicalName, true, ['LogicalName', 'DisplayName', 'ObjectTypeCode']));
      const table: TableInfo = { logicalName: tableLogicalName, displayName: displayNameOf(meta) ?? tableLogicalName, supported: true };

      // 1. Which of the eight privileges exist for this table. Filtered on the server by the integer ObjectTypeCode when the metadata
      // supplies it; otherwise the whole catalog is read and filtered here. Either way each row is checked again below.
      const code = meta['ObjectTypeCode'];
      const objectTypeCode = typeof code === 'number' && Number.isInteger(code) && code > 0 ? code : undefined;
      const privRows = await this.readPaged(s, (pg, sz) => privilegeFetch(pg, sz, objectTypeCode), 'table privileges');
      const privilegeByName = new Map<PrivilegeId, string>();
      for (const r of privRows.rows) {
        const right = int(r, 'accessright');
        const pid = id(r, 'privilegeid');
        const forTable = aliased(r, 'ptc', 'objecttypecode');
        const operation = right === null ? undefined : ACCESS_RIGHT_TO_PRIVILEGE.get(right);
        if (pid && operation && typeof forTable === 'string' && forTable.toLowerCase() === tableLogicalName.toLowerCase()) privilegeByName.set(operation, pid);
      }
      if (privilegeByName.size === 0 && !privRows.complete) {
        return { status: 'error', errorClass: 'unknown', message: `The security privileges of this table could not be determined (the privilege list was read only in part). (ref ${cid})` };
      }
      if (privilegeByName.size === 0) {
        return { status: 'error', errorClass: 'notFound', message: `${UNSUPPORTED_REASON}. (ref ${cid})` };
      }
      const privilegeIds = [...new Set(privilegeByName.values())];

      // 2. Roles (a role instance per business unit is a separate row; lineage grouping comes with the expansion increment).
      const roleRows = await this.readPaged(s, (pg, sz) => roleFetch(pg, sz, roleIds), 'roles');
      // 3. Grants of those privileges. A failed page leaves absence unprovable, so such cells become `unknown`.
      let grants: PagedRows;
      try {
        grants = await this.readPaged(s, (pg, sz) => rolePrivilegeFetch(pg, sz, privilegeIds, roleIds), 'role privileges');
      } catch (e) {
        const c = classifyHostError(e);
        if (c.kind === 'connectionChanged') throw e;
        grants = { rows: [], complete: false, pages: 0, error: c, note: `Role privileges could not be read (${c.kind}).` };
      }

      const depthByKey = new Map<string, DepthId | 'bad'>();
      let badDepths = 0;
      let unattributable = 0;
      for (const g of grants.rows) {
        const roleId = id(g, 'roleid');
        const privId = grantPrivilegeId(g);
        // A grant that cannot be attributed to a role and privilege may hide any cell's grant: absence is then unprovable.
        if (!roleId || !privId) { unattributable++; continue; }
        // An omitted, null, string, float, NaN or otherwise unreadable mask still proves that a grant exists for this cell,
        // only its depth is unknown: record `bad` (shown as unknown), never drop the row (that would read as no grant).
        const mask = depthMask(g);
        const depth = mask === null ? null : depthFromMask(mask);
        if (depth === null) badDepths++;
        depthByKey.set(`${roleId}|${privId}`, depth ?? 'bad');
      }
      const absenceProvable = grants.complete && unattributable === 0;

      // A root role has no parent root, and FetchXML omits null columns, so "absent" proves nothing unless the host returns the lookup at all:
      // lineage is only trusted when at least one row carries it (UNVERIFIED which column name the host uses: `_x_value` or the plain name).
      const parentRootOf = (r: Record<string, unknown>) => id(r, '_parentrootroleid_value') ?? id(r, 'parentrootroleid');
      const lineageReadable = roleRows.rows.some((r) => parentRootOf(r) !== null);
      const roles: RoleRow[] = [];
      for (const r of roleRows.rows) {
        const roleId = id(r, 'roleid');
        if (!roleId) continue;
        const cells = {} as Record<PrivilegeId, CellValue>;
        for (const p of PRIVILEGE_IDS) {
          const privId = privilegeByName.get(p);
          // Not applicable only when the whole catalog was read; after a partial read the definition may just be missing.
          if (!privId) { cells[p] = privRows.complete ? { kind: 'notApplicable' } : { kind: 'unknown' }; continue; }
          const found = depthByKey.get(`${roleId}|${privId}`);
          if (found === 'bad') cells[p] = { kind: 'unknown' };
          else if (found) cells[p] = { kind: 'depth', depth: found };
          else cells[p] = absenceProvable ? { kind: 'noGrant' } : { kind: 'unknown' };
        }
        roles.push({
          roleId,
          name: text(r, 'name') ?? '(unnamed role)',
          cells: cells as PrivilegeCells,
          ...(typeof r['ismanaged'] === 'boolean' ? { isManaged: r['ismanaged'] } : {}),
          ...(lineageReadable ? { parentRootRoleId: normalizeParentRoot(roleId, parentRootOf(r)) } : {}),
        });
      }
      const rows = groupByLineage ? groupRolesByLineage(roles) : roles;
      rows.sort((a, b) => a.name.localeCompare(b.name) || a.roleId.localeCompare(b.roleId));

      const notes: string[] = [];
      if (!roleRows.complete) notes.push(roleRows.note ?? 'The role list was read only in part; some roles may be missing.');
      if (!grants.complete) notes.push(`${grants.note ?? 'Role privileges were read only in part.'} Affected cells are shown as unknown.`);
      if (!privRows.complete) notes.push(privRows.note ?? 'The table privilege list was read only in part.');
      if (badDepths > 0) notes.push(`${badDepths} privilege grant(s) had an unrecognized depth; those cells are shown as unknown.`);
      if (unattributable > 0) notes.push(`${unattributable} privilege grant(s) could not be attributed to a role and privilege; cells without a grant are shown as unknown.`);
      const matrix: RoleMatrix = { table, roles: rows, privilegeCatalog: Object.fromEntries(privilegeByName) as Partial<Record<PrivilegeId, string>> };
      return notes.length > 0 ? { status: 'partial', data: matrix, notes: withRef(notes, cid) } : { status: 'ok', data: matrix };
    }
  }

  // ---- internals
  /**
   * Identity first, then the read. `environmentIdUnverifiable` still allows reading (it only blocks writes, which this
   * reader cannot do); callers that need the distinction use verifyIdentity().
   */
  private async guarded<T>(cid: string, work: (session: Session) => Promise<ReadResult<T>>): Promise<ReadResult<T>> {
    try {
      const before = await connectionFingerprint(this.connections);
      const identity = await this.verifyIdentity();
      if (identity.status === 'refused') {
        this.trace({ correlationId: cid, step: 'identityRefused', detail: identity.reason });
        return { status: 'error', errorClass: 'permission', message: `${identity.message} (ref ${cid})` };
      }
      // The connection must be the same one before and after verification; from here on every request re-checks it.
      const after = await connectionFingerprint(this.connections);
      if (before === null || before !== after) throw new ConnectionChangedError();
      return await work({ cid, fingerprint: before });
    } catch (e) {
      const c = classifyHostError(e);
      this.trace({ correlationId: cid, step: 'error', detail: c.kind });
      return { status: 'error', errorClass: toPortErrorClass(c.kind), message: `${friendly(c)} (ref ${cid})` };
    }
  }

  /**
   * Every host request (each page, each retry) is bracketed by a connection check: the host resolves `primary` at call
   * time, so a connection switch mid-read must not send later requests, or return earlier answers, for another
   * environment. A change aborts the whole operation (ConnectionChangedError is never retried and never turned into a
   * partial result).
   */
  private async assertSameConnection(session: Session): Promise<void> {
    if ((await connectionFingerprint(this.connections)) !== session.fingerprint) {
      this.trace({ correlationId: session.cid, step: 'connectionChanged' });
      throw new ConnectionChangedError();
    }
  }

  private call<T>(session: Session, fn: () => Promise<T>): Promise<T> {
    return withRetry(async () => {
      await this.assertSameConnection(session);
      const result = await fn();
      await this.assertSameConnection(session);
      return result;
    }, this.retry);
  }

  private async readPaged(session: Session, build: (page: number, size: number) => string, label: string): Promise<PagedRows> {
    const result = await this.paging.readAll(
      build,
      (fetchXml) => this.call(session, () => this.host.fetchXmlQuery(fetchXml)),
      (row) => JSON.stringify(row),
    );
    this.trace({ correlationId: session.cid, step: 'pages', detail: `${label}: ${result.pages} page(s), ${result.rows.length} row(s), complete=${result.complete}` });
    return result;
  }
}

/** A lookup column of a row: `col` or `_col_value`. */
function lookupId(row: Record<string, unknown>, column: string): string | null {
  return id(row, `_${column}_value`) ?? id(row, column);
}
/** An aliased link-entity text column: `alias.col` or `alias_x002e_col`. */
function aliasedText(row: Record<string, unknown>, alias: string, column: string): string | null {
  const v = aliased(row, alias, column);
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function unknownCells(): PrivilegeCells {
  return Object.fromEntries(PRIVILEGE_IDS.map((p) => [p, { kind: 'unknown' }])) as unknown as PrivilegeCells;
}

function withRef(notes: readonly string[], cid: string): readonly string[] {
  return notes.map((n, i) => (i === notes.length - 1 ? `${n} (ref ${cid})` : n));
}

export function displayNameOf(raw: Record<string, unknown>): string | null {
  const dn = raw['DisplayName'] as { UserLocalizedLabel?: { Label?: string } | null; LocalizedLabels?: Array<{ Label?: string }> } | undefined;
  return dn?.UserLocalizedLabel?.Label ?? dn?.LocalizedLabels?.[0]?.Label ?? null;
}

/**
 * Factory only; nothing wires this into the UI yet. Returns an error-reporting reader when the host does not provide
 * the Dataverse API (for example in a plain browser), so callers never receive a half-working adapter.
 */
export function createPptbSecurityDataReader(host: HostWindow | undefined, options: PptbReaderOptions = {}): SecurityDataReader {
  const api = host?.dataverseAPI;
  if (!api) {
    const unavailable = async <T>(): Promise<ReadResult<T>> => ({
      status: 'error',
      errorClass: 'unknown',
      message: 'The PPTB host Dataverse API is not available in this context.',
    });
    return { listTables: () => unavailable(), loadRoleMatrix: () => unavailable(), loadRoleDetails: () => unavailable() };
  }
  return new PptbSecurityDataReader(createReadOnlyHost(api), host?.toolboxAPI?.connections, options);
}
