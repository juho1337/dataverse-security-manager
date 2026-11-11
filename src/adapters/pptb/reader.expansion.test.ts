import { describe, expect, it } from 'vitest';
import { countAssignments } from '../../domain/access';
import { APPROVED, createFakeDataverse, SYNTHETIC_PRIVILEGES, SYNTHETIC_TABLES } from '../../test/fakeDataverse';
import { COPY, makeExpansionReader as make, roles, grants, ROOT, rootOf, T1, userRoles, type Opts } from '../../test/expansionHost';
import { PptbSecurityDataReader, familyRolesFetch, roleLineageFetch, roleTeamsFetch, roleUsersFetch, teamMembersFetch } from './reader';
import { createReadOnlyHost } from './readOnlyHost';

const fast = { sleep: async () => undefined, random: () => 1 };

describe('loadRoleDetails: the family of a logical role', () => {
  it('reads the root and its Business Unit copies, their cells, direct users and role-bearing teams with members', async () => {
    const { reader } = make();
    const r = await reader.loadRoleDetails('contoso_project', ROOT);
    expect(r.status).toBe('ok');
    if (r.status === 'error') return;
    expect(r.data.rootRoleId).toBe(ROOT);
    expect(r.data.name).toBe('Lineage Role');
    expect(r.data.instances.map((i) => i.roleId)).toEqual([ROOT, COPY]);
    expect(r.data.instances.map((i) => i.businessUnitName)).toEqual(['Contoso', 'North']);
    // each instance has its own cells (the copy was changed to Business Unit depth), and the unrelated role is not in the family
    expect(r.data.instances[0]?.cells.Read).toEqual({ kind: 'depth', depth: 'Global' });
    expect(r.data.instances[1]?.cells.Read).toEqual({ kind: 'depth', depth: 'Local' });
    const [root, copy] = r.data.instances;
    expect(root?.directUsers.map((p) => [p.name, p.status])).toEqual([['Ada Enabled', 'Enabled'], ['Dan Disabled', 'Disabled']]);
    expect(copy?.directUsers.map((p) => [p.name, p.status])).toEqual([['Svc App', 'ApplicationUser']]);
    expect(root?.teams.map((t) => [t.name, t.teamType, t.members.map((m) => m.name)])).toEqual([['Contoso Team', 'Owner', ['Ada Enabled', 'Mia Member']]]);
    expect(copy?.teams).toEqual([]);
  });

  it('counts people with the domain rules: only enabled users, overlap between direct and team routes, paths counted separately', async () => {
    const { reader } = make();
    const r = await reader.loadRoleDetails('contoso_project', ROOT);
    if (r.status === 'error') throw new Error('unexpected');
    const counts = countAssignments(r.data.instances);
    expect(counts.directUsers).toBe(1); // Ada (Dan is disabled, the app user is an application user)
    expect(counts.usersViaTeams).toBe(2); // Ada and Mia
    expect(counts.uniqueUsers).toBe(2); // Ada is both direct and via the team
    expect(counts.usersWithSeveralPaths).toBe(1);
    expect(counts.excludedDisabled).toBe(1);
    expect(counts.excludedApplication).toBe(1);
    expect(counts.paths).toBe(5); // Ada direct, Dan direct, Svc App direct, Ada via team, Mia via team
  });

  it('is `ok` only when every section was read completely', async () => {
    const { reader } = make();
    expect((await reader.loadRoleDetails('contoso_project', ROOT)).status).toBe('ok');
  });

  it('an unknown role is notFound', async () => {
    const { reader } = make();
    const r = await reader.loadRoleDetails('contoso_project', 'e0000000-0000-0000-0000-0000000000ff');
    expect(r).toMatchObject({ status: 'error', errorClass: 'notFound' });
  });

  it('rejects an invalid table name or role id before any host call', async () => {
    const { fake, reader } = make();
    expect(await reader.loadRoleDetails('bad name!', ROOT)).toMatchObject({ status: 'error', errorClass: 'notFound' });
    expect(await reader.loadRoleDetails('contoso_project', 'not-a-guid')).toMatchObject({ status: 'error', errorClass: 'notFound' });
    expect(fake.calls.filter((c) => c.method === 'fetchXmlQuery')).toEqual([]);
  });

  it('pages every section (a small page size still yields every user and member)', async () => {
    const { reader } = make({ pageSize: 1 });
    const r = await reader.loadRoleDetails('contoso_project', ROOT);
    expect(r.status).toBe('ok');
    if (r.status === 'error') return;
    expect(countAssignments(r.data.instances).paths).toBe(5);
  });
});

describe('loadRoleDetails: partial results never invent numbers', () => {
  it.each([
    ['direct users', { failUsers: new Error('503 Service Unavailable') }, /direct users could not be read/],
    ['teams', { failTeams: new Error('503 Service Unavailable') }, /teams that hold this role could not be read/],
    ['team members', { failMembers: new Error('503 Service Unavailable') }, /team members could not be read/],
  ])('a failed read of the %s makes the result partial and says which part', async (_label, opts, note) => {
    const { reader } = make(opts as Opts);
    const r = await reader.loadRoleDetails('contoso_project', ROOT);
    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.notes.join(' ')).toMatch(note);
    expect(r.data.instances).toHaveLength(2); // the instances and their cells are still shown
  });

  it('a failed direct-user read leaves that section empty instead of showing a number', async () => {
    const { reader } = make({ failUsers: new Error('503 Service Unavailable') });
    const r = await reader.loadRoleDetails('contoso_project', ROOT);
    if (r.status === 'error') throw new Error('unexpected');
    expect(r.data.instances.every((i) => i.directUsers.length === 0)).toBe(true);
  });

  it('a permission error on the users read is a partial result, not an error', async () => {
    const { reader } = make({ failUsers: Object.assign(new Error('Access is denied'), { status: 403 }) });
    const r = await reader.loadRoleDetails('contoso_project', ROOT);
    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.notes.join(' ')).toMatch(/permission/);
  });
});

describe('loadRoleDetails: real-service read rules', () => {
  it('never roots a fetch at an intersect table (the host answers 404) and never calls a mutating method', async () => {
    const { fake, reader } = make();
    await reader.loadRoleDetails('contoso_project', ROOT);
    const fetches = fake.calls.filter((c) => c.method === 'fetchXmlQuery').map((c) => String(c.args[0]));
    for (const f of fetches) expect(rootOf(f)).not.toMatch(/^(systemuserroles|teamroles|teammembership|roleprivileges)$/);
    expect(fetches.some((f) => f.includes('<link-entity name="systemuserroles"') && f.includes('intersect="true"'))).toBe(true);
    expect(fetches.some((f) => f.includes('<link-entity name="teamroles"') && f.includes('intersect="true"'))).toBe(true);
    expect(fetches.some((f) => f.includes('<link-entity name="teammembership"') && f.includes('intersect="true"'))).toBe(true);
    expect(fake.mutatorCalls()).toEqual([]);
  });

  it('builds the family fetch from the role id with the Business Unit name as an outer link', () => {
    const f = familyRolesFetch(1, 50, ROOT);
    expect(f).toContain(`operator="eq" value="${ROOT}"`);
    expect(f).toContain('attribute="parentrootroleid"');
    expect(f).toContain('alias="bu" link-type="outer"');
  });

  it('puts the role / team filters inside the intersect link, ordered for stable paging', () => {
    expect(roleUsersFetch(1, 10, [ROOT])).toMatch(/<link-entity name="systemuserroles"[^>]*alias="sur"[^>]*intersect="true"><attribute name="roleid"\/><filter>/);
    expect(roleTeamsFetch(2, 10, [ROOT])).toContain('alias="tr"');
    expect(teamMembersFetch(1, 10, [T1])).toMatch(/alias="tm"[^>]*intersect="true"><attribute name="teamid"\/><filter>/);
  });
});

describe('loadRoleDetails: connection changes', () => {
  it('abandons the read and returns no data when the connection changes while it runs', async () => {
    const fake = createFakeDataverse({ tables: SYNTHETIC_TABLES, privileges: SYNTHETIC_PRIVILEGES, roles, grants });
    let current: { id: string; url: string } = { id: 'conn-1', url: APPROVED.url };
    const live = { getActiveConnection: async () => current, getConnections: async () => [current] };
    const api = fake.api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const original = api['fetchXmlQuery']!;
    api['fetchXmlQuery'] = async (...args: unknown[]) => {
      const fx = String(args[0]);
      if (fx.includes('alias="sur"')) {
        current = { id: 'conn-2', url: 'https://contoso-prod.crm4.dynamics.com' };
        return { value: userRoles.map((x) => ({ ...x.user, 'sur.roleid': x.roleid })) };
      }
      if (fx.includes('operator="eq"') && fx.includes('parentrootroleid')) return { value: roles };
      return original(...args);
    };
    const reader = new PptbSecurityDataReader(createReadOnlyHost(fake.api), live, { retry: fast, newCorrelationId: () => 'cid-1' });
    const r = await reader.loadRoleDetails('contoso_project', ROOT);
    expect(r.status).toBe('error');
    expect(JSON.stringify(r)).not.toContain('Ada Enabled');
  });
});

describe('loadRoleDetails: expanding a Business Unit copy', () => {
  it('a copy resolves to its root and returns the SAME family as expanding the root', async () => {
    const { reader } = make();
    const fromRoot = await reader.loadRoleDetails('contoso_project', ROOT);
    const fromCopy = await reader.loadRoleDetails('contoso_project', COPY);
    expect(fromCopy.status).toBe('ok');
    if (fromCopy.status === 'error' || fromRoot.status === 'error') throw new Error('unexpected');
    expect(fromCopy.data.rootRoleId).toBe(ROOT);
    expect(fromCopy.data.instances.map((i) => i.roleId)).toEqual([ROOT, COPY]);
    expect(fromCopy.data).toEqual(fromRoot.data);
  });

  it('a root keeps working (a role that names itself is the root)', async () => {
    const { reader } = make();
    const r = await reader.loadRoleDetails('contoso_project', ROOT);
    if (r.status === 'error') throw new Error('unexpected');
    expect(r.data.rootRoleId).toBe(ROOT);
    expect(r.data.instances).toHaveLength(2);
  });

  it('reads the lineage first, with one top-1 read of that role', async () => {
    const { fake, reader } = make();
    await reader.loadRoleDetails('contoso_project', COPY);
    const first = fake.calls.filter((c) => c.method === 'fetchXmlQuery').map((c) => String(c.args[0]))[0] as string;
    expect(first).toBe(roleLineageFetch(COPY));
    expect(first).toContain('<fetch top="1">');
  });

  it('a failed lineage read is an error with no data: the family cannot be identified, so nothing is guessed', async () => {
    const { reader } = make({ failLineage: new Error('503 Service Unavailable') });
    const r = await reader.loadRoleDetails('contoso_project', COPY);
    expect(r.status).toBe('error');
    expect(JSON.stringify(r)).not.toContain('Ada Enabled');
  });

  it('a role whose lineage cannot be read is shown alone and flagged partial, never as a complete family', async () => {
    const { reader } = make({ lineageWithoutRoot: true });
    const r = await reader.loadRoleDetails('contoso_project', COPY);
    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.notes.join(' ')).toMatch(/lineage of this role could not be read/);
    // with no root known, the given role is treated as the root: its own (non-existent) copies are not invented
    expect(r.data.rootRoleId).toBe(COPY);
  });
});
