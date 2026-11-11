import { describe, expect, it } from 'vitest';
import { APPROVED, connections, createFakeDataverse } from '../../test/fakeDataverse';
import { APPROVED_DEVELOPER_ENVIRONMENT } from './config';
import { PptbAccessReader, createPptbAccessReader, userSearchFetch } from './accessReader';
import { intersectLink, rejectRootIntersect, shapeIntersectRow } from '../../test/intersectFake';
import { createPageNumberStrategy } from './paging';
import { createReadOnlyHost } from './readOnlyHost';

type Row = Record<string, unknown>;

const fast = { sleep: async () => undefined, random: () => 1 };
const g = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const BU_HQ = g(901);
const BU_N = g(902);
const U_ANN = g(1);
const U_BEN = g(2);
const R_ADMIN = g(11);
const R_BASIC = g(12);
const R_CONTRIB = g(13);
const T_DEF = g(21);
const T_OWN = g(22);
const T_ACC = g(23);

function dataset(): Record<string, Row[]> {
  return {
    businessunit: [{ businessunitid: BU_HQ, name: 'Contoso' }, { businessunitid: BU_N, name: 'North' }],
    systemuser: [
      { systemuserid: U_ANN, fullname: 'Ann Admin', internalemailaddress: 'ann@example.test', businessunitid: BU_HQ, isdisabled: false, applicationid: null },
      { systemuserid: U_BEN, fullname: 'Ben Brooks', internalemailaddress: 'ben@example.test', _businessunitid_value: BU_N, isdisabled: true, applicationid: null },
      { systemuserid: g(3), fullname: 'Svc Integration', internalemailaddress: null, businessunitid: BU_HQ, isdisabled: false, applicationid: g(99) },
    ],
    role: [
      { roleid: R_ADMIN, name: 'System Administrator', businessunitid: BU_HQ, ismanaged: true },
      { roleid: R_BASIC, name: 'Basic User', businessunitid: BU_HQ },
      { roleid: R_CONTRIB, name: 'Project Contributor', businessunitid: BU_N },
    ],
    systemuserroles: [{ systemuserid: U_ANN, roleid: R_ADMIN }, { systemuserid: U_ANN, roleid: R_CONTRIB }, { systemuserid: U_BEN, roleid: R_BASIC }],
    team: [
      { teamid: T_DEF, name: 'Contoso', teamtype: 0, isdefault: true, businessunitid: BU_HQ },
      { teamid: T_OWN, name: 'Project Delivery', teamtype: 0, isdefault: false, businessunitid: BU_N },
      { teamid: T_ACC, name: 'Reviewers', teamtype: 1, isdefault: false, businessunitid: BU_HQ },
    ],
    teamroles: [{ teamid: T_DEF, roleid: R_BASIC }, { teamid: T_OWN, roleid: R_CONTRIB }, { teamid: T_ACC, roleid: R_ADMIN }],
    teammembership: [
      { teamid: T_DEF, systemuserid: U_ANN }, { teamid: T_OWN, systemuserid: U_ANN }, { teamid: T_ACC, systemuserid: U_ANN },
      { teamid: T_DEF, systemuserid: U_BEN }, { teamid: T_DEF, systemuserid: g(3) },
    ],
  };
}

interface Opts {
  data?: Record<string, Row[]>;
  failEntity?: { entity: string; error: unknown; times?: number };
  urls?: Array<string | null>;
  pageSize?: number;
}

/** Fake host: answers the FetchXML the access reader sends (eq / in / like filters, link to businessunit, top, page+count). */
function make(opts: Opts = {}) {
  const data = opts.data ?? dataset();
  const fake = createFakeDataverse();
  let failures = opts.failEntity?.times ?? 99;
  const fetches: string[] = [];
  fake.api.fetchXmlQuery = async (fetchXml: string) => {
    fetches.push(fetchXml);
    fake.calls.push({ method: 'fetchXmlQuery', args: [fetchXml] });
    const rootEntity = /<entity name="(\w+)"/.exec(fetchXml)?.[1] ?? '';
    rejectRootIntersect(rootEntity); // like the real host: a fetch rooted at an intersect table is a 404
    const link = intersectLink(fetchXml, rootEntity);
    const entity = link ? link.table : rootEntity;
    if (opts.failEntity?.entity === entity && failures > 0) {
      failures--;
      throw opts.failEntity.error;
    }
    const conds = [...fetchXml.matchAll(/<condition attribute="(\w+)" operator="(\w+)"(?: value="([^"]*)")?(?:\/>|>([\s\S]*?)<\/condition>)/g)];
    const isOr = fetchXml.includes('<filter type="or">');
    const test = (row: Row, c: RegExpMatchArray) => {
      const v = String(row[c[1] ?? ''] ?? row[`_${c[1]}_value`] ?? '').toLowerCase();
      if (c[2] === 'eq') return v === (c[3] ?? '').toLowerCase();
      if (c[2] === 'in') return [...(c[4] ?? '').matchAll(/<value>([^<]+)<\/value>/g)].some((m) => (m[1] ?? '').toLowerCase() === v);
      // SQL LIKE: `%` is a wildcard, `[x]` matches x literally.
      const like = c[3] ?? '';
      const lit = (ch: string) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      let pattern = '';
      for (let i = 0; i < like.length; i++) {
        const ch = like.charAt(i);
        if (ch === '[' && like.charAt(i + 2) === ']') { pattern += lit(like.charAt(i + 1)); i += 2; }
        else pattern += ch === '%' ? '.*' : lit(ch);
      }
      return new RegExp(`^${pattern}$`, 'i').test(String(row[c[1] ?? ''] ?? ''));
    };
    let rows = (data[entity] ?? []).filter((r) => (isOr ? conds.some((c) => test(r, c)) : conds.every((c) => test(r, c))));
    if (link) rows = rows.map((r) => shapeIntersectRow(r, link));
    if (fetchXml.includes('alias="bu"')) {
      rows = rows.map((r) => {
        const b = (data['businessunit'] ?? []).find((x) => x['businessunitid'] === (r['businessunitid'] ?? r['_businessunitid_value']));
        return b ? { ...r, 'bu.name': b['name'] } : r;
      });
    }
    const top = /<fetch top="(\d+)"/.exec(fetchXml)?.[1];
    if (top) return { value: rows.slice(0, Number(top)) };
    const page = Number(/page="(\d+)"/.exec(fetchXml)?.[1] ?? '1');
    const count = Number(/count="(\d+)"/.exec(fetchXml)?.[1] ?? '5000');
    return { value: rows.slice((page - 1) * count, page * count) };
  };
  const reader = new PptbAccessReader(createReadOnlyHost(fake.api), connections(opts.urls ?? [APPROVED.url]), {
    retry: fast,
    newCorrelationId: () => 'cid-1',
    paging: createPageNumberStrategy({ pageSize: opts.pageSize ?? 5000 }),
    expected: APPROVED_DEVELOPER_ENVIRONMENT,
  });
  return { fake, reader, fetches };
}

describe('searchUsers', () => {
  it('finds users by name or email, includes disabled and application users and reads the business unit through the link', async () => {
    const { reader } = make();
    const r = await reader.searchUsers('example.test');
    expect(r.status).toBe('ok');
    if (r.status === 'error') return;
    expect(r.data.map((h) => h.user.fullName)).toEqual(['Ann Admin', 'Ben Brooks']);
    expect(r.data[1]?.user).toMatchObject({ isDisabled: true, isApplicationUser: false, businessUnitId: BU_N });
    expect(r.data[1]?.businessUnitName).toBe('North');
    const svc = await reader.searchUsers('svc');
    expect(svc.status === 'ok' && svc.data[0]?.user).toMatchObject({ isApplicationUser: true, email: '' });
  });

  it('does not read anything for a query shorter than two characters', async () => {
    const { reader, fetches } = make();
    expect(await reader.searchUsers(' a ')).toEqual({ status: 'ok', data: [] });
    expect(await reader.searchTeams('')).toEqual({ status: 'ok', data: [] });
    expect(fetches).toEqual([]);
  });

  it('escapes LIKE wildcards and XML so typed characters match themselves', () => {
    const xmlText = userSearchFetch('50%_[x]"<');
    expect(xmlText).toContain('value="%50[%][_][[]x]&quot;&lt;%"');
  });

  it('reports a capped result as partial, never as the full list', async () => {
    const many: Row[] = Array.from({ length: 60 }, (_v, i) => ({ systemuserid: g(1000 + i), fullname: `Person ${i}`, businessunitid: BU_HQ }));
    const { reader } = make({ data: { ...dataset(), systemuser: many } });
    const r = await reader.searchUsers('person');
    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.data).toHaveLength(50);
    expect(r.notes.join(' ')).toContain('first 50');
  });

  it('finds teams of every type', async () => {
    const { reader } = make();
    const r = await reader.searchTeams('re');
    expect(r.status).toBe('ok');
    if (r.status === 'error') return;
    expect(r.data.map((t) => [t.name, t.type, t.businessUnitName])).toEqual([['Reviewers', 'Access', 'Contoso']]);
    const all = await reader.searchTeams('o');
    expect(all.status).toBe('ok'); // one letter: not searched
    const del = await reader.searchTeams('contoso');
    expect(del.status === 'ok' && del.data[0]).toMatchObject({ type: 'Default' });
  });
});

describe('loadUserAccess', () => {
  it('separates direct and team-derived roles with their origin, ignores access-team roles and resolves business units', async () => {
    const { reader, fake } = make();
    const r = await reader.loadUserAccess(U_ANN);
    expect(r.status).toBe('partial'); // the access team's reported role is flagged, see the next test
    if (r.status === 'error') return;
    const a = r.data;
    expect(a.businessUnitName).toBe('Contoso');
    expect(a.directRoles.map((x) => [x.role.name, x.roleBusinessUnitName])).toEqual([['Project Contributor', 'North'], ['System Administrator', 'Contoso']]);
    expect(a.teamRoles.map((x) => [x.role.name, x.team?.name, x.team?.type])).toEqual([['Basic User', 'Contoso', 'Default'], ['Project Contributor', 'Project Delivery', 'Owner']]);
    expect(fake.mutatorCalls()).toEqual([]);
  });

  it('flags a role reported on an access team as a warning (partial), without counting it', async () => {
    const { reader } = make();
    const r = await reader.loadUserAccess(U_ANN);
    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.notes.join(' ')).toContain('Access team Reviewers reports roles');
    expect(r.data.teamRoles.some((x) => x.team?.type === 'Access')).toBe(false);
  });

  it('is complete for a user without anomalies and accepts the lookup column in either spelling', async () => {
    const { reader } = make();
    const r = await reader.loadUserAccess(U_BEN);
    expect(r.status).toBe('ok');
    if (r.status === 'error') return;
    expect(r.data.user).toMatchObject({ isDisabled: true });
    expect(r.data.businessUnitName).toBe('North');
    expect(r.data.directRoles.map((x) => x.role.name)).toEqual(['Basic User']);
    expect(r.data.teamRoles.map((x) => x.origin)).toEqual(['team']);
  });

  it('walks several pages of assignments', async () => {
    const roles: Row[] = Array.from({ length: 7 }, (_v, i) => ({ roleid: g(2000 + i), name: `Role ${i}`, businessunitid: BU_HQ }));
    const d = { ...dataset(), role: roles, systemuserroles: roles.map((r) => ({ systemuserid: U_BEN, roleid: r['roleid'] })), teammembership: [] };
    const { reader, fetches } = make({ data: d, pageSize: 3 });
    const r = await reader.loadUserAccess(U_BEN);
    expect(r.status).toBe('ok');
    if (r.status === 'error') return;
    expect(r.data.directRoles).toHaveLength(7);
    expect(fetches.filter((f) => f.includes('name="systemuserroles"'))).toHaveLength(3);
  });

  it('shows missing team roles as incomplete data, never as an empty (no access) result', async () => {
    const { reader } = make({ failEntity: { entity: 'teamroles', error: new Error('Access is denied') } });
    const r = await reader.loadUserAccess(U_BEN);
    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.data.isComplete).toBe(false);
    expect(r.notes.join(' ')).toContain('team roles could not be read');
  });

  it('shows failed direct assignments as incomplete data', async () => {
    const { reader } = make({ failEntity: { entity: 'systemuserroles', error: new Error('Access is denied') } });
    const r = await reader.loadUserAccess(U_ANN);
    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.data.directRoles).toEqual([]);
    expect(r.notes.join(' ')).toContain('direct role assignments could not be read');
  });

  it('reports an unresolvable team and unknown business unit as gaps', async () => {
    const d = dataset();
    d['team'] = (d['team'] ?? []).filter((t) => t['teamid'] !== T_DEF);
    d['businessunit'] = (d['businessunit'] ?? []).filter((b) => b['businessunitid'] !== BU_N);
    const { reader } = make({ data: d });
    const r = await reader.loadUserAccess(U_BEN);
    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.notes.join(' ')).toMatch(/not in the team list/);
    expect(r.notes.join(' ')).toMatch(/business unit could not be resolved/);
    expect(r.data.businessUnitName).toBe('an unknown business unit');
  });

  it('is an error when the user cannot be read or does not exist', async () => {
    expect(await make({ failEntity: { entity: 'systemuser', error: { status: 403, message: 'denied' } } }).reader.loadUserAccess(U_ANN)).toMatchObject({ status: 'error', errorClass: 'permission' });
    expect(await make().reader.loadUserAccess(g(777))).toMatchObject({ status: 'error', errorClass: 'notFound' });
  });

  it('rejects an invalid id without any host read', async () => {
    const { reader, fetches } = make();
    expect(await reader.loadUserAccess('x" or 1=1')).toMatchObject({ status: 'error', errorClass: 'notFound' });
    expect(await reader.loadTeamAccess('nope')).toMatchObject({ status: 'error', errorClass: 'notFound' });
    expect(fetches).toEqual([]);
  });

  it('retries a throttled read and still returns the answer', async () => {
    const { reader, fetches } = make({ failEntity: { entity: 'team', error: { status: 429, message: 'Too many requests', retryAfter: 1 }, times: 2 } });
    const r = await reader.loadUserAccess(U_BEN);
    expect(r.status).toBe('ok');
    const q = (f: string) => !f.includes('intersect="true"'); // the team-roles read also starts at team
    expect(fetches.filter((f) => f.includes('name="team"') && q(f))).toHaveLength(3);
  });

  it('chunks long id lists so no query carries more than 50 ids', async () => {
    const teams: Row[] = Array.from({ length: 120 }, (_v, i) => ({ teamid: g(3000 + i), name: `T${i}`, teamtype: 0, isdefault: false, businessunitid: BU_HQ }));
    const d = { ...dataset(), team: teams, teammembership: teams.map((t) => ({ teamid: t['teamid'], systemuserid: U_BEN })), teamroles: [] };
    const { reader, fetches } = make({ data: d });
    const r = await reader.loadUserAccess(U_BEN);
    expect(r.status).toBe('ok');
    if (r.status === 'error') return;
    const teamQueries = fetches.filter((f) => f.includes('<entity name="team"') && !f.includes('intersect="true"'));
    expect(teamQueries).toHaveLength(3);
    for (const q of teamQueries) expect((q.match(/<value>/g) ?? []).length).toBeLessThanOrEqual(50);
  });
});

describe('loadTeamAccess', () => {
  it('lists the roles and members of an owner team and opens no mutation', async () => {
    const { reader, fake } = make();
    const r = await reader.loadTeamAccess(T_DEF);
    expect(r.status).toBe('ok');
    if (r.status === 'error') return;
    expect(r.data.team).toMatchObject({ name: 'Contoso', type: 'Default', businessUnitName: 'Contoso' });
    expect(r.data.roles.map((x) => x.role.name)).toEqual(['Basic User']);
    expect(r.data.members.map((m) => m.user.fullName)).toEqual(['Ann Admin', 'Ben Brooks', 'Svc Integration']);
    expect(fake.mutatorCalls()).toEqual([]);
  });

  it('access teams carry no roles and no roles are read for them', async () => {
    const { reader, fetches } = make();
    const r = await reader.loadTeamAccess(T_ACC);
    expect(r.status).toBe('ok');
    if (r.status === 'error') return;
    expect(r.data.roles).toEqual([]);
    expect(fetches.some((f) => f.includes('name="teamroles"'))).toBe(false);
  });

  it('caps the member list and says so', async () => {
    const members = Array.from({ length: 130 }, (_v, i) => g(4000 + i));
    const users: Row[] = members.map((m, i) => ({ systemuserid: m, fullname: `M${String(i).padStart(3, '0')}`, businessunitid: BU_HQ }));
    const d = { ...dataset(), systemuser: users, teammembership: members.map((m) => ({ teamid: T_OWN, systemuserid: m })) };
    const { reader } = make({ data: d });
    const r = await reader.loadTeamAccess(T_OWN);
    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.data.members).toHaveLength(100);
    expect(r.data.membersTruncated).toBe(true);
  });

  it('shows failed members as incomplete', async () => {
    const { reader } = make({ failEntity: { entity: 'teammembership', error: new Error('Access is denied') } });
    const r = await reader.loadTeamAccess(T_OWN);
    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.notes.join(' ')).toContain('Team members could not be read');
  });
});

describe('listRolesOfBusinessUnit', () => {
  it('reads only the roles of that business unit, read-only, and refuses an invalid id', async () => {
    const { reader, fake, fetches } = make();
    const r = await reader.listRolesOfBusinessUnit(BU_HQ);
    expect(r.status).toBe('ok');
    if (r.status === 'error') return;
    expect(r.data.map((x) => x.name)).toEqual(['System Administrator', 'Basic User']);
    expect(r.data.every((x) => x.businessUnitId === BU_HQ)).toBe(true);
    expect(fetches.some((f) => f.includes('<entity name="role">') && f.includes(`value="${BU_HQ}"`))).toBe(true);
    expect(fake.mutatorCalls()).toEqual([]);
    const bad = await reader.listRolesOfBusinessUnit('not-a-guid');
    expect(bad).toMatchObject({ status: 'error', errorClass: 'notFound' });
  });

  it('reports a read failure as an error, never as an empty list', async () => {
    const { reader } = make({ failEntity: { entity: 'role', error: Object.assign(new Error('x'), { status: 403 }) } });
    const r = await reader.listRolesOfBusinessUnit(BU_HQ);
    expect(r.status).toBe('error');
  });
});

describe('resolveNames (display names for a restore preview)', () => {
  it('reads the names of users and roles by id, and an id that does not exist is simply absent', async () => {
    const { reader, fake } = make();
    const r = await reader.resolveNames({ users: [U_ANN, U_BEN.toUpperCase(), g(404)], roles: [R_ADMIN, R_CONTRIB, g(405)] });
    if (r.status === 'error') throw new Error(r.message);
    expect(r.status).toBe('ok');
    expect([...r.data.users]).toEqual([[U_ANN, 'Ann Admin'], [U_BEN, 'Ben Brooks']]);
    expect([...r.data.roles]).toEqual([[R_ADMIN, 'System Administrator'], [R_CONTRIB, 'Project Contributor']]);
    expect(fake.mutatorCalls()).toEqual([]); // reads only
  });

  it('ignores anything that is not a GUID, reads nothing for an empty request, and refuses a wrong environment like every read', async () => {
    const ok = make();
    const none = await ok.reader.resolveNames({ users: ['not-a-guid'], roles: [] });
    expect(none).toMatchObject({ status: 'ok' });
    expect(ok.fetches).toEqual([]);
    const wrong = make({ urls: ['https://contoso-prod.crm4.dynamics.com'] });
    expect(await wrong.reader.resolveNames({ users: [U_ANN] })).toMatchObject({ status: 'error', errorClass: 'permission' });
    expect(wrong.fetches).toEqual([]);
  });
});

describe('identity and connection guard', () => {
  it('refuses a wrong environment and reads nothing', async () => {
    const { reader, fetches, fake } = make({ urls: ['https://contoso-prod.crm4.dynamics.com'] });
    for (const r of [await reader.searchUsers('ann'), await reader.searchTeams('ann'), await reader.loadUserAccess(U_ANN), await reader.loadTeamAccess(T_DEF)]) {
      expect(r).toMatchObject({ status: 'error', errorClass: 'permission' });
    }
    expect(fetches).toEqual([]);
    expect(fake.count('queryData')).toBe(0);
  });

  it('aborts, with no partial result, when the connection changes mid read', async () => {
    const inner = make();
    const urls = { current: APPROVED.url };
    const conns = {
      getActiveConnection: async () => ({ url: urls.current }),
      getConnections: async () => [{ url: urls.current }],
    };
    const original = inner.fake.api.fetchXmlQuery;
    inner.fake.api.fetchXmlQuery = async (x: string, ...rest: unknown[]) => {
      const out = await (original as (x: string, ...r: unknown[]) => Promise<{ value: Row[] }>)(x, ...rest);
      if (x.includes('name="systemuserroles"')) urls.current = 'https://contoso-prod.crm4.dynamics.com';
      return out;
    };
    const reader = new PptbAccessReader(createReadOnlyHost(inner.fake.api), conns, { retry: fast, newCorrelationId: () => 'cid-1', expected: APPROVED_DEVELOPER_ENVIRONMENT });
    const r = await reader.loadUserAccess(U_ANN);
    expect(r.status).toBe('error');
  });

  it('the factory without a host Dataverse API reports an error and calls nothing', async () => {
    const reader = createPptbAccessReader(undefined);
    expect(await reader.searchUsers('ann')).toMatchObject({ status: 'error' });
    expect(await reader.loadUserAccess(U_ANN)).toMatchObject({ status: 'error' });
  });
});

describe('intersect tables are read through a parent link (the real host answers 404 for a root intersect fetch)', () => {
  it('never roots a fetch at systemuserroles, teamroles or teammembership and still reads roles, memberships and members', async () => {
    const { reader, fetches } = make();
    const access = await reader.loadUserAccess(U_ANN);
    expect(access.status).not.toBe('error');
    if (access.status === 'error') return;
    expect(access.data.directRoles.length).toBeGreaterThan(0);
    const team = await reader.loadTeamAccess(T_OWN);
    expect(team.status).not.toBe('error');
    for (const f of fetches) expect(/<entity name="(systemuserroles|teamroles|teammembership)"/.test(f)).toBe(false);
    for (const name of ['systemuserroles', 'teamroles', 'teammembership']) {
      expect(fetches.some((f) => new RegExp(`<link-entity name="${name}"[^>]*intersect="true"`).test(f))).toBe(true);
    }
  });
});
