import type { ApprovedEnvironment } from './config';
import type { ReadOnlyHost } from './readOnlyHost';

// Environment identity guard. Before any Dataverse data is read or written the tool identifies the environment it is attached to and
// fails closed when it cannot: exactly one active connection with a URL, and an organization id read from Dataverse itself.
// Two modes (decision D1, 2026-11-10):
//   - open (default, `expected` is null): any environment is identified from the live connection; the identified environment (its key)
//     is what a write confirmation is bound to, so a plan confirmed for one environment is refused on another;
//   - locked (`expected` given; a build option for the agents' test runs, see config.ts): the connection must match the approved
//     environment on URL, organization id and environment id, exactly as before.

/** What was observed. Values come from the host connection and from Dataverse itself; never tokens. */
export interface HostIdentityInfo {
  /** URL of the connection the host reports as active, if any. */
  readonly activeConnectionUrl: string | null;
  /** Number of configured, non-empty connection slots (the tool needs exactly one candidate). */
  readonly candidateConnectionCount: number;
  /** Organization id read from Dataverse itself; null when it could not be read. */
  readonly organizationId: string | null;
  /** Environment id from Dataverse/host; null when not exposed or unreadable (UNVERIFIED whether it can be read). */
  readonly environmentId: string | null;
}

export type RefusalReason =
  | 'noConnection'
  | 'multipleConnections'
  | 'urlMismatch'
  | 'organizationUnreadable'
  | 'organizationMismatch'
  | 'environmentMismatch';

/** The environment the connection was identified as. `key` is what confirmations are bound to: the environment id, else the organization id. */
export interface VerifiedEnvironment {
  readonly url: string;
  readonly organizationId: string;
  readonly environmentId: string | null;
  readonly key: string;
}

export type IdentityResult =
  | { readonly status: 'verified'; readonly writesAllowed: true; readonly environment: VerifiedEnvironment }
  /** URL and organization id match; the environment id could not be read. Read-only is allowed, writes are not. */
  | { readonly status: 'environmentIdUnverifiable'; readonly writesAllowed: false }
  | {
      readonly status: 'refused';
      readonly reason: RefusalReason;
      readonly writesAllowed: false;
      /** Names expected and reported values; contains no tokens. */
      readonly message: string;
      readonly expected: string;
      readonly reported: string;
    };

export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  try {
    return new URL(trimmed).origin.toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/, '').toLowerCase();
  }
}

export function normalizeGuid(id: string): string {
  return id.trim().replace(/^\{|\}$/g, '').toLowerCase();
}

function refuse(reason: RefusalReason, what: string, expected: string, reported: string): IdentityResult {
  return {
    status: 'refused',
    reason,
    writesAllowed: false,
    expected,
    reported,
    message: `Environment check failed (${what}): expected ${expected}, host reported ${reported}. No data was read.`,
  };
}

export function verifyEnvironment(expected: ApprovedEnvironment | null, info: HostIdentityInfo): IdentityResult {
  if (info.candidateConnectionCount > 1) {
    return refuse('multipleConnections', 'more than one connection', 'exactly one connection', `${info.candidateConnectionCount} connections`);
  }
  if (!info.activeConnectionUrl || info.candidateConnectionCount < 1) {
    return refuse('noConnection', 'no active connection', expected?.url ?? 'one active connection', 'no active connection');
  }
  if (expected === null) {
    // Open mode: the connection is the environment. The organization id must come from Dataverse itself (proof that the URL answers as an
    // organization); the environment id is used when Dataverse reports it, otherwise the organization id identifies the environment.
    if (!info.organizationId) return refuse('organizationUnreadable', 'organization id could not be read from Dataverse', 'a readable organization id', 'unreadable');
    const organizationId = normalizeGuid(info.organizationId);
    const environmentId = info.environmentId ? normalizeGuid(info.environmentId) : null;
    return {
      status: 'verified',
      writesAllowed: true,
      environment: { url: normalizeUrl(info.activeConnectionUrl), organizationId, environmentId, key: environmentId ?? organizationId },
    };
  }
  if (normalizeUrl(info.activeConnectionUrl) !== normalizeUrl(expected.url)) {
    return refuse('urlMismatch', 'organization URL', normalizeUrl(expected.url), normalizeUrl(info.activeConnectionUrl));
  }
  if (!info.organizationId) {
    return refuse('organizationUnreadable', 'organization id could not be read from Dataverse', expected.organizationId, 'unreadable');
  }
  if (normalizeGuid(info.organizationId) !== normalizeGuid(expected.organizationId)) {
    return refuse('organizationMismatch', 'organization id', normalizeGuid(expected.organizationId), normalizeGuid(info.organizationId));
  }
  if (!info.environmentId) return { status: 'environmentIdUnverifiable', writesAllowed: false };
  if (normalizeGuid(info.environmentId) !== normalizeGuid(expected.environmentId)) {
    return refuse('environmentMismatch', 'environment id', normalizeGuid(expected.environmentId), normalizeGuid(info.environmentId));
  }
  return {
    status: 'verified',
    writesAllowed: true,
    environment: {
      url: normalizeUrl(info.activeConnectionUrl),
      organizationId: normalizeGuid(info.organizationId),
      environmentId: normalizeGuid(info.environmentId),
      key: normalizeGuid(info.environmentId),
    },
  };
}

/** The tiny part of window.toolboxAPI.connections used here (structural, so tests can fake it). */
export interface ConnectionsLike {
  readonly getActiveConnection?: () => Promise<{ id?: string; url?: string } | null>;
  readonly getConnections?: () => Promise<Array<{ url?: string } | null>>;
}

/**
 * Cheap fingerprint of the connection a session was verified against: connection id, normalized URL and the number of
 * configured slots; null when it cannot be read. Compared before and after every host request (see reader.ts).
 */
export async function connectionFingerprint(connections: ConnectionsLike | undefined): Promise<string | null> {
  try {
    const active = (await connections?.getActiveConnection?.()) ?? null;
    if (!active?.url) return null;
    const count =
      typeof connections?.getConnections === 'function' ? (await connections.getConnections()).filter((c) => c !== null && c !== undefined).length : 1;
    return `${active.id ?? ''}|${normalizeUrl(active.url)}|${count}`;
  } catch {
    return null;
  }
}

function str(row: Record<string, unknown> | undefined, key: string): string | null {
  const v = row?.[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Collects the identity facts through the read-only host: the organization id from Dataverse's organization row, the environment id from
 * the RetrieveCurrentOrganization read function. UNVERIFIED on the real host: that its execute wrapper runs the function; until it does the
 * environment id stays unverifiable and writes are refused (fail closed).
 */
export async function readConnectionIdentity(connections: ConnectionsLike | undefined): Promise<HostIdentityInfo> {
  const none = { organizationId: null, environmentId: null };
  try {
    const active = (await connections?.getActiveConnection?.()) ?? null;
    let count: number;
    if (typeof connections?.getConnections === 'function') {
      count = (await connections.getConnections()).filter((c) => c !== null && c !== undefined).length;
    } else {
      count = active ? 1 : 0;
    }
    return { activeConnectionUrl: active?.url ?? null, candidateConnectionCount: count, ...none };
  } catch {
    return { activeConnectionUrl: null, candidateConnectionCount: 0, ...none };
  }
}

export async function readOrganizationIdentity(host: ReadOnlyHost): Promise<{ organizationId: string | null; environmentId: string | null }> {
  let organizationId: string | null;
  try {
    organizationId = str((await host.queryData('organizations?$select=organizationid&$top=1')).value[0], 'organizationid');
  } catch {
    return { organizationId: null, environmentId: null };
  }
  // The environment id is not a column of the organizations table; Dataverse reports it in RetrieveCurrentOrganization (Detail.EnvironmentId).
  // If the host cannot run that read function, or the answer has no id, it stays unverifiable and writes remain refused.
  let environmentId: string | null;
  try {
    const detail = (await host.retrieveCurrentOrganization())['Detail'];
    environmentId = str(detail !== null && typeof detail === 'object' ? (detail as Record<string, unknown>) : undefined, 'EnvironmentId');
  } catch {
    environmentId = null;
  }
  return { organizationId, environmentId };
}

/**
 * Connection facts are checked first; Dataverse is only asked for the organization row when the connection already
 * matches (one candidate, approved URL), so a wrong environment is refused before any Dataverse call.
 */
export async function verifyHostEnvironment(
  expected: ApprovedEnvironment | null,
  connections: ConnectionsLike | undefined,
  host: ReadOnlyHost,
): Promise<IdentityResult> {
  const connection = await readConnectionIdentity(connections);
  // Placeholders stand in for the Dataverse facts so only the connection facts can refuse here.
  const early = verifyEnvironment(expected, {
    ...connection,
    organizationId: expected?.organizationId ?? 'precheck',
    environmentId: expected?.environmentId ?? null,
  });
  if (early.status === 'refused') return early;
  return verifyEnvironment(expected, { ...connection, ...(await readOrganizationIdentity(host)) });
}
