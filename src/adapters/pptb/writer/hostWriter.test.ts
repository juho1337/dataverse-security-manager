import { describe, expect, it, vi } from 'vitest';
import { approvePlan, createWritePlan, plannedWrite, type ApprovedPlan, type PlannedWrite } from '../../../domain/operations';
import { APPROVED, connections, createFakeDataverse } from '../../../test/fakeDataverse';
import { APPROVED_DEVELOPER_ENVIRONMENT as LOCKED } from '../config';
import type { HostWindow } from '../connection';
import { createHostSecurityWriter } from './hostWriter';

const ROLE = '11111111-1111-1111-1111-111111111111';
const PRIV = '22222222-2222-2222-2222-222222222222';
const USER = '33333333-3333-3333-3333-333333333333';
const BU = '55555555-5555-5555-5555-555555555555';

/** A host whose mutating methods record instead of throwing (the writer is the one place allowed to reach them). */
function host(opts: { urls?: Array<string | null>; environmentIdReadable?: boolean; roleBusinessUnit?: string | null; organization?: Record<string, unknown> } = {}) {
  const fake = createFakeDataverse({ organization: { environmentIdReadable: opts.environmentIdReadable ?? true, ...opts.organization } });
  const sent: { method: string; args: unknown[] }[] = [];
  const readFunction = fake.api.execute as unknown as (r: unknown, t?: unknown) => Promise<Record<string, unknown>>;
  const api = fake.api as unknown as Record<string, unknown>;
  api['execute'] = (request: { operationType?: string }, target?: unknown) => {
    if (request.operationType === 'function') return readFunction(request, target);
    sent.push({ method: 'execute', args: [request] });
    return Promise.resolve({});
  };
  for (const m of ['associate', 'disassociate', 'update'] as const) {
    api[m] = vi.fn((...args: unknown[]) => { sent.push({ method: m, args }); return Promise.resolve(); });
  }
  // Like the real service: a lookup column is only returned when selected as _<name>_value (selecting the plain name returns the row without it).
  api['retrieve'] = async (_entity: string, _id: string, columns?: string[]) => (opts.roleBusinessUnit === null || !columns?.includes('_businessunitid_value') ? {} : { _businessunitid_value: opts.roleBusinessUnit ?? BU });
  const w: HostWindow = { toolboxAPI: { connections: connections(opts.urls ?? [APPROVED.url]) }, dataverseAPI: fake.api };
  return { host: w, sent, fake };
}

const approve = (writes: PlannedWrite[]): ApprovedPlan => approvePlan(createWritePlan(writes), APPROVED.environmentId, 'Owner', Date.now(), { lifetimeMs: 60_000 });

describe('createHostSecurityWriter', () => {
  it('has no writer outside a host that provides the Dataverse API', () => {
    expect(createHostSecurityWriter(undefined)).toBeNull();
    expect(createHostSecurityWriter({} as HostWindow)).toBeNull();
    expect(createHostSecurityWriter({ toolboxAPI: { connections: connections() } })).toBeNull();
  });

  it('adds a privilege with the role Business Unit read first, through AddPrivilegesRole', async () => {
    const h = host();
    const writer = createHostSecurityWriter(h.host);
    const result = await writer?.addPrivilege(approve([plannedWrite.addPrivilege(ROLE, PRIV, 'Local', 'Add')]), ROLE, PRIV, 'Local');
    expect(result).toMatchObject({ outcome: 'notVerified', failure: 'none' });
    expect(h.sent).toEqual([
      { method: 'execute', args: [{ operationName: 'AddPrivilegesRole', operationType: 'action', entityName: 'role', entityId: ROLE, parameters: { Privileges: [{ PrivilegeId: PRIV, Depth: 'Local', BusinessUnitId: BU }] } }] },
    ]);
  });

  it('removes a privilege, assigns and unassigns a role, and moves a user, each as exactly one allow-listed call', async () => {
    const h = host();
    const writer = createHostSecurityWriter(h.host);
    const plan = approve([
      plannedWrite.removePrivilege(ROLE, PRIV, 'Remove'),
      plannedWrite.assignRole(USER, ROLE, 'Assign'),
      plannedWrite.unassignRole(USER, ROLE, 'Unassign'),
      plannedWrite.moveUser(USER, BU, 'Move'),
    ]);
    for (const r of [await writer?.removePrivilege(plan, ROLE, PRIV), await writer?.assignRole(plan, USER, ROLE), await writer?.unassignRole(plan, USER, ROLE), await writer?.moveUser(plan, USER, BU)]) {
      expect(r).toMatchObject({ outcome: 'notVerified' });
    }
    expect(h.sent.map((s) => s.method)).toEqual(['execute', 'associate', 'disassociate', 'update']);
    expect(h.sent[3]?.args).toEqual(['systemuser', USER, { 'businessunitid@odata.bind': `/businessunits(${BU})` }, 'primary']);
  });

  it('locked build: sends nothing when the connected URL is not the approved environment', async () => {
    const h = host({ urls: ['https://other.crm4.dynamics.com'] });
    const writer = createHostSecurityWriter(h.host, LOCKED);
    const result = await writer?.assignRole(approve([plannedWrite.assignRole(USER, ROLE, 'Assign')]), USER, ROLE);
    expect(result).toMatchObject({ outcome: 'failed', failure: 'identity' });
    expect(h.sent).toEqual([]);
  });

  it('sends nothing when two connections are configured', async () => {
    const h = host({ urls: [APPROVED.url, 'https://other.crm4.dynamics.com'] });
    const result = await createHostSecurityWriter(h.host)?.assignRole(approve([plannedWrite.assignRole(USER, ROLE, 'Assign')]), USER, ROLE);
    expect(result).toMatchObject({ failure: 'identity' });
    expect(h.sent).toEqual([]);
  });

  it('sends nothing when the environment id cannot be read (writes need all three identifiers)', async () => {
    const h = host({ environmentIdReadable: false });
    const result = await createHostSecurityWriter(h.host, LOCKED)?.assignRole(approve([plannedWrite.assignRole(USER, ROLE, 'Assign')]), USER, ROLE);
    expect(result).toMatchObject({ outcome: 'failed', failure: 'identity' });
    expect(h.sent).toEqual([]);
  });

  it('sends nothing when Dataverse reports a different environment id', async () => {
    const fake = createFakeDataverse({ organization: { environmentid: '99999999-9999-9999-9999-999999999999' } });
    const sent: unknown[] = [];
    const readFunction = fake.api.execute as unknown as (r: unknown, t?: unknown) => Promise<Record<string, unknown>>;
    (fake.api as unknown as Record<string, unknown>)['associate'] = () => { sent.push('associate'); return Promise.resolve(); };
    (fake.api as unknown as Record<string, unknown>)['execute'] = (r: { operationType?: string }, t?: unknown) => (r.operationType === 'function' ? readFunction(r, t) : (sent.push('execute'), Promise.resolve({})));
    const w: HostWindow = { toolboxAPI: { connections: connections() }, dataverseAPI: fake.api };
    const result = await createHostSecurityWriter(w, LOCKED)?.assignRole(approve([plannedWrite.assignRole(USER, ROLE, 'Assign')]), USER, ROLE);
    expect(result).toMatchObject({ failure: 'identity' });
    expect(sent).toEqual([]);
  });

  it('sends nothing for a write that is not in the confirmed plan, and re-verifies the identity before every write', async () => {
    const h = host();
    const writer = createHostSecurityWriter(h.host);
    const plan = approve([plannedWrite.assignRole(USER, ROLE, 'Assign')]);
    expect(await writer?.assignRole(plan, USER, '44444444-4444-4444-4444-444444444444')).toMatchObject({ failure: 'validation' });
    expect(h.sent).toEqual([]);
    const before = h.fake.calls.filter((c) => c.method === 'retrieveCurrentOrganization').length;
    await writer?.assignRole(plan, USER, ROLE);
    await writer?.assignRole(plan, USER, ROLE).catch(() => undefined);
    expect(h.fake.calls.filter((c) => c.method === 'retrieveCurrentOrganization').length - before).toBeGreaterThanOrEqual(2);
  });

  /** The same host with a switchable active connection (the URL the host reports can be changed mid-flight). */
  function switchable(h: ReturnType<typeof host>) {
    const state = { url: APPROVED.url };
    const w: HostWindow = {
      toolboxAPI: { connections: { getActiveConnection: async () => ({ url: state.url }), getConnections: async () => [{ url: state.url }] } },
      dataverseAPI: h.host.dataverseAPI as NonNullable<HostWindow['dataverseAPI']>,
    };
    return { state, host: w };
  }

  it('sends nothing when the active connection changes while the role Business Unit is being looked up', async () => {
    const h = host();
    const sw = switchable(h);
    (sw.host.dataverseAPI as unknown as Record<string, unknown>)['retrieve'] = async () => {
      sw.state.url = 'https://other.crm4.dynamics.com'; // the connection is switched while the lookup is pending
      return { _businessunitid_value: BU };
    };
    const result = await createHostSecurityWriter(sw.host)?.addPrivilege(approve([plannedWrite.addPrivilege(ROLE, PRIV, 'Local', 'Add')]), ROLE, PRIV, 'Local');
    expect(result).toMatchObject({ outcome: 'failed', failure: 'validation' });
    expect(result?.message).toMatch(/not sent|Nothing was sent/);
    expect(h.sent).toEqual([]);
  });

  it('sends nothing when the active connection changes while the identity is being verified', async () => {
    const h = host();
    const sw = switchable(h);
    const api = sw.host.dataverseAPI as unknown as Record<string, unknown>;
    const original = api['execute'] as (r: { operationType?: string }, t?: unknown) => Promise<Record<string, unknown>>;
    api['execute'] = async (r: { operationType?: string }, t?: unknown) => {
      const answer = await original(r, t);
      if (r.operationType === 'function') sw.state.url = 'https://other.crm4.dynamics.com'; // switched after the environment id was read
      return answer;
    };
    const result = await createHostSecurityWriter(sw.host)?.assignRole(approve([plannedWrite.assignRole(USER, ROLE, 'Assign')]), USER, ROLE);
    expect(result).toMatchObject({ outcome: 'failed', failure: 'identity' });
    expect(h.sent).toEqual([]);
  });

  it('sends nothing when the role Business Unit cannot be read', async () => {
    const h = host({ roleBusinessUnit: null });
    const result = await createHostSecurityWriter(h.host)?.addPrivilege(approve([plannedWrite.addPrivilege(ROLE, PRIV, 'Basic', 'Add')]), ROLE, PRIV, 'Basic');
    expect(result).toMatchObject({ outcome: 'failed', failure: 'validation' });
    expect(h.sent).toEqual([]);
  });
});

describe('a refused write says why', () => {
  it('names the reason when the role Business Unit could not be read, and sends nothing', async () => {
    const h = host({ roleBusinessUnit: null });
    const writer = createHostSecurityWriter(h.host);
    const result = await writer?.addPrivilege(approve([plannedWrite.addPrivilege(ROLE, PRIV, 'Basic', 'Add')]), ROLE, PRIV, 'Basic');
    expect(result).toMatchObject({ outcome: 'failed', failure: 'validation', dispatched: false });
    expect(result?.message).toContain('The Business Unit of the role could not be read');
    expect(result?.message).toContain('Nothing was sent.');
    expect(h.sent).toEqual([]);
  });

  it('includes the host error kind when reading the Business Unit threw', async () => {
    const h = host();
    (h.fake.api as unknown as Record<string, unknown>)['retrieve'] = async () => { throw Object.assign(new Error('Too many requests'), { status: 429 }); };
    const writer = createHostSecurityWriter(h.host);
    const result = await writer?.addPrivilege(approve([plannedWrite.addPrivilege(ROLE, PRIV, 'Basic', 'Add')]), ROLE, PRIV, 'Basic');
    expect(result?.message).toMatch(/throttled 429/);
    expect(h.sent).toEqual([]);
  });
});

// Decision D1 (2026-11-10): the shipped tool is not locked to one environment. It identifies the connected environment and binds the
// confirmation to it.
describe('createHostSecurityWriter: open mode (any environment, identified from the connection)', () => {
  const OTHER = { urls: ['https://contoso-test.crm4.dynamics.com'], organization: { organizationid: '77777777-7777-7777-7777-777777777777', environmentid: '88888888-8888-8888-8888-888888888888' } };
  const assign = () => [plannedWrite.assignRole(USER, ROLE, 'Assign')];
  const approveFor = (environmentId: string) => approvePlan(createWritePlan(assign()), environmentId, 'Owner', Date.now(), { lifetimeMs: 60_000 });

  it('writes in an environment other than the Developer one when the confirmation names exactly that environment', async () => {
    const h = host(OTHER);
    const result = await createHostSecurityWriter(h.host)?.assignRole(approveFor('88888888-8888-8888-8888-888888888888'), USER, ROLE);
    expect(result).toMatchObject({ outcome: 'notVerified', dispatched: true });
    expect(h.sent.map((s) => s.method)).toEqual(['associate']);
  });

  it('sends nothing when the confirmation was given for a different environment (the Developer one) than the connected one', async () => {
    const h = host(OTHER);
    const result = await createHostSecurityWriter(h.host)?.assignRole(approveFor(APPROVED.environmentId), USER, ROLE);
    expect(result).toMatchObject({ outcome: 'failed', failure: 'validation' });
    expect(h.sent).toEqual([]);
  });

  it('identifies the environment by its organization id when Dataverse does not report the environment id', async () => {
    const h = host({ ...OTHER, environmentIdReadable: false });
    const wrong = await createHostSecurityWriter(h.host)?.assignRole(approveFor('88888888-8888-8888-8888-888888888888'), USER, ROLE);
    expect(wrong).toMatchObject({ failure: 'validation' });
    const right = await createHostSecurityWriter(h.host)?.assignRole(approveFor('77777777-7777-7777-7777-777777777777'), USER, ROLE);
    expect(right).toMatchObject({ outcome: 'notVerified' });
  });

  it('a confirmation bound to the organization id (the environment id could not be read when it was given) is still valid for the same environment, and only for it', async () => {
    const h = host(OTHER);
    const byOrg = await createHostSecurityWriter(h.host)?.assignRole(approveFor('77777777-7777-7777-7777-777777777777'), USER, ROLE);
    expect(byOrg).toMatchObject({ outcome: 'notVerified', dispatched: true });
    const byEnv = await createHostSecurityWriter(h.host)?.assignRole(approveFor('88888888-8888-8888-8888-888888888888'), USER, ROLE);
    expect(byEnv).toMatchObject({ outcome: 'notVerified', dispatched: true });
    const sent = h.sent.length;
    // Neither identifier of ANOTHER environment is accepted.
    for (const other of [APPROVED.organizationId, APPROVED.environmentId, '99999999-9999-9999-9999-999999999999']) {
      expect(await createHostSecurityWriter(h.host)?.assignRole(approveFor(other), USER, ROLE)).toMatchObject({ outcome: 'failed', failure: 'validation' });
    }
    expect(h.sent.length).toBe(sent);
  });

  it('still refuses with no connection, with several connections and when the organization cannot be read', async () => {
    for (const h of [host({ urls: [null] }), host({ urls: [APPROVED.url, 'https://other.crm4.dynamics.com'] })]) {
      expect(await createHostSecurityWriter(h.host)?.assignRole(approveFor(APPROVED.environmentId), USER, ROLE)).toMatchObject({ failure: 'identity' });
      expect(h.sent).toEqual([]);
    }
    const noOrg = host({ organization: { organizationid: null } });
    expect(await createHostSecurityWriter(noOrg.host)?.assignRole(approveFor(APPROVED.environmentId), USER, ROLE)).toMatchObject({ failure: 'identity' });
    expect(noOrg.sent).toEqual([]);
  });
});
