import { vi } from 'vitest';
import type { RawDataverseApi } from '../adapters/pptb/readOnlyHost';

// In-memory stand-in for the host Dataverse API (no host, no network). It answers the FetchXML and OData reads the
// adapter issues, records every call, and carries spies for the mutating host methods so tests can prove they are
// never reached.

type Row = Record<string, unknown>;

export const APPROVED = {
  url: 'https://org00000000.crm.dynamics.com',
  organizationId: '00000000-0000-4000-8000-000000000001',
  environmentId: '00000000-0000-4000-8000-000000000002',
};

export const MUTATING_METHODS = [
  'create', 'update', 'delete', 'execute', 'associate', 'disassociate', 'executeBatch', 'executeTransaction',
  'createMultiple', 'updateMultiple', 'deploySolution', 'publishCustomizations', 'createEntityDefinition',
  'updateEntityDefinition', 'deleteEntityDefinition', 'createAttribute', 'updateAttribute', 'deleteAttribute',
  'createRelationship', 'updateRelationship', 'deleteRelationship', 'createGlobalOptionSet', 'insertOptionValue',
] as const;

export interface FakeOptions {
  tables?: Row[];
  privileges?: Row[]; // rows of the privilege + privilegeobjecttypecodes join, aliased as ptc.objecttypecode
  roles?: Row[];
  grants?: Row[];
  organization?: { organizationid?: string; environmentid?: string | null; environmentIdReadable?: boolean };
  /** Fail a fetch: entity name and page number, with the rejection to throw. */
  failFetch?: { entity: string; page: number; error: unknown; times?: number };
  /** Ignore the page attribute (a host that does not honor paging). */
  ignorePaging?: boolean;
  /** Reject getEntityMetadata with this. */
  failMetadata?: unknown;
}

export interface Call {
  method: string;
  args: unknown[];
}

export function createFakeDataverse(options: FakeOptions = {}) {
  /** Stable integer ObjectTypeCode per table (the real metadata supplies it; account is 1 there). */
  const objectTypeCodeOf = (name: string): number => {
    const i = (options.tables ?? []).findIndex((t) => t['LogicalName'] === name);
    return i >= 0 ? i + 1 : 90_000;
  };
  const calls: Call[] = [];
  const org = { organizationid: APPROVED.organizationId, environmentid: APPROVED.environmentId, environmentIdReadable: true, ...options.organization };
  let failuresLeft = options.failFetch?.times ?? 1;

  const record = <A extends unknown[], R>(method: string, fn: (...a: A) => R) => (...args: A): R => {
    calls.push({ method, args });
    return fn(...args);
  };

  const dataset: Record<string, Row[]> = {
    privilege: options.privileges ?? [],
    role: options.roles ?? [],
    roleprivileges: options.grants ?? [],
  };

  const api: RawDataverseApi = {
    queryData: record('queryData', async (odata: string) => {
      if (odata.startsWith('organizations')) {
        // The organizations table has no environmentid column (verified against the approved environment).
        if (odata.includes('environmentid')) throw new Error('Could not find a property named environmentid');
        return { value: [{ organizationid: org.organizationid }] };
      }
      return { value: [] };
    }),
    fetchXmlQuery: record('fetchXmlQuery', async (fetchXml: string) => {
      const rootEntity = /<entity name="(\w+)"/.exec(fetchXml)?.[1] ?? '';
      // Grants are read from the role through the intersect table (alias rp); the dataset still holds them as roleprivileges rows.
      // Like the real host: a fetch ROOTED at the intersect table roleprivileges is a 404 (verified on the real host).
      if (rootEntity === 'roleprivileges') throw Object.assign(new Error("Resource not found for the segment 'roleprivileges'."), { status: 404 });
      const viaRole = rootEntity === 'role' && fetchXml.includes('alias="rp"');
      const entity = viaRole ? 'roleprivileges' : rootEntity;
      const page = Number(/page="(\d+)"/.exec(fetchXml)?.[1] ?? '1');
      const count = Number(/count="(\d+)"/.exec(fetchXml)?.[1] ?? '5000');
      const f = options.failFetch;
      if (f && f.entity === entity && f.page === page && failuresLeft > 0) {
        failuresLeft--;
        throw f.error;
      }
      let rows = dataset[entity] ?? [];
      const rawFilter = /attribute="objecttypecode" operator="eq" value="([^"]+)"/.exec(fetchXml)?.[1];
      if (entity === 'privilege' && rawFilter !== undefined) {
        // Like the real service: the filter takes the integer ObjectTypeCode, a logical name is a 400 FormatException.
        if (!/^\d+$/.test(rawFilter)) {
          throw Object.assign(new Error("An exception System.FormatException was thrown while trying to convert input value '[REDACTED]' to attribute 'privilegeobjecttypecodes.objecttypecode'. Expected type of attribute value: System.Int32."), { status: 400 });
        }
        const table = (options.tables ?? []).map((t) => String(t['LogicalName'])).find((n) => objectTypeCodeOf(n) === Number(rawFilter));
        rows = rows.filter((r) => table !== undefined && String(r['ptc.objecttypecode']).toLowerCase() === table.toLowerCase());
      }
      if (entity === 'roleprivileges') {
        const ids = [...fetchXml.matchAll(/<value>([^<]+)<\/value>/g)].map((m) => (m[1] ?? '').toLowerCase());
        rows = rows.filter((r) => ids.includes(String(r['privilegeid']).toLowerCase()));
      }
      if (viaRole) rows = rows.map((r) => ({ roleid: r['roleid'], 'rp.privilegeid': r['privilegeid'], 'rp.privilegedepthmask': r['privilegedepthmask'] }));
      const start = options.ignorePaging ? 0 : (page - 1) * count;
      return { value: rows.slice(start, start + count) };
    }),
    retrieveMultiple: record('retrieveMultiple', async () => ({ value: [] })),
    retrieve: record('retrieve', async () => ({})),
    getAllEntitiesMetadata: record('getAllEntitiesMetadata', async () => ({ value: options.tables ?? [] })),
    getEntityMetadata: record('getEntityMetadata', async (name: string) => {
      if (options.failMetadata) throw options.failMetadata;
      const found = (options.tables ?? []).find((t) => t['LogicalName'] === name);
      return { ...(found ?? { LogicalName: name }), ObjectTypeCode: objectTypeCodeOf(name) };
    }),
    getEntityRelatedMetadata: record('getEntityRelatedMetadata', async () => ({ value: [] })),
  };

  // Mutating methods exist on the fake host object only so that a test can prove nobody calls them.
  const mutators: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const m of MUTATING_METHODS) {
    mutators[m] = vi.fn(() => {
      throw new Error(`mutating host method ${m} must never be called`);
    });
  }
  const full = Object.assign(api, mutators) as RawDataverseApi;
  // execute is a mutating method EXCEPT for the one fixed read function the facade may send; anything else reaches the throwing spy.
  full.execute = ((request: { operationName?: string; operationType?: string }, ...rest: unknown[]) => {
    if (request?.operationType === 'function' && request.operationName === 'RetrieveCurrentOrganization') {
      calls.push({ method: 'retrieveCurrentOrganization', args: [request, ...rest] });
      if (!org.environmentIdReadable) return Promise.reject(new Error('RetrieveCurrentOrganization is not available'));
      return Promise.resolve({ Detail: org.environmentid ? { EnvironmentId: org.environmentid } : {} });
    }
    return (mutators['execute'] as unknown as (...a: unknown[]) => Promise<Record<string, unknown>>)(request, ...rest);
  }) as RawDataverseApi['execute'];

  const count = (method: string) => calls.filter((c) => c.method === method).length;
  const mutatorCalls = () => MUTATING_METHODS.filter((m) => (mutators[m]?.mock.calls.length ?? 0) > 0);
  return { api: full, calls, count, mutators, mutatorCalls };
}

export function connections(urls: Array<string | null> = [APPROVED.url]) {
  const slots = urls.map((url) => (url ? { url } : null));
  return {
    getActiveConnection: async () => slots.find((s) => s !== null) ?? null,
    getConnections: async () => slots,
  };
}

// ---- synthetic Dataverse rows
const ptc = (privilegeid: string, name: string, accessright: number, table: string): Row => ({ privilegeid, name, accessright, 'ptc.objecttypecode': table });

export const PRIVS = {
  create: 'a0000000-0000-0000-0000-000000000001',
  read: 'a0000000-0000-0000-0000-000000000002',
  write: 'a0000000-0000-0000-0000-000000000003',
  delete: 'a0000000-0000-0000-0000-000000000004',
  append: 'a0000000-0000-0000-0000-000000000005',
  appendTo: 'a0000000-0000-0000-0000-000000000006',
  share: 'a0000000-0000-0000-0000-000000000008',
};

/** Table with seven of the eight privileges (no Assign: not applicable). */
export const SYNTHETIC_PRIVILEGES: Row[] = [
  ptc(PRIVS.create, 'prvCreateContosoProject', 32, 'contoso_project'),
  ptc(PRIVS.read, 'prvReadContosoProject', 1, 'contoso_project'),
  ptc(PRIVS.write, 'prvWriteContosoProject', 2, 'contoso_project'),
  ptc(PRIVS.delete, 'prvDeleteContosoProject', 65536, 'contoso_project'),
  ptc(PRIVS.append, 'prvAppendContosoProject', 4, 'contoso_project'),
  ptc(PRIVS.appendTo, 'prvAppendToContosoProject', 16, 'contoso_project'),
  ptc(PRIVS.share, 'prvShareContosoProject', 262144, 'contoso_project'),
  ptc('b0000000-0000-0000-0000-000000000001', 'prvReadContosoOther', 1, 'contoso_other'),
];

export const SYNTHETIC_TABLES: Row[] = [
  { LogicalName: 'contoso_project', DisplayName: { UserLocalizedLabel: { Label: 'Contoso Project' } } },
  { LogicalName: 'contoso_other', DisplayName: { UserLocalizedLabel: { Label: 'Contoso Other' } } },
  { LogicalName: 'contoso_audit', DisplayName: { UserLocalizedLabel: { Label: 'Contoso Audit Log' } } },
  { LogicalName: 'contoso_private', IsPrivate: true, DisplayName: { UserLocalizedLabel: { Label: 'Hidden' } } },
  { LogicalName: 'contoso_link', IsIntersect: true, DisplayName: { UserLocalizedLabel: { Label: 'Link' } } },
];

export const ROLE_A = 'c0000000-0000-0000-0000-00000000000a';
export const ROLE_B = 'c0000000-0000-0000-0000-00000000000b';
export const SYNTHETIC_ROLES: Row[] = [
  { roleid: ROLE_B, name: 'Project Reader' },
  { roleid: ROLE_A, name: 'Project Contributor' },
];
export const SYNTHETIC_GRANTS: Row[] = [
  { roleid: ROLE_A, privilegeid: PRIVS.create, privilegedepthmask: 2 },
  { roleid: ROLE_A, privilegeid: PRIVS.read, privilegedepthmask: 8 },
  { roleid: ROLE_A, privilegeid: PRIVS.write, privilegedepthmask: 4 },
  { roleid: ROLE_B, privilegeid: PRIVS.read, privilegedepthmask: 1 },
];
