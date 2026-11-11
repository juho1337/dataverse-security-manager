import { normalizeId, refused, type ApprovedPlan, type OperationResult, type PlannedWrite } from '../../../domain/operations';
import type { SecurityDataWriter } from '../../../ports/securityDataWriter';
import { USER_ROLE_RELATIONSHIP, type WriteBoundary } from './boundary';

// Direct role assignment and removal for a user (issue #270). The request is built from the confirmed plan only and sent through the write
// boundary (confirmation, fresh full identity check, exact allow-listed call). It never claims success: a host call that returns yields
// `notVerified`; the application re-reads the user's roles to verify.
//
// associate / disassociate through the `systemuserroles_association` relationship are the documented many-to-many calls. UNVERIFIED on the
// real host until write-test S2 runs: the exact relationship name, and the error a duplicate assignment produces (the application plans
// "already assigned" as a skip from a read, so a duplicate association is never sent on purpose).
// Team role assignment is deliberately not part of the five approved write kinds and is not implemented here.

/** The writes this module implements; the other methods of the port come from the privilege and Business Unit move writers. */
export type RoleAssignmentWriter = Pick<SecurityDataWriter, 'assignRole' | 'unassignRole'>;

function planned(approval: ApprovedPlan, key: string): PlannedWrite | null {
  return approval.plan.writes.find((w) => w.key === key) ?? null;
}

export function createRoleAssignmentWriter(options: { readonly boundary: WriteBoundary }): RoleAssignmentWriter {
  const { boundary } = options;
  return {
    async assignRole(approval: ApprovedPlan, userId: string, roleId: string): Promise<OperationResult> {
      const u = normalizeId(userId);
      const r = normalizeId(roleId);
      const write = planned(approval, `assignRole:${u}:${r}`);
      if (!write) return refused('validation', 'This change is not part of the confirmed plan.');
      return boundary.run(approval, write, (calls) => calls.associate('systemuser', u, USER_ROLE_RELATIONSHIP, 'role', r));
    },

    async unassignRole(approval: ApprovedPlan, userId: string, roleId: string): Promise<OperationResult> {
      const u = normalizeId(userId);
      const r = normalizeId(roleId);
      const write = planned(approval, `unassignRole:${u}:${r}`);
      if (!write) return refused('validation', 'This change is not part of the confirmed plan.');
      return boundary.run(approval, write, (calls) => calls.disassociate('systemuser', u, USER_ROLE_RELATIONSHIP, r));
    },
  };
}
