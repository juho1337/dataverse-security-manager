// Read-only facade over the host's Dataverse API. Only the methods listed in READ_ONLY_HOST_METHODS are reachable;
// everything else the host offers (create, update, delete, execute, associate, batch, ...) is deliberately absent, so
// adapter code cannot call it. Every call targets the primary connection and never passes additional headers (a request
// with extra headers pauses for a user consent prompt in the host, and this tool needs none).

export interface RawRecordSet {
  value: Record<string, unknown>[];
}

/** The structural subset of the host Dataverse API this facade may touch (all read methods). */
export interface RawDataverseApi {
  retrieve?: (entity: string, id: string, columns?: string[], target?: 'primary') => Promise<Record<string, unknown>>;
  queryData?: (odata: string, target?: 'primary') => Promise<RawRecordSet>;
  fetchXmlQuery?: (fetchXml: string, target?: 'primary') => Promise<RawRecordSet>;
  retrieveMultiple?: (fetchXml: string, target?: 'primary') => Promise<RawRecordSet>;
  getEntityMetadata?: (name: string, byLogicalName: boolean, props?: string[], target?: 'primary') => Promise<Record<string, unknown>>;
  getAllEntitiesMetadata?: (props?: string[], target?: 'primary') => Promise<RawRecordSet>;
  getEntityRelatedMetadata?: (name: string, path: string, props?: string[], target?: 'primary') => Promise<unknown>;
  /** Used ONLY for the one fixed read function below (RetrieveCurrentOrganization); never with a caller-supplied request. */
  execute?: (request: RawReadFunctionRequest, target?: 'primary') => Promise<Record<string, unknown>>;
}

/** The only request shape the facade ever sends through the host's execute: a read-only function. */
export interface RawReadFunctionRequest {
  operationName: string;
  operationType: 'function';
  parameters?: Record<string, unknown>;
}

export interface ReadOnlyHost {
  retrieve(entity: string, id: string, columns?: string[]): Promise<Record<string, unknown>>;
  queryData(odata: string): Promise<RawRecordSet>;
  fetchXmlQuery(fetchXml: string): Promise<RawRecordSet>;
  retrieveMultiple(fetchXml: string): Promise<RawRecordSet>;
  getEntityMetadata(name: string, byLogicalName: boolean, props?: string[]): Promise<Record<string, unknown>>;
  getAllEntitiesMetadata(props?: string[]): Promise<RawRecordSet>;
  getEntityRelatedMetadata(name: string, path: string, props?: string[]): Promise<unknown>;
  /** The current organization as Dataverse reports it (a function, not an action; it changes nothing). Carries the environment id. */
  retrieveCurrentOrganization(): Promise<Record<string, unknown>>;
}

export const READ_ONLY_HOST_METHODS = [
  'retrieve',
  'queryData',
  'fetchXmlQuery',
  'retrieveMultiple',
  'getEntityMetadata',
  'getAllEntitiesMetadata',
  'getEntityRelatedMetadata',
  'retrieveCurrentOrganization',
] as const;

/**
 * Fixed request, no inputs: the facade can send nothing else through the host's execute. RetrieveCurrentOrganization is a Dataverse
 * function (GET); its Detail.EnvironmentId is how the environment id is read, because the organizations table has no environmentid column
 * (verified against the approved environment on 2026-11-02). The enum is spelled in the namespaced form the host documents for functions.
 */
const RETRIEVE_CURRENT_ORGANIZATION: RawReadFunctionRequest = Object.freeze({
  operationName: 'RetrieveCurrentOrganization',
  operationType: 'function',
  parameters: Object.freeze({ AccessType: "Microsoft.Dynamics.CRM.EndpointAccessType'Default'" }),
});

const PRIMARY = 'primary' as const;

function need<F>(fn: F | undefined, name: string): F {
  if (typeof fn !== 'function') throw new Error(`The host does not provide ${name}.`);
  return fn;
}

export function createReadOnlyHost(raw: RawDataverseApi): ReadOnlyHost {
  const host: ReadOnlyHost = {
    retrieve: async (entity, id, columns) => need(raw.retrieve, 'retrieve').call(raw, entity, id, columns, PRIMARY),
    queryData: async (odata) => need(raw.queryData, 'queryData').call(raw, odata, PRIMARY),
    fetchXmlQuery: async (fetchXml) => need(raw.fetchXmlQuery, 'fetchXmlQuery').call(raw, fetchXml, PRIMARY),
    retrieveMultiple: async (fetchXml) => need(raw.retrieveMultiple, 'retrieveMultiple').call(raw, fetchXml, PRIMARY),
    getEntityMetadata: async (name, byLogicalName, props) =>
      need(raw.getEntityMetadata, 'getEntityMetadata').call(raw, name, byLogicalName, props, PRIMARY),
    getAllEntitiesMetadata: async (props) => need(raw.getAllEntitiesMetadata, 'getAllEntitiesMetadata').call(raw, props, PRIMARY),
    getEntityRelatedMetadata: async (name, path, props) =>
      need(raw.getEntityRelatedMetadata, 'getEntityRelatedMetadata').call(raw, name, path, props, PRIMARY),
    retrieveCurrentOrganization: async () => need(raw.execute, 'RetrieveCurrentOrganization').call(raw, RETRIEVE_CURRENT_ORGANIZATION, PRIMARY),
  };
  return Object.freeze(host);
}
