import { describe, expect, it } from 'vitest';
import { APPROVED, connections, createFakeDataverse } from '../../test/fakeDataverse';
import { APPROVED_DEVELOPER_ENVIRONMENT } from './config';
import { normalizeGuid, normalizeUrl, verifyEnvironment, verifyHostEnvironment, type HostIdentityInfo } from './identity';
import { createReadOnlyHost } from './readOnlyHost';

const good: HostIdentityInfo = {
  activeConnectionUrl: APPROVED.url,
  candidateConnectionCount: 1,
  organizationId: APPROVED.organizationId,
  environmentId: APPROVED.environmentId,
};

describe('approved environment configuration', () => {
  it('holds exactly the owner-approved identifiers in one module', () => {
    expect(APPROVED_DEVELOPER_ENVIRONMENT).toEqual(APPROVED);
    expect(Object.isFrozen(APPROVED_DEVELOPER_ENVIRONMENT)).toBe(true);
  });
});

describe('verifyEnvironment (pure, fail closed)', () => {
  const expected = APPROVED_DEVELOPER_ENVIRONMENT;

  it('verifies when URL, organization and environment all match, and then allows writes', () => {
    expect(verifyEnvironment(expected, good)).toMatchObject({ status: 'verified', writesAllowed: true });
  });

  it('ignores case and a trailing slash in the URL, and braces/case in ids', () => {
    const r = verifyEnvironment(expected, {
      ...good,
      activeConnectionUrl: 'HTTPS://ORG00000000.CRM.DYNAMICS.COM/',
      organizationId: `{${APPROVED.organizationId.toUpperCase()}}`,
      environmentId: APPROVED.environmentId.toUpperCase(),
    });
    expect(r.status).toBe('verified');
  });

  it('refuses a different organization URL and names expected and reported values', () => {
    const r = verifyEnvironment(expected, { ...good, activeConnectionUrl: 'https://contoso-prod.crm4.dynamics.com' });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('urlMismatch');
    expect(r.message).toContain('https://org00000000.crm.dynamics.com');
    expect(r.message).toContain('https://contoso-prod.crm4.dynamics.com');
    expect(r.writesAllowed).toBe(false);
  });

  it('refuses a different organization id', () => {
    const r = verifyEnvironment(expected, { ...good, organizationId: '11111111-1111-1111-1111-111111111111' });
    expect(r).toMatchObject({ status: 'refused', reason: 'organizationMismatch' });
  });

  it('refuses when the organization id could not be read', () => {
    expect(verifyEnvironment(expected, { ...good, organizationId: null })).toMatchObject({ status: 'refused', reason: 'organizationUnreadable' });
  });

  it('refuses a missing connection', () => {
    expect(verifyEnvironment(expected, { ...good, activeConnectionUrl: null, candidateConnectionCount: 0 })).toMatchObject({ status: 'refused', reason: 'noConnection' });
  });

  it('refuses more than one candidate connection, even when one matches', () => {
    expect(verifyEnvironment(expected, { ...good, candidateConnectionCount: 2 })).toMatchObject({ status: 'refused', reason: 'multipleConnections' });
  });

  it('refuses a different environment id', () => {
    const r = verifyEnvironment(expected, { ...good, environmentId: '22222222-2222-2222-2222-222222222222' });
    expect(r).toMatchObject({ status: 'refused', reason: 'environmentMismatch' });
  });

  it('allows read-only but blocks writes when the environment id is unreadable', () => {
    expect(verifyEnvironment(expected, { ...good, environmentId: null })).toEqual({ status: 'environmentIdUnverifiable', writesAllowed: false });
  });

  it('normalizes URLs and ids', () => {
    expect(normalizeUrl(' https://X.crm4.dynamics.com/api/data/v9.2/ ')).toBe('https://x.crm4.dynamics.com');
    expect(normalizeGuid(' {ABC} ')).toBe('abc');
  });
});

describe('verifyHostEnvironment (reads facts through the read-only host)', () => {
  const run = (urls: Array<string | null>, fake = createFakeDataverse()) =>
    verifyHostEnvironment(APPROVED_DEVELOPER_ENVIRONMENT, connections(urls), createReadOnlyHost(fake.api)).then((result) => ({ result, fake }));

  it('verifies the approved environment end to end with fakes', async () => {
    const { result, fake } = await run([APPROVED.url]);
    expect(result).toMatchObject({ status: 'verified', writesAllowed: true });
    expect(fake.count('queryData')).toBe(1);
    expect(fake.mutatorCalls()).toEqual([]);
  });

  it('refuses a wrong URL before any Dataverse call is made', async () => {
    const { result, fake } = await run(['https://other.crm4.dynamics.com']);
    expect(result).toMatchObject({ status: 'refused', reason: 'urlMismatch' });
    expect(fake.calls).toEqual([]);
  });

  it('refuses two configured connections before any Dataverse call is made', async () => {
    const { result, fake } = await run([APPROVED.url, 'https://other.crm4.dynamics.com']);
    expect(result).toMatchObject({ status: 'refused', reason: 'multipleConnections' });
    expect(fake.calls).toEqual([]);
  });

  it('refuses when Dataverse reports a different organization id', async () => {
    const fake = createFakeDataverse({ organization: { organizationid: '33333333-3333-3333-3333-333333333333' } });
    expect((await run([APPROVED.url], fake)).result).toMatchObject({ status: 'refused', reason: 'organizationMismatch' });
  });

  it('reads the environment id from RetrieveCurrentOrganization, not from a table column', async () => {
    const { result, fake } = await run([APPROVED.url]);
    expect(result).toMatchObject({ status: 'verified', writesAllowed: true });
    expect(fake.count('queryData')).toBe(1);
    expect(fake.count('retrieveCurrentOrganization')).toBe(1);
    expect(String((fake.calls.find((c) => c.method === 'queryData')?.args ?? [])[0])).not.toContain('environmentid');
  });

  it('leaves the environment id unverifiable, and writes refused, when the host cannot run the function', async () => {
    const fake = createFakeDataverse({ organization: { environmentIdReadable: false } });
    const { result } = await run([APPROVED.url], fake);
    expect(result).toEqual({ status: 'environmentIdUnverifiable', writesAllowed: false });
  });

  it('leaves it unverifiable when the answer carries no environment id', async () => {
    const fake = createFakeDataverse({ organization: { environmentid: null } });
    expect((await run([APPROVED.url], fake)).result).toEqual({ status: 'environmentIdUnverifiable', writesAllowed: false });
  });

  it('refuses when Dataverse reports a different environment id', async () => {
    const fake = createFakeDataverse({ organization: { environmentid: '22222222-2222-2222-2222-222222222222' } });
    expect((await run([APPROVED.url], fake)).result).toMatchObject({ status: 'refused', reason: 'environmentMismatch' });
    expect(fake.mutatorCalls()).toEqual([]);
  });

  it('refuses when no organization row can be read at all', async () => {
    const fake = createFakeDataverse();
    fake.api.queryData = async () => {
      throw new Error('boom');
    };
    expect((await run([APPROVED.url], fake)).result).toMatchObject({ status: 'refused', reason: 'organizationUnreadable' });
  });

  it('refuses when the host has no connection', async () => {
    const r = await verifyHostEnvironment(APPROVED_DEVELOPER_ENVIRONMENT, undefined, createReadOnlyHost(createFakeDataverse().api));
    expect(r).toMatchObject({ status: 'refused', reason: 'noConnection' });
  });
});

describe('open mode (no expected environment: decision D1)', () => {
  const info = { activeConnectionUrl: 'https://Contoso-Test.crm4.dynamics.com/', candidateConnectionCount: 1, organizationId: '{AAAAAAAA-0000-0000-0000-000000000001}', environmentId: '{BBBBBBBB-0000-0000-0000-000000000002}' };

  it('identifies any environment from the connection and Dataverse; the key is the environment id', () => {
    expect(verifyEnvironment(null, info)).toEqual({
      status: 'verified',
      writesAllowed: true,
      environment: { url: 'https://contoso-test.crm4.dynamics.com', organizationId: 'aaaaaaaa-0000-0000-0000-000000000001', environmentId: 'bbbbbbbb-0000-0000-0000-000000000002', key: 'bbbbbbbb-0000-0000-0000-000000000002' },
    });
  });

  it('falls back to the organization id as the key when the environment id is unreadable (writes stay allowed, bound to that key)', () => {
    const r = verifyEnvironment(null, { ...info, environmentId: null });
    expect(r).toMatchObject({ status: 'verified', writesAllowed: true, environment: { environmentId: null, key: 'aaaaaaaa-0000-0000-0000-000000000001' } });
  });

  it('still fails closed: no connection, several connections, an unreadable organization', () => {
    expect(verifyEnvironment(null, { ...info, activeConnectionUrl: null, candidateConnectionCount: 0 })).toMatchObject({ status: 'refused', reason: 'noConnection' });
    expect(verifyEnvironment(null, { ...info, candidateConnectionCount: 2 })).toMatchObject({ status: 'refused', reason: 'multipleConnections' });
    expect(verifyEnvironment(null, { ...info, organizationId: null })).toMatchObject({ status: 'refused', reason: 'organizationUnreadable' });
  });

  it('verifyHostEnvironment: refuses on the connection alone before any Dataverse call, and reads the identity otherwise', async () => {
    const none = createFakeDataverse();
    expect(await verifyHostEnvironment(null, connections([null]), createReadOnlyHost(none.api))).toMatchObject({ status: 'refused', reason: 'noConnection' });
    expect(none.calls).toEqual([]);
    const fake = createFakeDataverse({ organization: { organizationid: '77777777-7777-7777-7777-777777777777', environmentid: '88888888-8888-8888-8888-888888888888' } });
    const result = await verifyHostEnvironment(null, connections(['https://contoso-test.crm4.dynamics.com']), createReadOnlyHost(fake.api));
    expect(result).toMatchObject({ status: 'verified', environment: { key: '88888888-8888-8888-8888-888888888888' } });
    expect(fake.mutatorCalls()).toEqual([]);
  });
});
