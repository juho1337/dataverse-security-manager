import { describe, expect, it } from 'vitest';
import { createFakeDataverse, MUTATING_METHODS } from '../../test/fakeDataverse';
import { createReadOnlyHost, READ_ONLY_HOST_METHODS } from './readOnlyHost';

describe('ReadOnlyHost facade', () => {
  it('exposes exactly the allow-listed read methods and is frozen', () => {
    const host = createReadOnlyHost(createFakeDataverse().api);
    expect(Object.keys(host).sort()).toEqual([...READ_ONLY_HOST_METHODS].sort());
    expect(Object.isFrozen(host)).toBe(true);
  });

  it('does not expose any mutating host method (including execute and batch calls)', () => {
    const host = createReadOnlyHost(createFakeDataverse().api) as unknown as Record<string, unknown>;
    for (const m of MUTATING_METHODS) expect(host[m], m).toBeUndefined();
  });

  it('never reaches a mutating host method, whatever the reads do', async () => {
    const fake = createFakeDataverse();
    const host = createReadOnlyHost(fake.api);
    await host.retrieve('role', 'x', ['name']);
    await host.queryData('roles?$top=1');
    await host.fetchXmlQuery('<fetch/>');
    await host.retrieveMultiple('<fetch/>');
    await host.getEntityMetadata('account', true, ['LogicalName']);
    await host.getAllEntitiesMetadata(['LogicalName']);
    await host.getEntityRelatedMetadata('account', 'Privileges');
    expect(fake.mutatorCalls()).toEqual([]);
  });

  it('always targets the primary connection and never passes additional headers', async () => {
    const fake = createFakeDataverse();
    const host = createReadOnlyHost(fake.api);
    await host.retrieve('role', 'x', ['name']);
    await host.queryData('roles');
    await host.fetchXmlQuery('<fetch/>');
    await host.getEntityMetadata('account', true);
    await host.getAllEntitiesMetadata(['LogicalName']);
    for (const c of fake.calls) {
      expect(c.args[c.args.length - 1], c.method).toBe('primary');
      expect(c.args.length, c.method).toBeLessThanOrEqual(4);
      expect(c.args.some((a) => a !== null && typeof a === 'object' && !Array.isArray(a)), `${c.method} passed an object (headers?)`).toBe(false);
    }
  });

  it('sends exactly one fixed read function through execute, to the primary connection, and nothing else', async () => {
    const fake = createFakeDataverse();
    const host = createReadOnlyHost(fake.api);
    const org = await host.retrieveCurrentOrganization();
    expect(org).toEqual({ Detail: { EnvironmentId: '00000000-0000-4000-8000-000000000002' } });
    const call = fake.calls.find((c) => c.method === 'retrieveCurrentOrganization');
    expect(call?.args).toEqual([
      { operationName: 'RetrieveCurrentOrganization', operationType: 'function', parameters: { AccessType: "Microsoft.Dynamics.CRM.EndpointAccessType'Default'" } },
      'primary',
    ]);
    expect(fake.mutatorCalls()).toEqual([]);
    // The facade has no way to execute anything else: no execute method, and the request carries no caller input.
    expect((host as unknown as Record<string, unknown>)['execute']).toBeUndefined();
    expect(host.retrieveCurrentOrganization.length).toBe(0);
  });

  it('an attempt to execute any other operation through the host still reaches the throwing mutating spy', () => {
    const fake = createFakeDataverse();
    expect(() => (fake.api.execute as unknown as (r: unknown) => unknown)({ operationName: 'DeleteSomething', operationType: 'action' })).toThrow('must never be called');
    expect(fake.mutatorCalls()).toEqual(['execute']);
  });

  it('reports a clear error when the host lacks a read method', async () => {
    const host = createReadOnlyHost({});
    await expect(host.queryData('x')).rejects.toThrow('does not provide queryData');
  });
});
