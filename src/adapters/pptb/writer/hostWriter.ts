import type { HostWindow } from '../connection';
import { lockedEnvironment, type ApprovedEnvironment } from '../config';
import { connectionFingerprint, verifyHostEnvironment } from '../identity';
import { createReadOnlyHost } from '../readOnlyHost';
import type { SecurityDataWriter } from '../../../ports/securityDataWriter';
import { createRoleAssignmentWriter } from './assignments';
import { createWriteBoundary, type RawWriteApi } from './boundary';
import { createBusinessUnitMoveWriter } from './buMove';
import { createRolePrivilegeWriter } from './rolePrivileges';

// The one place the real PPTB host is turned into a SecurityDataWriter (issue #267, #268, #270, #273): the host's authenticated Dataverse API
// (no parallel authentication) behind the write boundary, with the environment identity verified before EVERY write against the approved
// environment (URL, organization id and environment id; an unreadable environment id refuses the write). Reads stay on the read-only facade.

function str(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * Null when the page is not inside a host that provides the Dataverse API (no writer exists then, so nothing can be written).
 * `expected` omitted: open mode (the connected environment is identified and confirmations are bound to it), or the approved Developer
 * environment in a lock build (config.ts). An explicit environment locks the writer to it; `null` forces open mode.
 */
export function createHostSecurityWriter(host: HostWindow | undefined, expectedEnvironment?: ApprovedEnvironment | null): SecurityDataWriter | null {
  const expected = expectedEnvironment === undefined ? lockedEnvironment() : expectedEnvironment;
  const api = host?.dataverseAPI;
  if (!api) return null;
  const readOnly = createReadOnlyHost(api);
  const connections = host?.toolboxAPI?.connections;
  // The connection the identity was verified against. Dispatch is bound to it: if the active connection changes between the identity check and
  // the host call (for example during the role Business Unit lookup), the change is not sent.
  let verifiedConnection: string | null = null;
  const boundary = createWriteBoundary({
    raw: api as unknown as RawWriteApi,
    verifyIdentity: async () => {
      verifiedConnection = null;
      // The connection is read before AND after the identity check: a switch while the check runs is not a verified connection.
      const before = await connectionFingerprint(connections);
      const result = await verifyHostEnvironment(expected, connections, readOnly);
      if (result.status !== 'verified') return result;
      const after = await connectionFingerprint(connections);
      if (before === null || before !== after) {
        return {
          status: 'refused',
          reason: 'urlMismatch',
          writesAllowed: false,
          expected: expected?.url ?? 'the identified connection',
          reported: 'the connection changed during the check',
          message: 'Environment check failed (the active connection changed while it was being verified). No change was sent.',
        };
      }
      verifiedConnection = after;
      return result;
    },
    beforeDispatch: async () => {
      const now = await connectionFingerprint(connections);
      if (verifiedConnection === null || now === null || now !== verifiedConnection) throw new Error('connection changed');
    },
  });
  const privileges = createRolePrivilegeWriter({
    boundary,
    // The Business Unit the role belongs to (a read). A lookup column must be selected as `_businessunitid_value`: `$select=businessunitid` returns
    // the row WITHOUT the column (verified on the real service 2026-11-03), which made every privilege write refuse itself.
    resolveRoleBusinessUnit: async (roleId) => {
      const row = await readOnly.retrieve('role', roleId, ['_businessunitid_value']);
      return str(row, '_businessunitid_value', 'businessunitid');
    },
  });
  return { ...privileges, ...createRoleAssignmentWriter({ boundary }), ...createBusinessUnitMoveWriter({ boundary }) };
}
