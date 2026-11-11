import { describe, expect, it } from 'vitest';
import { FixtureReader } from '../adapters/fixture/fixtureReader';
import type { HostWindow } from '../adapters/pptb/connection';
import { PptbSecurityDataReader } from '../adapters/pptb/reader';
import { createFakeDataverse, connections } from '../test/fakeDataverse';
import { APPROVED_DEVELOPER_ENVIRONMENT } from '../adapters/pptb/config';
import { isHostPresent, selectReader } from './dataSource';

describe('selectReader', () => {
  it('uses the synthetic demo reader, labelled synthetic, only when no host is present', () => {
    for (const host of [undefined, {} as HostWindow]) {
      const s = selectReader(host);
      expect(s.dataSource).toBe('synthetic');
      expect(s.reader).toBeInstanceOf(FixtureReader);
      expect(isHostPresent(host)).toBe(false);
    }
  });

  it('uses the live PPTB reader, labelled live, when the host Dataverse API is present', () => {
    const host: HostWindow = { toolboxAPI: { connections: connections() }, dataverseAPI: createFakeDataverse().api };
    const s = selectReader(host);
    expect(s.dataSource).toBe('live');
    expect(s.reader).toBeInstanceOf(PptbSecurityDataReader);
  });

  it('inside a host that lacks the Dataverse API it stays live and reports an error, never falling back to synthetic data', async () => {
    const host: HostWindow = { toolboxAPI: { connections: connections() } };
    const s = selectReader(host);
    expect(s.dataSource).toBe('live');
    expect(s.reader).not.toBeInstanceOf(FixtureReader);
    expect(await s.reader.listTables()).toMatchObject({ status: 'error' });
  });

  it('a locked build reads nothing when the connected environment is not the approved one', async () => {
    const fake = createFakeDataverse();
    const host: HostWindow = { toolboxAPI: { connections: connections(['https://other.crm4.dynamics.com']) }, dataverseAPI: fake.api };
    const result = await selectReader(host, { live: { expected: APPROVED_DEVELOPER_ENVIRONMENT } }).reader.listTables();
    expect(result).toMatchObject({ status: 'error' });
    expect(fake.calls).toEqual([]);
  });
});
