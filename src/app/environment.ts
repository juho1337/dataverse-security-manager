import type { HostEnvironmentType } from '../adapters/pptb/connection';
import type { VerifiedEnvironment } from '../adapters/pptb/identity';

// The environment the tool is attached to, identified at run time (decision D1, 2026-11-10): there is no fixed environment any more. A write
// confirmation is bound to `key`; the write boundary identifies the connection again before every write and refuses a different one.

/** Reads the identity of the connected environment; null when it cannot be identified (no connection, several, organization unreadable). */
export type EnvironmentResolver = () => Promise<VerifiedEnvironment | null>;

interface HasIdentity {
  verifyIdentity(): Promise<{ readonly status: string; readonly environment?: VerifiedEnvironment }>;
}

/** A resolver for a reader that can identify its environment (the live PPTB readers); undefined for any other (demo) reader. */
export function createEnvironmentResolver(reader: unknown): EnvironmentResolver | undefined {
  const r = reader as Partial<HasIdentity> | null;
  if (!r || typeof r.verifyIdentity !== 'function') return undefined;
  const identify = r.verifyIdentity.bind(r);
  return async () => {
    try {
      const result = await identify();
      return result.status === 'verified' && result.environment ? result.environment : null;
    } catch {
      return null;
    }
  };
}

/**
 * Changes in an environment typed Production need an explicit acknowledgement first. An environment whose type the host does not report is
 * treated the same way (fail closed). Dev, Test and UAT need none: the preview and the confirmation naming the environment still apply.
 */
export function requiresProductionAcknowledgement(type: HostEnvironmentType | null): boolean {
  return type !== 'Dev' && type !== 'Test' && type !== 'UAT';
}
