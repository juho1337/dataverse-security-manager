import { createFakeDataverse, APPROVED, connections, PRIVS, SYNTHETIC_PRIVILEGES, SYNTHETIC_TABLES, type FakeOptions } from './fakeDataverse';
import { rejectRootIntersect } from './intersectFake';
import { createPageNumberStrategy } from '../adapters/pptb/paging';
import { createReadOnlyHost } from '../adapters/pptb/readOnlyHost';
import { PptbSecurityDataReader } from '../adapters/pptb/reader';

// Role expansion (Role Analyzer details) against an in-memory host that answers the five reads the way the REAL service does (shapes verified
// read-only on the Developer environment 2026-11-03): intersect tables are read FROM systemuser/team through a link-entity (a root intersect fetch
// is a 404), link columns come back as `alias.column`, lookups as `_x_value`.

export type Row = Record<string, unknown>;
const fast = { sleep: async () => undefined, random: () => 1 };

export const ROOT = 'e0000000-0000-0000-0000-0000000000a1';
export const COPY = 'e0000000-0000-0000-0000-0000000000a2';
export const OTHER = 'e0000000-0000-0000-0000-0000000000b1';
export const BU_ROOT = 'bb000000-0000-0000-0000-000000000001';
export const BU_NORTH = 'bb000000-0000-0000-0000-000000000002';
export const U_ENABLED = 'f0000000-0000-0000-0000-000000000001';
export const U_DISABLED = 'f0000000-0000-0000-0000-000000000002';
export const U_APP = 'f0000000-0000-0000-0000-000000000003';
export const U_MEMBER = 'f0000000-0000-0000-0000-000000000004';
export const T1 = 'a1000000-0000-0000-0000-000000000001';

export const roles: Row[] = [
  { roleid: ROOT, name: 'Lineage Role', _parentrootroleid_value: ROOT, _businessunitid_value: BU_ROOT, 'bu.name': 'Contoso' },
  { roleid: COPY, name: 'Lineage Role', _parentrootroleid_value: ROOT, _businessunitid_value: BU_NORTH, 'bu.name': 'North' },
  { roleid: OTHER, name: 'Unrelated Role', _parentrootroleid_value: OTHER, _businessunitid_value: BU_ROOT, 'bu.name': 'Contoso' },
];
export const grants: Row[] = [
  { roleid: ROOT, privilegeid: PRIVS.read, privilegedepthmask: 8 },
  { roleid: COPY, privilegeid: PRIVS.read, privilegedepthmask: 2 },
  { roleid: OTHER, privilegeid: PRIVS.read, privilegedepthmask: 1 },
];
const user = (id: string, name: string, extra: Row = {}): Row => ({ systemuserid: id, fullname: name, isdisabled: false, accessmode: 0, ...extra });
export const userRoles: Array<{ user: Row; roleid: string }> = [
  { user: user(U_ENABLED, 'Ada Enabled'), roleid: ROOT },
  { user: user(U_DISABLED, 'Dan Disabled', { isdisabled: true }), roleid: ROOT },
  { user: user(U_APP, 'Svc App', { applicationid: 'cc000000-0000-0000-0000-000000000009', accessmode: 4 }), roleid: COPY },
];
export const teams: Array<{ team: Row; roleid: string }> = [
  { team: { teamid: T1, name: 'Contoso Team', teamtype: 0, isdefault: false, _businessunitid_value: BU_ROOT }, roleid: ROOT },
];
export const memberships: Array<{ user: Row; teamid: string }> = [
  { user: user(U_ENABLED, 'Ada Enabled'), teamid: T1 },
  { user: user(U_MEMBER, 'Mia Member'), teamid: T1 },
];

const values = (fetchXml: string): string[] => [...fetchXml.matchAll(/<value>([^<]+)<\/value>/g)].map((m) => (m[1] ?? '').toLowerCase());
export const rootOf = (fetchXml: string): string => /<entity name="(\w+)"/.exec(fetchXml)?.[1] ?? '';

export interface Opts {
  failLineage?: unknown;
  /** The lineage read returns the role without its root (a host that omits the lookup). */
  lineageWithoutRoot?: boolean;
  failFamily?: unknown;
  failUsers?: unknown;
  failTeams?: unknown;
  failMembers?: unknown;
  rolesOverride?: Row[];
  pageSize?: number;
}

export function makeExpansionReader(opts: Opts = {}, fakeOptions: FakeOptions = {}) {
  const fake = createFakeDataverse({
    tables: SYNTHETIC_TABLES, privileges: SYNTHETIC_PRIVILEGES, roles: opts.rolesOverride ?? roles, grants, ...fakeOptions,
  });
  const original = fake.api.fetchXmlQuery!;
  const api = fake.api as unknown as Record<string, unknown>;
  api['fetchXmlQuery'] = async (fetchXml: string, target?: 'primary') => {
    const root = rootOf(fetchXml);
    rejectRootIntersect(root);
    const page = Number(/page="(\d+)"/.exec(fetchXml)?.[1] ?? '1');
    const count = Number(/count="(\d+)"/.exec(fetchXml)?.[1] ?? '5000');
    const handled = () => fake.calls.push({ method: 'fetchXmlQuery', args: [fetchXml] });
    const slice = (rows: Row[]) => ({ value: rows.slice((page - 1) * count, page * count) });
    // one role's lineage (its root): `top="1"`, a single `roleid eq`
    if (root === 'role' && fetchXml.includes('<fetch top="1">')) {
      handled();
      if (opts.failLineage) throw opts.failLineage;
      const wanted = /attribute="roleid" operator="eq" value="([^"]+)"/.exec(fetchXml)?.[1]?.toLowerCase();
      const found = (opts.rolesOverride ?? roles).find((r) => String(r['roleid']).toLowerCase() === wanted);
      if (!found) return { value: [] };
      return { value: [opts.lineageWithoutRoot ? { roleid: found['roleid'] } : { roleid: found['roleid'], _parentrootroleid_value: found['_parentrootroleid_value'] }] };
    }
    // family instances (root or copies of ROOT) with the Business Unit name
    if (root === 'role' && fetchXml.includes('type="or"') && fetchXml.includes('parentrootroleid')) {
      const id = /attribute="roleid" operator="eq" value="([^"]+)"/.exec(fetchXml)?.[1]?.toLowerCase();
      handled();
      if (opts.failFamily) throw opts.failFamily;
      return slice((opts.rolesOverride ?? roles).filter((r) => String(r['roleid']).toLowerCase() === id || String(r['_parentrootroleid_value']).toLowerCase() === id));
    }
    if (root === 'systemuser' && fetchXml.includes('alias="sur"')) {
      handled();
      if (opts.failUsers) throw opts.failUsers;
      const ids = values(fetchXml);
      return slice(userRoles.filter((x) => ids.includes(x.roleid)).map((x) => ({ ...x.user, 'sur.roleid': x.roleid })));
    }
    if (root === 'team' && fetchXml.includes('alias="tr"')) {
      handled();
      if (opts.failTeams) throw opts.failTeams;
      const ids = values(fetchXml);
      return slice(teams.filter((x) => ids.includes(x.roleid)).map((x) => ({ ...x.team, 'tr.roleid': x.roleid })));
    }
    if (root === 'systemuser' && fetchXml.includes('alias="tm"')) {
      handled();
      if (opts.failMembers) throw opts.failMembers;
      const ids = values(fetchXml);
      return slice(memberships.filter((x) => ids.includes(x.teamid)).map((x) => ({ ...x.user, 'tm.teamid': x.teamid })));
    }
    // matrix reads restricted to roles: the real service filters on the root `roleid in (...)`; the generic fake does not
    const result = (await original(fetchXml, target)) as { value: Row[] };
    const restrict = /<attribute name="roleid"\/>(?:<attribute name="[a-z]+"\/>)*<filter><condition attribute="roleid" operator="in">(.*?)<\/condition><\/filter>/.exec(fetchXml)?.[1];
    if (root === 'role' && restrict) {
      const ids = values(restrict);
      return { value: result.value.filter((r) => ids.includes(String(r['roleid']).toLowerCase())) };
    }
    return result;
  };
  const reader = new PptbSecurityDataReader(createReadOnlyHost(fake.api), connections([APPROVED.url]), { retry: fast, newCorrelationId: () => 'cid-1', ...(opts.pageSize ? { paging: createPageNumberStrategy({ pageSize: opts.pageSize }) } : {}) });
  return { fake, reader };
}

