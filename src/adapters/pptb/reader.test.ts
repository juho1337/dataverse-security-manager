import { describe, expect, it } from 'vitest';
import type { HostWindow } from './connection';
import {
  APPROVED, connections, createFakeDataverse, PRIVS, ROLE_A, ROLE_B, SYNTHETIC_GRANTS, SYNTHETIC_PRIVILEGES, SYNTHETIC_ROLES,
  SYNTHETIC_TABLES, type FakeOptions,
} from '../../test/fakeDataverse';
import { createPptbSecurityDataReader, depthFromMask, PptbSecurityDataReader } from './reader';
import { createReadOnlyHost } from './readOnlyHost';
import { APPROVED_DEVELOPER_ENVIRONMENT } from './config';
import { createPageNumberStrategy } from './paging';

const base: FakeOptions = { tables: SYNTHETIC_TABLES, privileges: SYNTHETIC_PRIVILEGES, roles: SYNTHETIC_ROLES, grants: SYNTHETIC_GRANTS };
const fast = { sleep: async () => undefined, random: () => 1 };

function make(opts: FakeOptions = base, urls: Array<string | null> = [APPROVED.url], extra: ConstructorParameters<typeof PptbSecurityDataReader>[2] = {}) {
  const fake = createFakeDataverse(opts);
  const reader = new PptbSecurityDataReader(createReadOnlyHost(fake.api), connections(urls), { retry: fast, newCorrelationId: () => 'cid-1', expected: APPROVED_DEVELOPER_ENVIRONMENT, ...extra });
  return { fake, reader };
}

describe('listTables', () => {
  it('lists public tables by display name, flags tables without privileges, and asks only for selected metadata', async () => {
    const { fake, reader } = make();
    const r = await reader.listTables();
    expect(r.status).toBe('ok');
    if (r.status === 'error') return;
    expect(r.data.map((t) => t.logicalName)).toEqual(['contoso_audit', 'contoso_other', 'contoso_project']);
    expect(r.data.find((t) => t.logicalName === 'contoso_audit')).toMatchObject({ supported: false, unsupportedReason: 'No security privileges defined for this table' });
    expect(r.data.find((t) => t.logicalName === 'contoso_project')).toMatchObject({ displayName: 'Contoso Project', supported: true });
    const meta = fake.calls.find((c) => c.method === 'getAllEntitiesMetadata');
    expect(meta?.args[0]).toEqual(['LogicalName', 'DisplayName', 'IsPrivate', 'IsIntersect']);
    expect(fake.mutatorCalls()).toEqual([]);
  });

  it('is partial, not complete, when support for security cannot be determined', async () => {
    const { reader } = make({ ...base, failFetch: { entity: 'privilege', page: 1, error: new Error('Access is denied'), times: 99 } });
    const r = await reader.listTables();
    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.notes.join(' ')).toContain('could not be determined');
    expect(r.data.every((t) => t.supported)).toBe(true);
  });
});

describe('loadRoleMatrix: privilege filter (verified on the real service: it takes the integer ObjectTypeCode)', () => {
  it('filters the privilege read by the integer ObjectTypeCode, never by the logical name', async () => {
    const { fake, reader } = make();
    const r = await reader.loadRoleMatrix('contoso_project');
    expect(r.status).toBe('ok');
    const sent = fake.calls.filter((c) => c.method === 'fetchXmlQuery').map((c) => String(c.args[0])).find((x) => x.includes('<entity name="privilege"'))!;
    expect(sent).toMatch(/attribute="objecttypecode" operator="eq" value="\d+"/);
    expect(sent).not.toContain('value="contoso_project"');
  });

  it('reads the whole catalog and filters here when the metadata gives no ObjectTypeCode', async () => {
    const { fake, reader } = make();
    const original = fake.api.getEntityMetadata!;
    fake.api.getEntityMetadata = (async (...a: Parameters<typeof original>) => { const m = await original(...a); delete (m as Record<string, unknown>)['ObjectTypeCode']; return m; }) as typeof original;
    const r = await reader.loadRoleMatrix('contoso_project');
    expect(r.status).toBe('ok');
    if (r.status === 'error') return;
    expect(r.data.roles.length).toBeGreaterThan(0);
    const sent = fake.calls.filter((c) => c.method === 'fetchXmlQuery').map((c) => String(c.args[0])).find((x) => x.includes('<entity name="privilege"'))!;
    expect(sent).not.toContain('operator="eq" value=');
  });
});

describe('loadRoleMatrix', () => {
  it('builds the eight cells per role: depth, no grant and not applicable stay distinct', async () => {
    const { reader } = make();
    const r = await reader.loadRoleMatrix('contoso_project');
    expect(r.status).toBe('ok');
    if (r.status === 'error') return;
    expect(r.data.table).toMatchObject({ logicalName: 'contoso_project', displayName: 'Contoso Project' });
    expect(r.data.roles.map((x) => x.name)).toEqual(['Project Contributor', 'Project Reader']);
    const contributor = r.data.roles.find((x) => x.roleId === ROLE_A)!;
    expect(contributor.cells).toEqual({
      Create: { kind: 'depth', depth: 'Local' },
      Read: { kind: 'depth', depth: 'Global' },
      Write: { kind: 'depth', depth: 'Deep' },
      Delete: { kind: 'noGrant' },
      Append: { kind: 'noGrant' },
      AppendTo: { kind: 'noGrant' },
      Assign: { kind: 'notApplicable' },
      Share: { kind: 'noGrant' },
    });
    const reader2 = r.data.roles.find((x) => x.roleId === ROLE_B)!;
    expect(reader2.cells.Read).toEqual({ kind: 'depth', depth: 'Basic' });
    expect(reader2.cells.Create).toEqual({ kind: 'noGrant' });
  });

  it('only reads the grants of this table privileges and never calls a mutating method', async () => {
    const { fake, reader } = make();
    await reader.loadRoleMatrix('contoso_project');
    const grantFetch = fake.calls.filter((c) => c.method === 'fetchXmlQuery').map((c) => String(c.args[0])).find((x) => x.includes('roleprivileges'))!;
    expect(grantFetch).toContain(PRIVS.read);
    expect(grantFetch).not.toContain('b0000000-0000-0000-0000-000000000001');
    expect(fake.mutatorCalls()).toEqual([]);
  });

  it('reads all pages of long lists', async () => {
    const roles = Array.from({ length: 11 }, (_, i) => ({ roleid: `d0000000-0000-0000-0000-${String(i).padStart(12, '0')}`, name: `Role ${String(i).padStart(2, '0')}` }));
    const { reader } = make({ ...base, roles }, [APPROVED.url], { paging: createPageNumberStrategy({ pageSize: 4 }) });
    const r = await reader.loadRoleMatrix('contoso_project');
    expect(r.status).toBe('ok');
    if (r.status === 'error') return;
    expect(r.data.roles).toHaveLength(11);
  });

  it('marks cells unknown (never none) and returns partial when a later grants page fails', async () => {
    const grants = [
      ...SYNTHETIC_GRANTS,
      ...Array.from({ length: 4 }, (_, i) => ({ roleid: ROLE_B, privilegeid: PRIVS.share, privilegedepthmask: i === 0 ? 1 : 1 })),
    ];
    const { reader } = make(
      { ...base, grants, failFetch: { entity: 'roleprivileges', page: 2, error: new Error('503 Service Unavailable'), times: 99 } },
      [APPROVED.url],
      { paging: createPageNumberStrategy({ pageSize: 4 }) },
    );
    const r = await reader.loadRoleMatrix('contoso_project');
    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    const contributor = r.data.roles.find((x) => x.roleId === ROLE_A)!;
    expect(contributor.cells.Read).toEqual({ kind: 'depth', depth: 'Global' }); // known stays known
    expect(contributor.cells.Delete).toEqual({ kind: 'unknown' }); // absence is unprovable now
    expect(contributor.cells.Assign).toEqual({ kind: 'notApplicable' }); // table property, not a read result
    expect(r.notes.join(' ')).toContain('shown as unknown');
    expect(r.notes.join(' ')).toContain('ref cid-1');
  });

  it('shows every cell as unknown when the grants cannot be read at all', async () => {
    const { reader } = make({ ...base, failFetch: { entity: 'roleprivileges', page: 1, error: new Error('Access is denied'), times: 99 } });
    const r = await reader.loadRoleMatrix('contoso_project');
    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    for (const role of r.data.roles) expect(role.cells.Read).toEqual({ kind: 'unknown' });
  });

  it('treats an unrecognized depth mask as unknown and says so', async () => {
    const grants = [{ roleid: ROLE_A, privilegeid: PRIVS.read, privilegedepthmask: 3 }];
    const { reader } = make({ ...base, grants });
    const r = await reader.loadRoleMatrix('contoso_project');
    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.data.roles.find((x) => x.roleId === ROLE_A)!.cells.Read).toEqual({ kind: 'unknown' });
    expect(r.notes.join(' ')).toContain('unrecognized depth');
  });

  describe('grant rows with an unreadable depth mask (Codex P2 on 4b08424)', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['omitted', {}],
      ['null', { privilegedepthmask: null }],
      ['undefined', { privilegedepthmask: undefined }],
      ['non-numeric string', { privilegedepthmask: 'abc' }],
      ['numeric string', { privilegedepthmask: '8' }],
      ['float', { privilegedepthmask: 1.5 }],
      ['NaN', { privilegedepthmask: Number.NaN }],
      ['negative', { privilegedepthmask: -1 }],
      ['unknown bit', { privilegedepthmask: 16 }],
    ];

    it.each(cases)('keeps the grant as Unknown (never NoGrant) when the mask is %s, with paging complete', async (_name, maskPart) => {
      const grants = [{ roleid: ROLE_A, privilegeid: PRIVS.read, ...maskPart }];
      const { reader } = make({ ...base, grants });
      const r = await reader.loadRoleMatrix('contoso_project');
      expect(r.status).toBe('partial');
      if (r.status !== 'partial') return;
      const contributor = r.data.roles.find((x) => x.roleId === ROLE_A)!;
      expect(contributor.cells.Read).toEqual({ kind: 'unknown' }); // a grant exists, its depth is unreadable
      expect(contributor.cells.Create).toEqual({ kind: 'noGrant' }); // other cells are still provably absent
      expect(r.data.roles.find((x) => x.roleId === ROLE_B)!.cells.Read).toEqual({ kind: 'noGrant' });
      expect(r.notes.join(' ')).toContain('unrecognized depth');
    });

    it('still reads a valid integer mask as a depth', async () => {
      const { reader } = make({ ...base, grants: [{ roleid: ROLE_A, privilegeid: PRIVS.read, privilegedepthmask: 8 }] });
      const r = await reader.loadRoleMatrix('contoso_project');
      expect(r.status).toBe('ok');
      expect(r.status === 'ok' && r.data.roles.find((x) => x.roleId === ROLE_A)!.cells.Read).toEqual({ kind: 'depth', depth: 'Global' });
    });

    it('treats a grant row without role or privilege id as making absence unprovable', async () => {
      const grants = [{ privilegeid: PRIVS.read, privilegedepthmask: 8 }, { roleid: ROLE_B, privilegeid: PRIVS.read, privilegedepthmask: 1 }];
      const { reader } = make({ ...base, grants });
      const r = await reader.loadRoleMatrix('contoso_project');
      expect(r.status).toBe('partial');
      if (r.status !== 'partial') return;
      expect(r.data.roles.find((x) => x.roleId === ROLE_B)!.cells.Read).toEqual({ kind: 'depth', depth: 'Basic' }); // known stays known
      expect(r.data.roles.find((x) => x.roleId === ROLE_A)!.cells.Read).toEqual({ kind: 'unknown' }); // could be the unattributed grant
      expect(r.notes.join(' ')).toContain('could not be attributed');
    });
  });

  it('is partial when the host ignores paging instead of looping', async () => {
    const roles = Array.from({ length: 4 }, (_, i) => ({ roleid: `d0000000-0000-0000-0000-${String(i).padStart(12, '0')}`, name: `Role ${i}` }));
    const { reader } = make({ ...base, roles, ignorePaging: true }, [APPROVED.url], { paging: createPageNumberStrategy({ pageSize: 4 }) });
    const r = await reader.loadRoleMatrix('contoso_project');
    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.notes.join(' ')).toContain('paging is not honored');
  });

  it('retries a throttled page and still returns a complete result', async () => {
    const { fake, reader } = make({ ...base, failFetch: { entity: 'role', page: 1, error: { status: 429, message: 'Too many requests', retryAfter: 1 }, times: 2 } });
    const r = await reader.loadRoleMatrix('contoso_project');
    expect(r.status).toBe('ok');
    expect(fake.calls.filter((c) => c.method === 'fetchXmlQuery' && String(c.args[0]).includes('name="role"') && !String(c.args[0]).includes('alias="rp"'))).toHaveLength(3); // the roles read (the grants read also starts at role)
  });

  it('reports a table without privileges as notFound', async () => {
    const { reader } = make();
    const r = await reader.loadRoleMatrix('contoso_audit');
    expect(r).toMatchObject({ status: 'error', errorClass: 'notFound' });
  });

  it('rejects an invalid table name before any host call', async () => {
    const { fake, reader } = make();
    const r = await reader.loadRoleMatrix('account"/><x');
    expect(r.status).toBe('error');
    expect(fake.calls).toEqual([]);
  });
});

describe('error mapping and correlation', () => {
  it('maps a permission failure to the permission class with a correlation id', async () => {
    const { reader } = make({ ...base, failMetadata: Object.assign(new Error('Principal user is missing prvReadEntity privilege'), { status: 403 }) });
    const r = await reader.loadRoleMatrix('contoso_project');
    expect(r).toMatchObject({ status: 'error', errorClass: 'permission' });
    expect(r.status === 'error' && r.message).toContain('ref cid-1');
  });

  it('maps an expired sign-in to permission with its own wording', async () => {
    const { reader } = make({ ...base, failMetadata: Object.assign(new Error('Unauthorized'), { status: 401 }) });
    const r = await reader.loadRoleMatrix('contoso_project');
    expect(r).toMatchObject({ status: 'error', errorClass: 'permission' });
    expect(r.status === 'error' && r.message).toContain('Sign-in');
  });

  it('maps exhausted throttling to the throttled class', async () => {
    const { reader } = make({ ...base, failMetadata: { status: 429, message: 'Too many requests' } });
    expect(await reader.loadRoleMatrix('contoso_project')).toMatchObject({ status: 'error', errorClass: 'throttled' });
  });

  it('emits non-sensitive trace events carrying the correlation id', async () => {
    const events: string[] = [];
    const { reader } = make(base, [APPROVED.url], { trace: (e) => events.push(`${e.correlationId}:${e.step}`) });
    await reader.loadRoleMatrix('contoso_project');
    expect(events[0]).toBe('cid-1:loadRoleMatrix');
    expect(events.every((e) => e.startsWith('cid-1:'))).toBe(true);
  });
});

describe('identity guard in the reader', () => {
  it('refuses a wrong environment and makes no Dataverse read at all', async () => {
    const { fake, reader } = make(base, ['https://contoso-prod.crm4.dynamics.com']);
    for (const r of [await reader.listTables(), await reader.loadRoleMatrix('contoso_project')]) {
      expect(r).toMatchObject({ status: 'error', errorClass: 'permission' });
      expect(r.status === 'error' && r.message).toContain('Environment check failed');
    }
    expect(fake.calls).toEqual([]);
  });

  it('refuses when Dataverse reports another organization, before reading tables or roles', async () => {
    const { fake, reader } = make({ ...base, organization: { organizationid: '44444444-4444-4444-4444-444444444444' } });
    expect(await reader.listTables()).toMatchObject({ status: 'error' });
    expect(fake.count('getAllEntitiesMetadata')).toBe(0);
    expect(fake.count('fetchXmlQuery')).toBe(0);
  });

  it('still reads (but reports writes as not allowed) when the environment id is unverifiable', async () => {
    const { reader } = make({ ...base, organization: { environmentIdReadable: false } });
    expect((await reader.verifyIdentity()).status).toBe('environmentIdUnverifiable');
    expect((await reader.loadRoleMatrix('contoso_project')).status).toBe('ok');
  });

  it('re-verifies when the active connection changes mid-session', async () => {
    const fake = createFakeDataverse(base);
    let slots: Array<string | null> = [APPROVED.url];
    const live = { getActiveConnection: async () => (slots[0] ? { url: slots[0] } : null), getConnections: async () => slots.map((u) => (u ? { url: u } : null)) };
    const reader = new PptbSecurityDataReader(createReadOnlyHost(fake.api), live, { retry: fast, expected: APPROVED_DEVELOPER_ENVIRONMENT });
    expect((await reader.listTables()).status).not.toBe('error');
    slots = ['https://other.crm4.dynamics.com'];
    expect(await reader.listTables()).toMatchObject({ status: 'error', errorClass: 'permission' });
  });

  it('caches a successful verification for an unchanged connection', async () => {
    const { fake, reader } = make();
    await reader.listTables();
    await reader.loadRoleMatrix('contoso_project');
    expect(fake.count('queryData')).toBe(1);
  });
});

// ---- Codex review of 6dc45d0 (PR #244)

function liveConnections(initialUrl: string, id = 'conn-1') {
  let current: { id: string; url: string } | null = { id, url: initialUrl };
  return {
    api: { getActiveConnection: async () => current, getConnections: async () => (current ? [current] : []) },
    switchTo: (url: string, newId = 'conn-2') => {
      current = { id: newId, url };
    },
    disconnect: () => {
      current = null;
    },
  };
}

type Fake = ReturnType<typeof createFakeDataverse>;
function hookAfter(fake: Fake, method: 'getEntityMetadata' | 'fetchXmlQuery' | 'getAllEntitiesMetadata', when: (args: unknown[], n: number) => boolean, action: () => void) {
  const api = fake.api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const original = api[method]!;
  let n = 0;
  api[method] = async (...args: unknown[]) => {
    const out = await original(...args);
    n++;
    if (when(args, n)) action();
    return out;
  };
}

function makeLive(opts: FakeOptions = base, extra: ConstructorParameters<typeof PptbSecurityDataReader>[2] = {}) {
  const fake = createFakeDataverse(opts);
  const live = liveConnections(APPROVED.url);
  const reader = new PptbSecurityDataReader(createReadOnlyHost(fake.api), live.api, { retry: fast, newCorrelationId: () => 'cid-1', ...extra });
  return { fake, live, reader };
}
const PROD = 'https://contoso-prod.crm4.dynamics.com';
const roleFetches = (fake: Fake) => fake.calls.filter((c) => c.method === 'fetchXmlQuery' && String(c.args[0]).includes('name="role"')).length;

describe('connection switching during a read (P1)', () => {
  it('stops when the connection changes while metadata is pending: no later request is sent and the result is an error', async () => {
    const { fake, live, reader } = makeLive();
    hookAfter(fake, 'getEntityMetadata', () => true, () => live.switchTo(PROD));
    const r = await reader.loadRoleMatrix('contoso_project');
    expect(r).toMatchObject({ status: 'error', errorClass: 'permission' });
    expect(r.status === 'error' && r.message).toContain('connection changed');
    expect(fake.count('fetchXmlQuery')).toBe(0);
    expect(fake.mutatorCalls()).toEqual([]);
  });

  it('stops between pages and never returns the pages read so far as a partial result', async () => {
    const roles = Array.from({ length: 11 }, (_, i) => ({ roleid: `d0000000-0000-0000-0000-${String(i).padStart(12, '0')}`, name: `Role ${i}` }));
    const { fake, live, reader } = makeLive({ ...base, roles }, { paging: createPageNumberStrategy({ pageSize: 4 }) });
    hookAfter(fake, 'fetchXmlQuery', (args) => String(args[0]).includes('name="role"'), () => live.switchTo(PROD));
    const r = await reader.loadRoleMatrix('contoso_project');
    expect(r.status).toBe('error');
    expect(roleFetches(fake)).toBe(1); // page 2 was never requested
  });

  it('stops when the connection changes after a later page: earlier pages are not returned as a partial result', async () => {
    const roles = Array.from({ length: 11 }, (_, i) => ({ roleid: `d0000000-0000-0000-0000-${String(i).padStart(12, '0')}`, name: `Role ${i}` }));
    const { fake, live, reader } = makeLive({ ...base, roles }, { paging: createPageNumberStrategy({ pageSize: 4 }) });
    let rolePages = 0;
    hookAfter(fake, 'fetchXmlQuery', (args) => String(args[0]).includes('name="role"') && ++rolePages === 2, () => live.switchTo(PROD));
    const r = await reader.loadRoleMatrix('contoso_project');
    expect(r.status).toBe('error'); // not 'partial' with the 4 rows of page 1
    expect(roleFetches(fake)).toBe(2); // page 3 was never requested
  });

  it('stops between retries: a throttled page is not retried against another connection', async () => {
    const live = liveConnections(APPROVED.url);
    const fake = createFakeDataverse({ ...base, failFetch: { entity: 'role', page: 1, error: { status: 429, message: 'Too many requests', retryAfter: 1 }, times: 2 } });
    const reader = new PptbSecurityDataReader(createReadOnlyHost(fake.api), live.api, {
      retry: { sleep: async () => live.switchTo(PROD), random: () => 1 },
      newCorrelationId: () => 'cid-1',
    });
    const r = await reader.loadRoleMatrix('contoso_project');
    expect(r).toMatchObject({ status: 'error', errorClass: 'permission' });
    expect(roleFetches(fake)).toBe(1); // the retry after the backoff was blocked
  });

  it('treats a new connection id on the same URL as a change', async () => {
    const { fake, live, reader } = makeLive();
    hookAfter(fake, 'getEntityMetadata', () => true, () => live.switchTo(APPROVED.url, 'conn-9'));
    expect((await reader.loadRoleMatrix('contoso_project')).status).toBe('error');
  });

  it('stops when the connection disappears mid-read', async () => {
    const { fake, live, reader } = makeLive();
    hookAfter(fake, 'fetchXmlQuery', () => true, () => live.disconnect());
    expect((await reader.loadRoleMatrix('contoso_project')).status).toBe('error');
  });

  it('aborts listTables completely when the connection changes while the privilege catalog is read', async () => {
    const { fake, live, reader } = makeLive();
    hookAfter(fake, 'fetchXmlQuery', () => true, () => live.switchTo(PROD));
    const r = await reader.listTables();
    expect(r.status).toBe('error'); // not a partial list built from the catalog exception path
  });

  it('does not report the changed connection as a normal throttling or network problem', async () => {
    const { fake, live, reader } = makeLive();
    hookAfter(fake, 'getEntityMetadata', () => true, () => live.switchTo(PROD));
    const r = await reader.loadRoleMatrix('contoso_project');
    expect(r.status === 'error' && r.errorClass).toBe('permission');
  });
});

describe('partial privilege catalog (P2)', () => {
  const pageOfFour = { paging: createPageNumberStrategy({ pageSize: 4 }) };

  it('shows missing operation definitions as unknown, not not-applicable, after a partial catalog read', async () => {
    const { reader } = make({ ...base, failFetch: { entity: 'privilege', page: 2, error: new Error('503 Service Unavailable'), times: 99 } }, [APPROVED.url], pageOfFour);
    const r = await reader.loadRoleMatrix('contoso_project');
    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    const contributor = r.data.roles.find((x) => x.roleId === ROLE_A)!;
    expect(contributor.cells.Read).toEqual({ kind: 'depth', depth: 'Global' }); // defined on page 1
    expect(contributor.cells.Append).toEqual({ kind: 'unknown' }); // definition was on the failed page
    expect(contributor.cells.Assign).toEqual({ kind: 'unknown' }); // may or may not exist
    expect(r.notes.join(' ')).toContain('Page 2');
  });

  it('still reports not-applicable when the catalog was read completely', async () => {
    const { reader } = make();
    const r = await reader.loadRoleMatrix('contoso_project');
    expect(r.status === 'ok' && r.data.roles[0]!.cells.Assign).toEqual({ kind: 'notApplicable' });
  });

  it('does not call a table unsupported when only part of the catalog could be read', async () => {
    const { reader } = make({ ...base, failFetch: { entity: 'privilege', page: 2, error: new Error('503 Service Unavailable'), times: 99 } }, [APPROVED.url], pageOfFour);
    const r = await reader.listTables();
    expect(r.status).toBe('partial');
    if (r.status !== 'partial') return;
    expect(r.data.every((t) => t.supported)).toBe(true); // contoso_audit has no privileges, but absence is unproven
    expect(r.notes.join(' ')).toContain('could not be determined');
  });

  it('still hides unsupported tables when the catalog was read completely', async () => {
    const { reader } = make();
    const r = await reader.listTables();
    expect(r.status === 'ok' && r.data.find((t) => t.logicalName === 'contoso_audit')!.supported).toBe(false);
  });

  it('reports "could not be determined", not "no privileges", when an incomplete catalog has no definition for the table', async () => {
    const fake = createFakeDataverse(base);
    const reader = new PptbSecurityDataReader(createReadOnlyHost(fake.api), connections(), {
      retry: fast,
      paging: { readAll: async () => ({ rows: [], complete: false, pages: 1, note: 'Page 2 could not be read (network).' }) },
    });
    const r = await reader.loadRoleMatrix('contoso_project');
    expect(r).toMatchObject({ status: 'error', errorClass: 'unknown' });
    expect(r.status === 'error' && r.message).toContain('could not be determined');
  });
});

describe('createPptbSecurityDataReader factory', () => {
  it('returns an error-reporting reader when the host has no Dataverse API', async () => {
    const reader = createPptbSecurityDataReader({} as HostWindow);
    expect(await reader.listTables()).toMatchObject({ status: 'error' });
    expect(await reader.loadRoleMatrix('account')).toMatchObject({ status: 'error' });
    expect(await reader.loadRoleDetails('account', 'r1')).toMatchObject({ status: 'error' });
  });

  it('wires the read-only facade and the host connections when the API exists', async () => {
    const fake = createFakeDataverse(base);
    const host: HostWindow = { dataverseAPI: fake.api, toolboxAPI: { connections: connections() } };
    const reader = createPptbSecurityDataReader(host, { retry: fast });
    expect((await reader.listTables()).status).toBe('ok');
    expect(fake.mutatorCalls()).toEqual([]);
  });
});

describe('depthFromMask', () => {
  it('maps the Dataverse depth mask', () => {
    expect([0, 1, 2, 4, 8].map(depthFromMask)).toEqual(['None', 'Basic', 'Local', 'Deep', 'Global']);
    expect(depthFromMask(3)).toBeNull();
    expect(depthFromMask(16)).toBeNull();
  });
});

describe('permission errors carry the host reason', () => {
  it('shows what the host said, without tokens', async () => {
    const { reader } = make({ ...base, failMetadata: Object.assign(new Error('Principal user is missing prvReadEntity privilege. Bearer abc.def.ghi'), { status: 403 }) });
    const r = await reader.loadRoleMatrix('contoso_project');
    expect(r.status).toBe('error');
    if (r.status !== 'error') return;
    expect(r.errorClass).toBe('permission');
    expect(r.message).toContain('Host said: Principal user is missing prvReadEntity privilege');
    expect(r.message).not.toContain('abc.def.ghi');
  });
});

describe('role privilege grants are read from the role (the host cannot fetch from the roleprivileges intersect table)', () => {
  it('never roots a fetch at roleprivileges and still reads the grants', async () => {
    const { fake, reader } = make();
    const r = await reader.loadRoleMatrix('contoso_project');
    expect(r.status).toBe('ok');
    if (r.status === 'error') return;
    const fetches = fake.calls.filter((c) => c.method === 'fetchXmlQuery').map((c) => String(c.args[0]));
    expect(fetches.some((x) => /<entity name="roleprivileges"/.test(x))).toBe(false);
    expect(fetches.some((x) => /<entity name="role">.*<link-entity name="roleprivileges"[^>]*alias="rp"[^>]*intersect="true"/.test(x))).toBe(true);
    expect(r.data.roles.some((x) => Object.values(x.cells).some((c) => c.kind === 'depth'))).toBe(true);
  });
});

describe('role lineage as stored by Dataverse (verified on the real environment: every role names a root, a root names itself)', () => {
  it('reads a self-referencing root as a root and a copy as a copy of that root', async () => {
    const ROOT = 'e0000000-0000-0000-0000-0000000000a1';
    const COPY = 'e0000000-0000-0000-0000-0000000000a2';
    const roles = [
      { roleid: ROOT, name: 'Lineage Role', _parentrootroleid_value: ROOT },
      { roleid: COPY, name: 'Lineage Role', _parentrootroleid_value: ROOT },
    ];
    const { reader } = make({ ...base, roles });
    const r = await reader.loadRoleMatrix('contoso_project');
    expect(r.status).toBe('ok');
    if (r.status === 'error') return;
    // one row per logical role: the root (naming itself) with its copy counted, the copy is not a row of its own
    expect(r.data.roles.find((x) => x.roleId === ROOT)).toMatchObject({ parentRootRoleId: null, lineage: { instanceCount: 2 } });
    expect(r.data.roles.some((x) => x.roleId === COPY)).toBe(false);
  });

  it('a lone root (no copies anywhere) still has readable lineage, so it stays editable', async () => {
    const ROOT = 'e0000000-0000-0000-0000-0000000000b1';
    const { reader } = make({ ...base, roles: [{ roleid: ROOT, name: 'Only Root', _parentrootroleid_value: ROOT }] });
    const r = await reader.loadRoleMatrix('contoso_project');
    expect(r.status).toBe('ok');
    if (r.status === 'error') return;
    expect(r.data.roles[0]?.parentRootRoleId).toBeNull();
  });

  it('groups by lineage in the matrix but not in the expansion: copies without stored grants are counted, not called different', async () => {
    const ROOT = 'e0000000-0000-0000-0000-0000000000c1';
    const COPY_A = 'e0000000-0000-0000-0000-0000000000c2';
    const COPY_B = 'e0000000-0000-0000-0000-0000000000c3';
    const roles = [
      { roleid: ROOT, name: 'System Like Role', _parentrootroleid_value: ROOT },
      { roleid: COPY_A, name: 'System Like Role', _parentrootroleid_value: ROOT },
      { roleid: COPY_B, name: 'System Like Role', _parentrootroleid_value: ROOT },
    ];
    const grants = [{ roleid: ROOT, privilegeid: PRIVS.read, privilegedepthmask: 8 }]; // only the root stores a grant (as on the real environment)
    const { reader } = make({ ...base, roles, grants });
    const m = await reader.loadRoleMatrix('contoso_project');
    if (m.status === 'error') throw new Error('matrix failed');
    expect(m.data.roles).toHaveLength(1);
    expect(m.data.roles[0]).toMatchObject({ roleId: ROOT, lineage: { instanceCount: 3, instancesDiffer: false, copiesWithoutStoredGrants: 2, anyInstanceGrants: true } });
    // the expansion still needs the concrete instances: it asks for the family, not the grouped rows
    const d = await reader.loadRoleDetails('contoso_project', ROOT);
    expect(d.status).not.toBe('error');
  });
});
