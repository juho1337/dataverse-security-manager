// PPTB host adapter, connection information only. This module must never call a mutating host method;
// a test enforces that. Dataverse data access is added later behind the read-only SecurityDataReader port.

import type { RawDataverseApi } from './readOnlyHost';

export type HostEnvironmentType = 'Dev' | 'Test' | 'UAT' | 'Production';

/** What the header shows about the environment the tool is attached to. */
export type ConnectionState =
  | { readonly kind: 'host'; readonly name: string; readonly url: string; readonly environmentType: HostEnvironmentType | null }
  | { readonly kind: 'none' }
  | { readonly kind: 'demo' }
  | { readonly kind: 'error'; readonly message: string };

/** The tiny part of window.toolboxAPI used here (structural, so tests can fake it). */
export interface HostWindow {
  readonly toolboxAPI?: {
    readonly connections?: {
      readonly getActiveConnection?: () => Promise<{ id?: string; name?: string; url?: string; environment?: string } | null>;
      readonly getConnections?: () => Promise<Array<{ url?: string } | null>>;
    };
  };
  /** Host Dataverse API; only ever wrapped by the read-only facade (readOnlyHost.ts). */
  readonly dataverseAPI?: RawDataverseApi;
}

const ENVIRONMENT_TYPES: readonly string[] = ['Dev', 'Test', 'UAT', 'Production'];

/**
 * Reads the active connection from the PPTB host.
 * - host API missing (opened in a plain browser or tests): `demo`
 * - host present but no connection selected: `none`
 * - host call failed: `error` (no connection details, no tokens, ever)
 */
export async function getConnectionState(host: HostWindow | undefined): Promise<ConnectionState> {
  const getActive = host?.toolboxAPI?.connections?.getActiveConnection;
  if (typeof getActive !== 'function') return { kind: 'demo' };
  try {
    const connection = await getActive.call(host?.toolboxAPI?.connections);
    if (!connection || !connection.url) return { kind: 'none' };
    const env = connection.environment;
    return {
      kind: 'host',
      name: connection.name ?? connection.url,
      url: connection.url,
      environmentType: env && ENVIRONMENT_TYPES.includes(env) ? (env as HostEnvironmentType) : null,
    };
  } catch {
    return { kind: 'error', message: 'The active connection could not be read from the host.' };
  }
}
