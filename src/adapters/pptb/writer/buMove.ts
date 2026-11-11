import { normalizeId, refused, type ApprovedPlan, type OperationResult, type PlannedWrite } from '../../../domain/operations';
import type { SecurityDataWriter } from '../../../ports/securityDataWriter';
import type { WriteBoundary } from './boundary';

// Moves ONE user to a Business Unit (issue #273, write part): an Update of `systemuser.businessunitid` alone, built from the confirmed plan
// and sent through the write boundary (confirmation, fresh full identity check, exact allow-listed update). Architecture decision D13:
// the deprecated SetBusinessSystemUser action is not used. It never claims success: a host call that returns yields `notVerified`; the
// executor re-reads the user's Business Unit and roles and plans the role restoration from that re-read.
//
// UNVERIFIED until write-test S3 runs: what the update does to the user's roles (the planner states removal as an expectation with its
// basis), to teams and owned records, and to the manager's direct reports; and how the host's `update` wrapper encodes the lookup bind.

/** The write this module implements; the other methods of the port come from the privilege and assignment writers. */
export type BusinessUnitMoveWriter = Pick<SecurityDataWriter, 'moveUser'>;

export function createBusinessUnitMoveWriter(options: { readonly boundary: WriteBoundary }): BusinessUnitMoveWriter {
  const { boundary } = options;
  return {
    async moveUser(approval: ApprovedPlan, userId: string, targetBusinessUnitId: string): Promise<OperationResult> {
      const u = normalizeId(userId);
      const b = normalizeId(targetBusinessUnitId);
      const write: PlannedWrite | undefined = approval.plan.writes.find((w) => w.key === `moveUser:${u}:${b}`);
      if (!write) return refused('validation', 'This change is not part of the confirmed plan.');
      return boundary.run(approval, write, (calls) => calls.update('systemuser', u, { 'businessunitid@odata.bind': `/businessunits(${b})` }));
    },
  };
}
