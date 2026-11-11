import { describe, expect, it } from 'vitest';
import { planBuMove } from '../../domain/buMove/planner';
import { APPROVED, connections, createFakeDataverse } from '../../test/fakeDataverse';
import { PptbBuManagerReader, createPptbBuManagerReader } from './buManagerReader';
import { intersectLink, rejectRootIntersect, shapeIntersectRow } from '../../test/intersectFake';
import { createPageNumberStrategy } from './paging';
import { createReadOnlyHost } from './readOnlyHost';

type Row = Record<string, unknown>;

const fast = { sleep: async () => undefined, random: () => 1 };
const g = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const BU_ROOT = g(901);
const BU_N = g(902);
const BU_OFF = g(903);
const U_BEN = g(1);
const U_ANN = g(2);
const R_CONTRIB_N = g(11);
const R_CONTRIB_ROOT = g(12);
const R_OTHER = g(13);
const T_DEF_ROOT = g(21);
const T_DEF_N = g(22);
const P_READ = g(31);
const P_WRITE = g(32);
const P_MISC = g(33);

function dataset(): Record<string, Row[]> {
  return {
    businessunit: [
      { businessunitid: BU_ROOT, name: 'Contoso', isdisabled: false },
      { businessunitid: BU_N, name: 'North', _parentbusinessunitid_value: BU_ROOT, isdisabled: false },
      { businessunitid: BU_OFF, name: 'Old', _parentbusinessunitid_value: BU_ROOT, isdisabled: true },
    ],
    systemuser: [
      { systemuserid: U_BEN, fullname: 'Ben Brooks', internalemailaddress: 'Ben@Example.test', _businessunitid_value: BU_N, isdisabled: false, applicationid: null },
      { systemuserid: U_ANN, fullname: 'Ann Admin', internalemailaddress: 'ann@example.test', businessunitid: BU_ROOT, isdisabled: false, applicationid: null },
    ],
    role: [
      { roleid: R_CONTRIB_N, name: 'Project Contributor', businessunitid: BU_N, parentrootroleid: R_CONTRIB_ROOT, ismanaged: false },
      { roleid: R_CONTRIB_ROOT, name: 'Project Contributor', businessunitid: BU_ROOT, ismanaged: false },
      { roleid: R_OTHER, name: 'Unrelated', businessunitid: BU_ROOT, ismanaged: false },
    ],
    systemuserroles: [{ systemuserid: U_BEN, roleid: R_CONTRIB_N }],
    teammembership: [{ systemuserid: U_BEN, teamid: T_DEF_N }],
    team: [
      { teamid: T_DEF_ROOT, name: 'Contoso', teamtype: 0, isdefault: true, businessunitid: BU_ROOT },
      { teamid: T_DEF_N, name: 'North', teamtype: 0, isdefault: true, businessunitid: BU_N },
    ],
    teamroles: [{ teamid: T_DEF_ROOT, roleid: R_OTHER }],
    privilege: [
      { privilegeid: P_READ, name: 'prvReadAccount', accessright: 1, 'ptc.objecttypecode': 'account' },
      { privilegeid: P_WRITE, name: 'prvWriteAccount', accessright: 2, 'ptc.objecttypecode': 'account' },
      { privilegeid: P_MISC, name: 'prvMisc', accessright: 1, 'ptc.objecttypecode': 'none' },
    ],
    roleprivileges: [
      { roleid: R_CONTRIB_N, privilegeid: P_READ, privilegedepthmask: 2 },
      { roleid: R_CONTRIB_N, privilegeid: P_WRITE, privilegedepthmask: 1 },
      { roleid: R_CONTRIB_N, privilegeid: P_MISC, privilegedepthmask: 8 },
      { roleid: R_CONTRIB_ROOT, privilegeid: P_READ, privilegedepthmask: 2 },
      { roleid: R_CONTRIB_ROOT, privilegeid: P_WRITE, privilegedepthmask: 1 },
      { roleid: R_CONTRIB_ROOT, privilegeid: P_MISC, privilegedepthmask: 0 },
    ],
  };
}

interface Opts {
  readonly data?: Record<string, Row[]>;
  readonly failEntity?: string;
  readonly onFetch?: (entity: string) => void;
}

function make(opts: Opts = {}) {
  const data = opts.data ?? dataset();
  const fake = createFakeDataverse();
  const fetches: string[] = [];
  fake.api.fetchXmlQuery = async (fetchXml: string) => {
    fetches.push(fetchXml);
    fake.calls.push({ method: 'fetchXmlQuery', args: [fetchXml] });
    const rootEntity = /<entity name="(\w+)"/.exec(fetchXml)?.[1] ?? '';
    // Intersect tables: a root fetch is a 404 like on the real host; reads go through a link-entity from systemuser / team.
    if (rootEntity !== 'roleprivileges') rejectRootIntersect(rootEntity);
    const link = intersectLink(fetchXml, rootEntity);
    const viaRole = rootEntity === 'role' && fetchXml.includes('alias="rp"'); // grants are read from the role through the intersect table
    const entity = link ? link.table : viaRole ? 'roleprivileges' : rootEntity;
    opts.onFetch?.(entity);
    if (opts.failEntity === entity) throw new Error('Not allowed (403)');
    const conds = [...fetchXml.matchAll(/<condition attribute="(\w+)" operator="(\w+)"(?: value="([^"]*)")?(?:\/>|>([\s\S]*?)<\/condition>)/g)];
    const test = (row: Row, c: RegExpMatchArray) => {
      const raw = row[c[1] ?? ''] ?? row[`_${c[1]}_value`];
      const v = (typeof raw === 'boolean' ? (raw ? '1' : '0') : String(raw ?? '')).toLowerCase();
      if (c[2] === 'eq') return v === (c[3] ?? '').toLowerCase();
      return [...(c[4] ?? '').matchAll(/<value>([^<]+)<\/value>/g)].some((m) => (m[1] ?? '').toLowerCase() === v);
    };
    let rows = (data[entity] ?? []).filter((r) => conds.every((c) => test(r, c)));
    if (link) rows = rows.map((r) => shapeIntersectRow(r, link));
    if (viaRole) rows = rows.map((r) => ({ roleid: r['roleid'], 'rp.privilegeid': r['privilegeid'], 'rp.privilegedepthmask': r['privilegedepthmask'] }));
    if (fetchXml.includes('alias="bu"')) {
      rows = rows.map((r) => {
        const b = (data['businessunit'] ?? []).find((x) => x['businessunitid'] === (r['businessunitid'] ?? r['_businessunitid_value']));
        return b ? { ...r, 'bu.name': b['name'] } : r;
      });
    }
    const page = Number(/page="(\d+)"/.exec(fetchXml)?.[1] ?? '1');
    const count = Number(/count="(\d+)"/.exec(fetchXml)?.[1] ?? '5000');
    return { value: rows.slice((page - 1) * count, page * count) };
  };
  const reader = new PptbBuManagerReader(createReadOnlyHost(fake.api), connections([APPROVED.url]), {
    retry: fast,
    newCorrelationId: () => 'cid-1',
    paging: createPageNumberStrategy({ pageSize: 5000 }),
  });
  return { fake, reader, fetches };
}

describe('listBusinessUnits', () => {
  it('reads every business unit with its parent and enabled state', async () => {
    const r = await make().reader.listBusinessUnits();
    expect(r.status).toBe('ok');
    if (r.status === 'error') return;
    expect(r.data.find((b) => b.id === BU_N)).toMatchObject({ name: 'North', parentId: BU_ROOT, isDisabled: false });
    expect(r.data.find((b) => b.id === BU_ROOT)?.parentId).toBeNull();
    expect(r.data.find((b) => b.id === BU_OFF)?.isDisabled).toBe(true);
  });

  it('a failed read is an error, never an empty list', async () => {
    const r = await make({ failEntity: 'businessunit' }).reader.listBusinessUnits();
    expect(r.status === 'error' || r.status === 'partial').toBe(true);
    if (r.status === 'partial') expect(r.notes.join(' ')).toContain('could not be read');
  });
});

describe('findUsersByEmail', () => {
  it('matches case-insensitively and returns the business unit name; nothing is read for an empty list', async () => {
    const { reader, fetches } = make();
    const r = await reader.findUsersByEmail(['BEN@example.test', 'nobody@example.test']);
    expect(r.status === 'ok' && r.data.map((h) => [h.user.fullName, h.businessUnitName])).toEqual([['Ben Brooks', 'North']]);
    fetches.length = 0;
    expect(await reader.findUsersByEmail([])).toEqual({ status: 'ok', data: [] });
    expect(fetches).toEqual([]);
  });
});

describe('loadPlanningData: Business Unit copies inherit the privileges of their root (real service: copies store none)', () => {
  it('gives a copy without stored grants the privileges of its root, so identical roles do not look different', async () => {
    const data = dataset();
    data['roleprivileges'] = (data['roleprivileges'] ?? []).filter((r) => r['roleid'] !== R_CONTRIB_N); // the copy stores nothing
    const r = await make({ data }).reader.loadPlanningData([U_BEN], BU_ROOT);
    expect(r.status).not.toBe('error');
    if (r.status === 'error') return;
    const copy = r.data.privileges.filter((p) => p.roleId === R_CONTRIB_N).map((p) => `${p.entity}:${p.operation}:${p.depth}`).sort();
    const root = r.data.privileges.filter((p) => p.roleId === R_CONTRIB_ROOT).map((p) => `${p.entity}:${p.operation}:${p.depth}`).sort();
    expect(copy.length).toBeGreaterThan(0);
    expect(copy).toEqual(root);
    expect(r.data.privilegesComplete).toBe(true);
  });

  it('a copy that DOES store grants keeps its own, and an unread root makes the comparison incomplete', async () => {
    const own = await make().reader.loadPlanningData([U_BEN], BU_ROOT);
    expect(own.status).not.toBe('error');
    if (own.status === 'error') return;
    expect(own.data.privileges.filter((p) => p.roleId === R_CONTRIB_N).length).toBeGreaterThan(0);
    const data = dataset();
    data['roleprivileges'] = (data['roleprivileges'] ?? []).filter((r) => r['roleid'] !== R_CONTRIB_N);
    data['role'] = (data['role'] ?? []).map((r) => (r['roleid'] === R_CONTRIB_N ? { ...r, parentrootroleid: 'ffffffff-ffff-ffff-ffff-ffffffffffff' } : r)); // a root that is not in the data
    const r = await make({ data }).reader.loadPlanningData([U_BEN], BU_ROOT);
    expect(r.status).not.toBe('error');
    if (r.status === 'error') return;
    expect(r.data.privilegesComplete).toBe(false);
  });
});

describe('loadPlanningData', () => {
  it('reads the privileges of a role chosen by hand, so a custom role with Global access is shown as escalation (not as an empty role)', async () => {
    const data = dataset();
    data['roleprivileges'] = [...(data['roleprivileges'] ?? []), { roleid: R_OTHER, privilegeid: P_READ, privilegedepthmask: 8 }, { roleid: R_OTHER, privilegeid: P_WRITE, privilegedepthmask: 8 }];
    const { reader } = make({ data });
    const request = { targetBusinessUnitId: BU_ROOT, strategy: 'custom' as const, selection: { mode: 'allDirectRoles' as const }, choices: [{ sourceRoleId: R_CONTRIB_N, chosenRoleId: R_OTHER, confirmed: false }], users: [{ userId: U_BEN, choices: [] }] };
    // Without telling the reader about the chosen role its privileges are not read (the old behaviour: it looks like a role with none).
    const before = await reader.loadPlanningData([U_BEN], BU_ROOT);
    if (before.status === 'error') throw new Error(before.message);
    expect(before.data.privileges.some((p) => p.roleId === R_OTHER)).toBe(false);
    const r = await reader.loadPlanningData([U_BEN], BU_ROOT, [R_OTHER]);
    if (r.status === 'error') throw new Error(r.message);
    expect(r.data.privileges.filter((p) => p.roleId === R_OTHER).map((p) => `${p.entity}:${p.operation}:${p.depth}`).sort()).toEqual(['account:Read:Global', 'account:Write:Global']);
    const plan = planBuMove(r.data.snapshot, r.data.privileges, request, r.data.privilegesComplete);
    const decision = plan.users[0]?.decisions[0];
    expect(JSON.stringify(decision)).toContain('"escalation":true');
    expect(JSON.stringify(decision)).not.toContain('"reducedAccess":true');
  });

  it('a chosen role that cannot be found makes the privilege data incomplete instead of looking complete', async () => {
    const { reader } = make();
    const r = await reader.loadPlanningData([U_BEN], BU_ROOT, [g(777)]);
    expect(r.status).toBe('partial');
    if (r.status === 'partial') expect(r.data.privilegesComplete).toBe(false);
  });

  it('builds the snapshot the planner needs: business units, users, assignments, default teams with roles, roles and table privileges', async () => {
    const { reader } = make();
    const r = await reader.loadPlanningData([U_BEN], BU_ROOT);
    expect(r.status).toBe('ok');
    if (r.status === 'error') return;
    const { snapshot, privileges, privilegesComplete } = r.data;
    expect(privilegesComplete).toBe(true);
    expect(snapshot.users.map((u) => u.fullName)).toEqual(['Ben Brooks']);
    expect(snapshot.directAssignments).toEqual([{ userId: U_BEN, roleId: R_CONTRIB_N }]);
    expect(snapshot.teams.map((t) => [t.name, t.type, t.roleIds.length]).sort()).toEqual([['Contoso', 'Default', 1], ['North', 'Default', 0]]);
    expect(snapshot.roles.find((x) => x.id === R_CONTRIB_N)?.parentRootRoleId).toBe(R_CONTRIB_ROOT);
    // Table privileges only (the miscellaneous one has no table), None (mask 0) is not a grant, and unrelated roles are not compared.
    expect(privileges.filter((p) => p.roleId === R_CONTRIB_N).map((p) => `${p.entity}:${p.operation}:${p.depth}`).sort()).toEqual(['account:Read:Local', 'account:Write:Basic']);
    expect(privileges.some((p) => p.roleId === R_OTHER)).toBe(false);
    // Organization settings are not read: unknown, never guessed.
    expect(snapshot.settings.doNotRemoveRolesOnChangeBusinessUnit).toBeNull();
  });

  it('feeds the planner: the root copy of the role is an identical match by lineage', async () => {
    const { reader } = make();
    const r = await reader.loadPlanningData([U_BEN], BU_ROOT);
    if (r.status === 'error') throw new Error(r.message);
    const plan = planBuMove(r.data.snapshot, r.data.privileges, { targetBusinessUnitId: BU_ROOT, strategy: 'new', selection: { mode: 'allDirectRoles' }, choices: [], users: [{ userId: U_BEN, choices: [] }] }, r.data.privilegesComplete);
    const decision = plan.users[0]?.decisions[0];
    expect(decision).toMatchObject({ outcome: 'restore' });
    expect(decision?.chosen?.role.id).toBe(R_CONTRIB_ROOT);
  });

  it('a failed privilege read makes the data partial and privileges incomplete (matches then need confirmation)', async () => {
    const r = await make({ failEntity: 'roleprivileges' }).reader.loadPlanningData([U_BEN], BU_ROOT);
    expect(r.status).toBe('partial');
    if (r.status === 'partial') expect(r.data.privilegesComplete).toBe(false);
  });

  it('fails when the target business unit does not exist, or an id is not a valid id', async () => {
    const { reader } = make();
    expect((await reader.loadPlanningData([U_BEN], g(999))).status).toBe('error');
    expect((await reader.loadPlanningData(['not-a-guid'], BU_ROOT)).status).toBe('error');
    expect((await reader.loadPlanningData([], BU_ROOT)).status).toBe('error');
  });

  it('reads again every time: nothing from an earlier plan is reused except the (complete) privilege catalog', async () => {
    const seen: string[] = [];
    const { reader } = make({ onFetch: (e) => seen.push(e) });
    await reader.loadPlanningData([U_BEN], BU_ROOT);
    const first = seen.filter((e) => e === 'systemuser').length;
    await reader.loadPlanningData([U_BEN], BU_ROOT);
    expect(seen.filter((e) => e === 'systemuser').length).toBe(first * 2);
    expect(seen.filter((e) => e === 'privilege').length).toBe(1);
  });

  it('abandons the read when the connection changes while it runs', async () => {
    let switched = false;
    const urls: Array<string | null> = [APPROVED.url];
    const { fake } = make();
    const reader = new PptbBuManagerReader(
      createReadOnlyHost(fake.api),
      { getActiveConnection: async () => ({ url: switched ? 'https://other.crm.dynamics.com' : APPROVED.url, id: 'c' }), getConnections: async () => urls.map((u) => (u ? { url: u } : null)) },
      { retry: fast, newCorrelationId: () => 'cid-1' },
    );
    const original = fake.api.fetchXmlQuery!;
    fake.api.fetchXmlQuery = async (x: string) => {
      if (x.includes('name="role"')) switched = true;
      return original(x);
    };
    const r = await reader.loadPlanningData([U_BEN], BU_ROOT);
    expect(r.status).toBe('error');
  });
});

describe('read-only', () => {
  it('never reaches a mutating host method', async () => {
    const { reader, fake } = make();
    await reader.listBusinessUnits();
    await reader.findUsersByEmail(['ann@example.test']);
    await reader.loadPlanningData([U_BEN, U_ANN], BU_N);
    expect(fake.mutatorCalls()).toEqual([]);
  });

  it('without the host Dataverse API every read is an error value, not synthetic data', async () => {
    const reader = createPptbBuManagerReader(undefined);
    for (const r of [await reader.listBusinessUnits(), await reader.findUsersByEmail(['a@example.test']), await reader.loadPlanningData([U_BEN], BU_ROOT), await reader.searchUsers('ann')]) {
      expect(r.status).toBe('error');
    }
  });
});

describe('BU Manager reads intersect tables through a parent link', () => {
  it('never roots a fetch at systemuserroles or teammembership', async () => {
    const { reader, fetches } = make();
    const r = await reader.loadPlanningData([U_BEN], BU_ROOT);
    expect(r.status).not.toBe('error');
    for (const f of fetches) expect(/<entity name="(systemuserroles|teamroles|teammembership)"/.test(f)).toBe(false);
    expect(fetches.some((f) => /<link-entity name="systemuserroles"[^>]*intersect="true"/.test(f))).toBe(true);
    expect(fetches.some((f) => /<link-entity name="teammembership"[^>]*intersect="true"/.test(f))).toBe(true);
  });
});
