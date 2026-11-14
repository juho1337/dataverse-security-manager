import { normalizeId, refused, type ApprovedPlan, type OperationResult, type PlannedWrite } from '../../../domain/operations';
import type { SecurityDataWriter } from '../../../ports/securityDataWriter';
import type { WriteBoundary } from './boundary';

// Moves ONE user to a Business Unit (issue #273, write part): an Update of `systemuser.businessunitid` alone, built from the confirmed plan
// and sent through the write boundary (confirmation, fresh full identity check, exact allow-listed update). Architecture decision D13:
// the deprecated SetBusinessSystemUser action is not used. It never claims success: a host call that returns yields `notVerified`; the
// executor re-reads the user's Business Unit and roles and plans the role restoration from that re-read.
//
// Real-host evidence (S3, 2026-11-03/04, issue #325; docs/testing-evidence.md): the update with the lookup bind is accepted by the host, moves
// between two test Business Units were verified by re-read, Dataverse removed the user's direct roles on the move, and the equivalent roles of the
// target unit (lineage) were assigned again and verified. NOT examined and therefore not claimed: the effect on team memberships, on records the
// user owns, on the manager's direct reports, and on plug-ins or workflows. Restoring a move (moving back) has synthetic tests only.

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
