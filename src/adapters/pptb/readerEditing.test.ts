import { describe, expect, it } from 'vitest';
import { connections, createFakeDataverse, ROLE_A, ROLE_B, SYNTHETIC_GRANTS, SYNTHETIC_PRIVILEGES, SYNTHETIC_TABLES, PRIVS, type FakeOptions } from '../../test/fakeDataverse';
import type { HostWindow } from './connection';
import { createPptbSecurityDataReader } from './reader';

const COPY = 'c0000000-0000-0000-0000-0000000000cc';

function reader(roles: FakeOptions['roles']) {
  const fake = createFakeDataverse({ tables: SYNTHETIC_TABLES, privileges: SYNTHETIC_PRIVILEGES, roles, grants: SYNTHETIC_GRANTS });
  const host: HostWindow = { toolboxAPI: { connections: connections() }, dataverseAPI: fake.api };
  return createPptbSecurityDataReader(host);
}

async function matrix(roles: FakeOptions['roles']) {
  const r = await reader(roles).loadRoleMatrix('contoso_project');
  if (r.status === 'error') throw new Error(r.message);
  return r.data;
}

describe('role rows carry what editing needs', () => {
  it('reads the managed state and the lineage, and exposes the privilege ids of the table', async () => {
    const m = await matrix([
      { roleid: ROLE_A, name: 'Project Contributor', ismanaged: false },
      { roleid: ROLE_B, name: 'Project Reader', ismanaged: true },
      { roleid: COPY, name: 'Project Contributor', ismanaged: false, _parentrootroleid_value: ROLE_A },
    ]);
    const byId = new Map(m.roles.map((r) => [r.roleId, r]));
    expect(byId.get(ROLE_A)).toMatchObject({ isManaged: false, parentRootRoleId: null, lineage: { instanceCount: 2 } });
    expect(byId.get(ROLE_B)).toMatchObject({ isManaged: true, parentRootRoleId: null, lineage: { instanceCount: 1 } });
    expect(byId.has(COPY)).toBe(false); // the copy is grouped under its root
    expect(m.privilegeCatalog).toMatchObject({ Create: PRIVS.create, Read: PRIVS.read, Write: PRIVS.write, Delete: PRIVS.delete, Share: PRIVS.share });
    expect(m.privilegeCatalog?.Assign).toBeUndefined();
  });

  it('also reads the lineage when the host returns the plain lookup name', async () => {
    const m = await matrix([
      { roleid: ROLE_A, name: 'Project Contributor', ismanaged: false },
      { roleid: COPY, name: 'Project Contributor', ismanaged: false, parentrootroleid: ROLE_A },
    ]);
    expect(m.roles.find((r) => r.roleId === ROLE_A)?.lineage?.instanceCount).toBe(2); // the plain name is read as the root of the copy
    expect(m.roles.some((r) => r.roleId === COPY)).toBe(false);
  });

  it('keeps a copy whose root is not in the data as its own row, marked rootMissing and never editable', async () => {
    const m = await matrix([{ roleid: COPY, name: 'Project Contributor', ismanaged: false, _parentrootroleid_value: ROLE_A }]);
    const row = m.roles.find((r) => r.roleId === COPY);
    expect(row).toMatchObject({ parentRootRoleId: ROLE_A, lineage: { rootMissing: true, instanceCount: 1 } });
  });

  it('does not claim a root when no row carries any lineage (null columns are omitted, so absence proves nothing)', async () => {
    const m = await matrix([{ roleid: ROLE_A, name: 'Project Contributor', ismanaged: false }, { roleid: ROLE_B, name: 'Project Reader', ismanaged: false }]);
    for (const r of m.roles) expect(r.parentRootRoleId).toBeUndefined();
  });

  it('leaves the managed state unknown when the host does not return it, never assuming unmanaged', async () => {
    const m = await matrix([{ roleid: ROLE_A, name: 'Project Contributor' }]);
    expect(m.roles[0]?.isManaged).toBeUndefined();
  });
});
