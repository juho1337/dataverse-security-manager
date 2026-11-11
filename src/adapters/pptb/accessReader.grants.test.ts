import { describe, expect, it } from 'vitest';
import { APPROVED, connections, createFakeDataverse } from '../../test/fakeDataverse';
import { FixtureAccessReader } from '../fixture/accessFixture';
import { loadTeamTablePrivileges, loadUserTablePrivileges } from '../../application/access/tablePrivileges';
import { PptbAccessReader } from './accessReader';
import { createReadOnlyHost } from './readOnlyHost';

const g = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const ROOT = g(1);
const COPY = g(2); // a Business Unit copy of ROOT: stores no grants
const OWN = g(3); // a custom role with its own grants
const P_READ = g(11);
const P_WRITE = g(12);
const P_PROJ_READ = g(13);
const P_MISC = g(14);
const fast = { baseDelayMs: 0, maxDelayMs: 0, sleep: async () => undefined, random: () => 0 };

const P_ACTIVITY = g(15); // one privilege that belongs to several tables (activity tables share the activitypointer privileges)

function make(options: { failGrants?: boolean; failMetadata?: boolean; failCatalog?: boolean; sharedPrivilege?: boolean; unattributable?: 'privilege' | 'role'; blankDepth?: string; badCatalogRow?: 'right' | 'privilege' | 'table' } = {}) {
  const fake = createFakeDataverse();
  const fetches: string[] = [];
  fake.api.fetchXmlQuery = async (fetchXml: string) => {
    fetches.push(fetchXml);
    const root = /<entity name="(\w+)"/.exec(fetchXml)?.[1];
    if (root === 'roleprivileges') throw Object.assign(new Error("Resource not found for the segment 'roleprivileges'."), { status: 404 }); // like the real host
    if (root === 'privilege') {
      if (options.failCatalog) throw new Error('Access is denied');
      return {
        value: [
          { privilegeid: P_READ, accessright: 1, 'ptc.objecttypecode': 'account' },
          { privilegeid: P_WRITE, accessright: 2, 'ptc.objecttypecode': 'account' },
          { privilegeid: P_PROJ_READ, accessright: 1, 'ptc.objecttypecode': 'contoso_project' },
          { privilegeid: P_MISC, accessright: 1, 'ptc.objecttypecode': 'none' },
          ...(options.sharedPrivilege
            ? [
                { privilegeid: P_ACTIVITY, accessright: 1, 'ptc.objecttypecode': 'email' },
                { privilegeid: P_ACTIVITY, accessright: 1, 'ptc.objecttypecode': 'task' },
              ]
            : []),
          // an unreadable catalog row: it could be any table's privilege, so the catalog cannot be called complete
          ...(options.badCatalogRow === 'right' ? [{ privilegeid: g(16), accessright: 'x', 'ptc.objecttypecode': 'account' }] : []),
          ...(options.badCatalogRow === 'privilege' ? [{ accessright: 2, 'ptc.objecttypecode': 'account' }] : []),
          ...(options.badCatalogRow === 'table' ? [{ privilegeid: g(16), accessright: 2 }] : []),
        ],
      };
    }
    if (root === 'role' && fetchXml.includes('alias="rp"')) {
      if (options.failGrants) throw new Error('Access is denied');
      const asked = [...fetchXml.matchAll(/<value>([^<]+)<\/value>/g)].map((m) => (m[1] ?? '').toLowerCase());
      const rows = [
        { roleid: ROOT, 'rp.privilegeid': P_READ, 'rp.privilegedepthmask': 8 },
        { roleid: ROOT, 'rp.privilegeid': P_WRITE, 'rp.privilegedepthmask': 2 },
        { roleid: ROOT, 'rp.privilegeid': P_MISC, 'rp.privilegedepthmask': 8 },
        { roleid: OWN, 'rp.privilegeid': P_PROJ_READ, 'rp.privilegedepthmask': 4 },
        { roleid: OWN, 'rp.privilegeid': P_READ, 'rp.privilegedepthmask': 1 },
        ...(options.sharedPrivilege ? [{ roleid: OWN, 'rp.privilegeid': P_ACTIVITY, 'rp.privilegedepthmask': 4 }] : []),
      ].filter((r) => asked.includes(r.roleid));
      // A returned grant row whose role or privilege id is missing cannot be attributed to anything.
      if (options.unattributable === 'privilege') rows.push({ roleid: OWN, 'rp.privilegedepthmask': 2 } as never);
      if (options.unattributable === 'role') rows.push({ 'rp.privilegeid': P_WRITE, 'rp.privilegedepthmask': 2 } as never);
      // a grant whose depth is blank must not be read as depth 0 ("None")
      if (options.blankDepth !== undefined) rows.push({ roleid: OWN, 'rp.privilegeid': P_WRITE, 'rp.privilegedepthmask': options.blankDepth } as never);
      return { value: rows };
    }
    return { value: [] };
  };
  fake.api.getAllEntitiesMetadata = async () => {
    if (options.failMetadata) throw new Error('Failed to fetch');
    return { value: [{ LogicalName: 'account', DisplayName: { UserLocalizedLabel: { Label: 'Asiakas' } } }, { LogicalName: 'contoso_project', DisplayName: { UserLocalizedLabel: { Label: 'Contoso Project' } } }] };
  };
  const reader = new PptbAccessReader(createReadOnlyHost(fake.api), connections([APPROVED.url]), { retry: fast });
  return { reader, fetches };
}

describe('PptbAccessReader.loadRoleGrants (synthetic host that answers like the real one)', () => {
  it('reads grants FROM the role (never rooted at the intersect table) and gives a Business Unit copy its root’s grants', async () => {
    const { reader, fetches } = make();
    const r = await reader.loadRoleGrants!([{ id: COPY, rootId: ROOT }, { id: OWN, rootId: null }]);
    expect(r.status).toBe('ok');
    if (r.status === 'error') return;
    const of = (id: string) => r.data.grants.filter((x) => x.roleId === id).map((x) => `${x.table}:${x.operation}:${x.depth}`).sort();
    expect(of(COPY)).toEqual(['account:Read:Global', 'account:Write:Local']); // the root's, under the copy's id (the miscellaneous privilege is not a table grant)
    expect(of(OWN)).toEqual(['account:Read:Basic', 'contoso_project:Read:Deep']); // its own grants, not the root's
    expect(fetches.some((f) => /<entity name="roleprivileges"/.test(f))).toBe(false);
    expect(r.data.complete).toBe(true);
    expect(r.data.catalog.get('account')).toEqual(new Set(['Read', 'Write']));
    expect(r.data.catalog.has('none')).toBe(false);
    expect(r.data.tableNames.get('account')).toBe('Asiakas');
  });

  it('gives a grant to every table that shares the privilege id (activity tables), not only the last one in the catalog', async () => {
    const { reader } = make({ sharedPrivilege: true });
    const r = await reader.loadRoleGrants!([{ id: OWN, rootId: null }]);
    expect(r.status).toBe('ok');
    if (r.status === 'error') return;
    const of = r.data.grants.filter((x) => x.roleId === OWN).map((x) => `${x.table}:${x.operation}:${x.depth}`).sort();
    expect(of).toEqual(['account:Read:Basic', 'contoso_project:Read:Deep', 'email:Read:Deep', 'task:Read:Deep']);
    expect(r.data.catalog.get('email')).toEqual(new Set(['Read']));
    expect(r.data.catalog.get('task')).toEqual(new Set(['Read']));
  });

  it.each(['privilege', 'role'] as const)('is partial, never a definitive absence, when a grant row has no readable %s id', async (missing) => {
    const r = await make({ unattributable: missing }).reader.loadRoleGrants!([{ id: OWN, rootId: null }]);
    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.data.complete).toBe(false);
    expect(r.notes.join(' ')).toMatch(/could not be attributed/);
    // the rows that were readable are still reported
    expect(r.data.grants.filter((x) => x.roleId === OWN).map((x) => `${x.table}:${x.operation}`).sort()).toEqual(['account:Read', 'contoso_project:Read']);
  });

  it.each(['right', 'privilege', 'table'] as const)('marks the catalog incomplete and does not cache it when a catalog row has an unreadable %s', async (bad) => {
    const { reader, fetches } = make({ badCatalogRow: bad });
    const r = await reader.loadRoleGrants!([{ id: OWN, rootId: null }]);
    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.data.catalogComplete).toBe(false);
    expect(r.data.complete).toBe(false);
    expect(r.notes.join(' ')).toMatch(/privilege catalog/);
    await reader.loadRoleGrants!([{ id: OWN, rootId: null }]);
    expect(fetches.filter((f) => /<entity name="privilege"/.test(f)).length).toBeGreaterThan(1); // read again, not served from the cache
  });

  it.each(['', '   '])('is partial, never "None", when a grant depth is the blank string %j', async (blank) => {
    const r = await make({ blankDepth: blank }).reader.loadRoleGrants!([{ id: OWN, rootId: null }]);
    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.data.complete).toBe(false);
    expect(r.notes.join(' ')).toMatch(/depth value/);
    expect(r.data.grants.some((x) => x.roleId === OWN && x.operation === 'Write')).toBe(false); // no invented "None" grant
  });

  it('is partial, never "no grants", when the grants cannot be read; and says so when only the display names fail', async () => {
    const denied = await make({ failGrants: true }).reader.loadRoleGrants!([{ id: ROOT, rootId: null }]);
    expect(denied.status).toBe('partial');
    if (denied.status === 'partial') {
      expect(denied.data.complete).toBe(false);
      expect(denied.notes.join(' ')).toMatch(/could not be read/);
    }
    const names = await make({ failMetadata: true }).reader.loadRoleGrants!([{ id: ROOT, rootId: null }]);
    expect(names.status).toBe('partial');
    if (names.status === 'partial') {
      expect(names.data.complete).toBe(false);
      expect(names.notes.join(' ')).toMatch(/display names/);
    }
  });

  it('marks the catalog incomplete when it could not be read, so no operation is called "not applicable" from it', async () => {
    const r = await make({ failCatalog: true }).reader.loadRoleGrants!([{ id: ROOT, rootId: null }]);
    expect(r.status).toBe('partial');
    if (r.status === 'error') return;
    expect(r.data.catalogComplete).toBe(false);
    expect(r.data.complete).toBe(false);
    const ok = await make().reader.loadRoleGrants!([{ id: ROOT, rootId: null }]);
    if (ok.status !== 'error') expect(ok.data.catalogComplete).toBe(true);
  });

  it('rejects ids that are not GUIDs instead of building a query from them', async () => {
    const { reader, fetches } = make();
    const r = await reader.loadRoleGrants!([{ id: "x'/><bad", rootId: null }]);
    expect(r.status).not.toBe('error');
    expect(fetches.filter((f) => f.includes('bad'))).toEqual([]);
  });
});

describe('table privileges of a team whose roles were read only in part', () => {
  it('carries the role gap into the analysis: partial, with a note, and the cells it cannot know are unknown', async () => {
    const reader = new FixtureAccessReader();
    const t = await reader.loadTeamAccess('t-default-hq');
    if (t.status === 'error') throw new Error('fixture');
    const gap = { ...t.data, rolesComplete: false, roleGaps: ['The roles of the team could not be read.'] };
    const r = await loadTeamTablePrivileges(reader, gap);
    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.notes.join(' ')).toMatch(/could not be read/);
    expect(r.data.tables.find((x) => x.logicalName === 'account')!.operations.Write.cell).toEqual({ kind: 'unknown' }); // never "no grant"
    // a team whose members were merely truncated is still complete for its roles
    const truncatedOnly = await loadTeamTablePrivileges(reader, { ...t.data, membersTruncated: true });
    expect(truncatedOnly.status).toBe('ok');
  });
});

describe('table privileges of a user and of a team (application layer)', () => {
  it('derives per-table privileges from the demo roles with the source of each grant', async () => {
    const reader = new FixtureAccessReader();
    const access = await reader.loadUserAccess('u-ann');
    expect(access.status).not.toBe('error');
    if (access.status === 'error') return;
    const r = await loadUserTablePrivileges(reader, access.data);
    expect(r.status).not.toBe('error');
    if (r.status === 'error') return;
    const account = r.data.tables.find((t) => t.logicalName === 'account')!;
    expect(account.displayName).toBe('Account');
    expect(account.operations.Read.cell).toEqual({ kind: 'depth', depth: 'Global' });
    expect(account.operations.Read.contributors[0]!.roleName).toBe('System Administrator');
    expect(account.operations.Read.contributors.length).toBeGreaterThan(1);
  });

  it('says so when the user’s roles were read only in part, and has no analysis without a grants reader', async () => {
    const reader = new FixtureAccessReader();
    const access = await reader.loadUserAccess('u-pat'); // team membership cannot be resolved
    if (access.status === 'error') throw new Error('fixture');
    const r = await loadUserTablePrivileges(reader, access.data);
    expect(r.status).toBe('partial');
    if (r.status === 'partial') expect(r.notes.join(' ')).toMatch(/not read completely/);
    const plain = { ...reader, loadRoleGrants: undefined } as unknown as FixtureAccessReader;
    expect((await loadUserTablePrivileges(plain, access.data)).status).toBe('error');
  });

  it('a team shows the privileges of its own roles only', async () => {
    const reader = new FixtureAccessReader();
    const t = await reader.loadTeamAccess('t-default-hq');
    if (t.status === 'error') throw new Error('fixture');
    const r = await loadTeamTablePrivileges(reader, t.data);
    expect(r.status).toBe('ok');
    if (r.status === 'error') return;
    expect(r.data.subject).toBe('team');
    expect(r.data.roles.map((x) => x.roleName)).toEqual(['Basic User']);
    expect(r.data.tables.find((x) => x.logicalName === 'account')!.operations.Read.cell).toEqual({ kind: 'depth', depth: 'Basic' });
  });
});
