// Optional environment lock (a BUILD option, off in every normal build).
//
// The shipped tool is not tied to one environment: it identifies whichever environment the host connection points at (identity.ts, open
// mode) and binds every write confirmation to it. For a test build that must only ever work against ONE known environment, build with
//   VITE_DSM_LOCK_ENVIRONMENT=1  VITE_DSM_LOCK_URL=...  VITE_DSM_LOCK_ORGANIZATION_ID=...  VITE_DSM_LOCK_ENVIRONMENT_ID=...
// (all four). A lock build with a missing value locks to an environment that cannot match, so it refuses everything (fail closed).

export interface ApprovedEnvironment {
  readonly url: string;
  readonly organizationId: string;
  readonly environmentId: string;
}

/** Example values used by the tests as a lock target; they identify no real environment. */
export const APPROVED_DEVELOPER_ENVIRONMENT: ApprovedEnvironment = Object.freeze({
  url: 'https://org00000000.crm.dynamics.com',
  organizationId: '00000000-0000-4000-8000-000000000001',
  environmentId: '00000000-0000-4000-8000-000000000002',
});

/** The environment every reader and writer is locked to in a lock build, otherwise null (open mode). */
export function lockedEnvironment(): ApprovedEnvironment | null {
  const env = import.meta.env;
  const legacyFlag = (env as unknown as Record<string, string | undefined>).VITE_DSM_LOCK_APPROVED_ENVIRONMENT === '1';
  // The former flag no longer carries the values: a build that sets it without the new variables locks to an environment that cannot match (fail closed).
  if (env.VITE_DSM_LOCK_ENVIRONMENT !== '1' && !legacyFlag) return null;
  const unset = 'lock-variable-missing';
  return Object.freeze({
    url: env.VITE_DSM_LOCK_URL || unset,
    organizationId: env.VITE_DSM_LOCK_ORGANIZATION_ID || unset,
    environmentId: env.VITE_DSM_LOCK_ENVIRONMENT_ID || unset,
  });
}
